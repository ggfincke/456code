// apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
// loads orchestration projection snapshots

import {
  EventId,
  NonNegativeInt,
  OrchestratePlanRevision,
  OrchestrateRunExecutionIdentity,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadSearchSource,
  ProjectId,
  ThreadId,
  IsoDateTime,
  THREAD_SEARCH_MAX_RESULTS,
  THREAD_SEARCH_SNIPPET_MAX_CHARS,
  type ApprovalOutcome,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from '@t3tools/contracts'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from '../../persistence/Errors.ts'
import * as RepositoryIdentityResolver from '../../project/RepositoryIdentityResolver.ts'
import { projectActivityPayload } from '../ActivityPayloadProjection.ts'
import { COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS } from '../activityPolicy.ts'
import { ORCHESTRATION_PROJECTOR_NAMES } from './ProjectionPipeline.ts'
import {
  CheckpointIdentityLookupInput,
  FullThreadDiffContextLookupInput,
  ProjectionApprovalOutcomeDbRowSchema,
  ProjectionCheckpointDbRowSchema,
  ProjectionCheckpointIdentityDbRowSchema,
  ProjectionCountsRowSchema,
  ProjectionFullThreadDiffContextRowSchema,
  ProjectionImportProjectRowSchema,
  ProjectionImportThreadRowSchema,
  ProjectionOrchestrateExecutionJobDbRowSchema,
  ProjectionOrchestrateRunDbRowSchema,
  ProjectionOrchestrateRunExecutionDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionProjectDbRowSchema,
  ProjectionProjectLookupRowSchema,
  ProjectionStateDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadCheckpointContextThreadRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadIdLookupRowSchema,
  ProjectionThreadImportFinalizedRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadOrchestratePlanDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectIdLookupInput,
  ThreadIdLookupInput,
  WorkspaceRootLookupInput,
  mapApprovalOutcomeRow,
  mapLatestTurn,
  mapOrchestratePlanRow,
  mapOrchestrateRunExecutionRow,
  mapProjectShellRow,
  mapProposedPlanRow,
  mapSessionRow,
  maxIso,
} from './ProjectionSnapshotMappers.ts'
import {
  COMMAND_THREAD_ACTIVITY_QUERY_SQL,
  IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL,
} from './ProjectionSnapshotSql.ts'
export { COMMAND_THREAD_ACTIVITY_QUERY_SQL }
import {
  ProjectionSnapshotQuery,
  type ProjectionCheckpointIdentity,
  type ProjectionEventReplayStats,
  type ProjectionFullThreadDiffContext,
  type ProjectionImportReconciliationContext,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from '../Services/ProjectionSnapshotQuery.ts'

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel)
const ThreadSearchRequest = Schema.Struct({ pattern: Schema.String, limit: Schema.Int })
const ThreadSearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
})

function searchSnippet(text: string, query: string): string
{
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= THREAD_SEARCH_SNIPPET_MAX_CHARS) return compact
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const match = fold(compact).indexOf(fold(query.replace(/\s+/g, ' ').trim()))
  const bodyLength = THREAD_SEARCH_SNIPPET_MAX_CHARS - 2
  const start = Math.min(Math.max(0, match - 72), compact.length - bodyLength)
  const end = start + bodyLength
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`
}
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot)
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread)
const THREAD_DETAIL_ACTIVITY_LIMIT = 500
const THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE = 25
const EventReplayStatsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
  toSequenceInclusive: NonNegativeInt,
})
const EventReplayStatsRowSchema = Schema.Struct({
  eventCount: NonNegativeInt,
  payloadBytes: NonNegativeInt,
})
const ThreadActivityIdsLookupInput = Schema.Struct({
  activityIds: Schema.Array(EventId),
})
const ProjectionThreadActivityIdRowSchema = Schema.Struct({ activityId: EventId })
const THREAD_DETAIL_COMMAND_ACTIVITY_SQL_LIST = COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS.map(
  (kind) => `'${kind}'`,
).join(',\n        ')

// keep the 500-row history window on the purpose-built partial indexes
const THREAD_DETAIL_ACTIVITY_SELECTION_SQL = `
  WITH recent_activity_ids AS (
    SELECT recent.activity_id
    FROM projection_thread_activities AS recent
      INDEXED BY idx_projection_thread_activities_command_window
    WHERE recent.thread_id = ?
      AND (
        json_valid(recent.payload_json) = 0
        OR COALESCE(json_extract(recent.payload_json, '$.type'), '')
          <> ${IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL}
      )
    ORDER BY
      CASE WHEN recent.turn_id IS NULL AND recent.sequence IS NOT NULL THEN 0 ELSE 1 END DESC,
      CASE
        WHEN recent.turn_id IS NULL AND recent.sequence IS NOT NULL THEN recent.sequence
        ELSE NULL
      END DESC,
      recent.created_at DESC,
      CASE WHEN recent.sequence IS NULL THEN 1 ELSE 0 END DESC,
      recent.sequence DESC,
      CASE
        WHEN substr(recent.kind, -8) = '.started' OR recent.kind = 'tool.started' THEN 0
        WHEN substr(recent.kind, -10) = '.completed'
          OR substr(recent.kind, -9) = '.resolved'
          THEN 2
        ELSE 1
      END DESC,
      recent.activity_id DESC
    LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
  ),
  latest_import_marker AS (
    SELECT marker.activity_id
    FROM projection_thread_activities AS marker
      INDEXED BY idx_projection_thread_activities_import_continuation
    WHERE marker.thread_id = ?
      AND json_valid(marker.payload_json) = 1
      AND json_extract(marker.payload_json, '$.type')
        = ${IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL}
    ORDER BY
      CASE WHEN marker.turn_id IS NULL AND marker.sequence IS NOT NULL THEN 0 ELSE 1 END DESC,
      CASE
        WHEN marker.turn_id IS NULL AND marker.sequence IS NOT NULL THEN marker.sequence
        ELSE NULL
      END DESC,
      marker.created_at DESC,
      CASE WHEN marker.sequence IS NULL THEN 1 ELSE 0 END DESC,
      marker.sequence DESC,
      CASE
        WHEN substr(marker.kind, -8) = '.started' OR marker.kind = 'tool.started' THEN 0
        WHEN substr(marker.kind, -10) = '.completed'
          OR substr(marker.kind, -9) = '.resolved'
          THEN 2
        ELSE 1
      END DESC,
      marker.activity_id DESC
    LIMIT 1
  ),
  pending_approval_activities AS (
    SELECT
      activity.activity_id,
      ROW_NUMBER() OVER (
        PARTITION BY pending.request_id
        ORDER BY activity.created_at DESC, activity.activity_id DESC
      ) AS request_order
    FROM projection_pending_approvals AS pending
      INDEXED BY idx_projection_pending_approvals_thread_status
    INNER JOIN projection_thread_activities AS activity
      INDEXED BY idx_projection_thread_activities_command_relevant
      ON activity.thread_id = pending.thread_id
    WHERE pending.thread_id = ?
      AND pending.status = 'pending'
      AND activity.kind IN (
        ${THREAD_DETAIL_COMMAND_ACTIVITY_SQL_LIST}
      )
      AND activity.kind = 'approval.requested'
      AND json_valid(activity.payload_json) = 1
      AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
  ),
  user_input_lifecycle AS (
    SELECT
      activity.activity_id,
      activity.kind,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(activity.payload_json, '$.requestId')
        ORDER BY activity.created_at DESC, activity.activity_id DESC
      ) AS request_order
    FROM projection_threads AS thread
    INNER JOIN projection_thread_activities AS activity
      INDEXED BY idx_projection_thread_activities_command_relevant
      ON activity.thread_id = thread.thread_id
    WHERE thread.thread_id = ?
      AND thread.pending_user_input_count > 0
      AND activity.kind IN (
        ${THREAD_DETAIL_COMMAND_ACTIVITY_SQL_LIST}
      )
      AND json_valid(activity.payload_json) = 1
      AND (
        activity.kind IN ('user-input.requested', 'user-input.resolved')
        OR (
          activity.kind = 'provider.user-input.respond.failed'
          AND (
            lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
              LIKE '%stale pending user-input request%'
            OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
              LIKE '%unknown pending user-input request%'
            OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
              LIKE '%unknown pending user input request%'
            OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
              LIKE '%unknown pending codex user input request%'
          )
        )
      )
      AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
  ),
  selected_activity_ids AS (
    SELECT activity_id FROM recent_activity_ids
    UNION
    SELECT activity_id FROM latest_import_marker
    UNION
    SELECT activity_id
    FROM pending_approval_activities
    WHERE request_order = 1
    UNION
    SELECT activity_id
    FROM user_input_lifecycle
    WHERE request_order = 1
      AND kind = 'user-input.requested'
  )
`

const THREAD_DETAIL_ACTIVITY_FROM_SQL = `
  FROM selected_activity_ids AS selected
  INNER JOIN projection_thread_activities AS activity
    ON activity.activity_id = selected.activity_id
  ORDER BY
    CASE WHEN activity.turn_id IS NULL AND activity.sequence IS NOT NULL THEN 0 ELSE 1 END ASC,
    CASE
      WHEN activity.turn_id IS NULL AND activity.sequence IS NOT NULL THEN activity.sequence
      ELSE NULL
    END ASC,
    activity.created_at ASC,
    CASE WHEN activity.sequence IS NULL THEN 1 ELSE 0 END ASC,
    activity.sequence ASC,
    CASE
      WHEN substr(activity.kind, -8) = '.started' OR activity.kind = 'tool.started' THEN 0
      WHEN substr(activity.kind, -10) = '.completed'
        OR substr(activity.kind, -9) = '.resolved'
        THEN 2
      ELSE 1
    END ASC,
    activity.activity_id ASC
`

const THREAD_DETAIL_ACTIVITY_ID_QUERY_SQL = `
  ${THREAD_DETAIL_ACTIVITY_SELECTION_SQL}
  SELECT activity.activity_id AS "activityId"
  ${THREAD_DETAIL_ACTIVITY_FROM_SQL}
`

export const THREAD_DETAIL_ACTIVITY_QUERY_SQL = `
  ${THREAD_DETAIL_ACTIVITY_SELECTION_SQL}
  SELECT
    activity.activity_id AS "activityId",
    activity.thread_id AS "threadId",
    activity.turn_id AS "turnId",
    activity.tone,
    activity.kind,
    activity.summary,
    activity.payload_json AS "payload",
    activity.sequence,
    activity.created_at AS "createdAt"
  ${THREAD_DETAIL_ACTIVITY_FROM_SQL}
`

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
  ORCHESTRATION_PROJECTOR_NAMES.orchestrateRunExecutions,
] as const

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number
{
  if (stateRows.length === 0)
  {
    return 0
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  )

  let minSequence = Number.POSITIVE_INFINITY
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS)
  {
    const sequence = sequenceByProjector.get(projector)
    if (sequence === undefined)
    {
      return 0
    }
    if (sequence < minSequence)
    {
      minSequence = sequence
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string)
{
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause)
}

function mapThreadActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity
{
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: row.createdAt,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
  }
}

const makeProjectionSnapshotQuery = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const readThreadSearch = SqlSchema.findAll({
    Request: ThreadSearchRequest,
    Result: ThreadSearchRow,
    execute: ({ pattern, limit }) => sql`
      WITH ranked AS (
        SELECT threads.thread_id, threads.project_id, messages.role AS source,
          messages.text AS match_text, messages.created_at AS message_created_at,
          CASE messages.role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
          threads.updated_at AS thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY threads.thread_id
            ORDER BY CASE messages.role WHEN 'user' THEN 0 ELSE 1 END,
              messages.created_at DESC, messages.message_id ASC
          ) AS thread_match_rank
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL AND messages.is_streaming = 0
          AND (messages.role = 'user' OR (
            messages.role = 'assistant' AND EXISTS (
              SELECT 1 FROM projection_turns AS turns
              WHERE turns.thread_id = messages.thread_id
                AND turns.assistant_message_id = messages.message_id
            )
          ))
          AND messages.text LIKE ${pattern} ESCAPE '!'
      )
      SELECT thread_id AS "threadId", project_id AS "projectId", source,
        match_text AS "matchText", message_created_at AS "messageCreatedAt"
      FROM ranked WHERE thread_match_rank = 1
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC LIMIT ${limit}
    `,
  })
  const searchThreads: ProjectionSnapshotQueryShape['searchThreads'] = Effect.fn(
    'ProjectionSnapshotQuery.searchThreads',
  )(function* (input)
  {
    const query = input.query.trim()
    const pattern = `%${query.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`
    const rows = yield* readThreadSearch({
      pattern,
      limit: input.limit ?? THREAD_SEARCH_MAX_RESULTS,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.searchThreads:query',
          'ProjectionSnapshotQuery.searchThreads:decode',
        ),
      ),
    )
    return {
      matches: rows.map(({ matchText, ...row }) => ({
        ...row,
        snippet: searchSnippet(matchText, query),
      })),
    }
  })
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver
  const repositoryIdentityResolutionConcurrency = 4
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    'ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects',
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean
    },
  )
  {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null)
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))]
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    )

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    )
  })

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  })

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          pending_handoff_json AS "pendingHandoff",
          provider_switch_json AS "providerSwitch",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          interaction_orchestrate AS "interactionOrchestrate",
          branch,
          worktree_path AS "worktreePath",
          orchestrate_run_worktree_path AS "orchestrateRunWorktreePath",
          orchestrate_run_branch AS "orchestrateRunBranch",
          origin_json AS "originJson",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          archive_generation AS "archiveGeneration",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  })

  // both queries deliberately ship every outcome status: terminal rows
  // (accepted / stale-terminal) clear optimistic approval cards on snapshot
  // consumers, so filtering them out silently breaks approval resolution.
  // bounding snapshot growth needs a retention policy instead (see the
  // mega-review 2026-08-02 P2 I follow-up)
  const listApprovalOutcomeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionApprovalOutcomeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          outcome_status AS "status",
          outcome_requested_decision AS "requestedDecision",
          outcome_decision AS "decision",
          outcome_detail AS "detail",
          outcome_action_id AS "actionId",
          outcome_acceptance_evidence AS "acceptanceEvidence",
          outcome_updated_at AS "updatedAt",
          created_at AS "createdAt"
        FROM projection_pending_approvals
        ORDER BY thread_id ASC, created_at ASC, request_id ASC
      `,
  })

  const listApprovalOutcomeRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionApprovalOutcomeDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          outcome_status AS "status",
          outcome_requested_decision AS "requestedDecision",
          outcome_decision AS "decision",
          outcome_detail AS "detail",
          outcome_action_id AS "actionId",
          outcome_acceptance_evidence AS "acceptanceEvidence",
          outcome_updated_at AS "updatedAt",
          created_at AS "createdAt"
        FROM projection_pending_approvals
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, request_id ASC
      `,
  })

  const listImportProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionImportProjectRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          workspace_root AS "workspaceRoot"
        FROM projection_projects
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
      `,
  })

  const listImportThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionImportThreadRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          model_selection_json AS "modelSelection",
          origin_json AS "origin",
          CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END AS "archived"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND origin_json IS NOT NULL
        ORDER BY created_at ASC, thread_id ASC
      `,
  })

  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          pending_handoff_json AS "pendingHandoff",
          provider_switch_json AS "providerSwitch",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          interaction_orchestrate AS "interactionOrchestrate",
          branch,
          worktree_path AS "worktreePath",
          orchestrate_run_worktree_path AS "orchestrateRunWorktreePath",
          orchestrate_run_branch AS "orchestrateRunBranch",
          origin_json AS "originJson",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          archive_generation AS "archiveGeneration",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  })

  const listArchivedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          pending_handoff_json AS "pendingHandoff",
          provider_switch_json AS "providerSwitch",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          interaction_orchestrate AS "interactionOrchestrate",
          branch,
          worktree_path AS "worktreePath",
          orchestrate_run_worktree_path AS "orchestrateRunWorktreePath",
          orchestrate_run_branch AS "orchestrateRunBranch",
          origin_json AS "originJson",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          archive_generation AS "archiveGeneration",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  })

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  })

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  })

  const listThreadOrchestratePlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadOrchestratePlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          run_id AS "runId",
          revision,
          turn_id AS "turnId",
          workflow,
          task,
          stages_json AS "stages",
          total_workers AS "totalWorkers",
          max_workers AS "maxWorkers",
          source,
          lead_model_selection_json AS "leadModelSelection",
          status,
          source_sequence AS "sourceSequence",
          architecture_paths_json AS "architecturePaths",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_orchestrate_plans
        ORDER BY thread_id ASC, created_at ASC, run_id ASC, revision ASC
      `,
  })

  const listOrchestrateRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionOrchestrateRunDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          run_id AS "runId",
          current_plan_revision AS "currentPlanRevision",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_orchestrate_runs
        ORDER BY thread_id ASC, created_at ASC, run_id ASC
      `,
  })

  const listOrchestrateRunExecutionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionOrchestrateRunExecutionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          run_id AS "runId",
          plan_revision AS "planRevision",
          source_turn_id AS "sourceTurnId",
          source_sequence AS "sourceSequence",
          repository_root AS "repositoryRoot",
          repository_common_dir AS "repositoryCommonDir",
          base_oid AS "baseOid",
          lifecycle,
          availability,
          integration_root AS "integrationRoot",
          integration_common_dir AS "integrationCommonDir",
          integration_branch AS "integrationBranch",
          integration_oid AS "integrationOid",
          observed_head_oid AS "observedHeadOid",
          final_head_oid AS "finalHeadOid",
          close_reason AS "closeReason",
          is_current AS "current",
          admitted_at AS "admittedAt",
          updated_at AS "updatedAt",
          terminal_at AS "terminalAt"
        FROM projection_orchestrate_run_executions
        ORDER BY thread_id ASC, admitted_at ASC, run_id ASC, plan_revision ASC
      `,
  })

  const listOrchestrateExecutionJobRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionOrchestrateExecutionJobDbRowSchema,
    execute: () =>
      sql`
        SELECT
          job_id AS "jobId",
          thread_id AS "threadId",
          run_id AS "runId",
          plan_revision AS "planRevision",
          status,
          request_run_id AS "requestRunId",
          request_repository_root AS "requestRepositoryRoot",
          result_repository_root AS "resultRepositoryRoot",
          repository_common_dir AS "repositoryCommonDir",
          base_oid AS "baseOid",
          head_oid AS "headOid",
          worktree_root AS "worktreeRoot",
          branch,
          bound_at AS "boundAt"
        FROM projection_orchestrate_execution_jobs
        ORDER BY thread_id ASC, run_id ASC, plan_revision ASC, job_id ASC
      `,
  })

  const getOrchestrateRunExecutionRow = SqlSchema.findOneOption({
    Request: OrchestrateRunExecutionIdentity,
    Result: ProjectionOrchestrateRunExecutionDbRowSchema,
    execute: ({ threadId, runId, planRevision }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          run_id AS "runId",
          plan_revision AS "planRevision",
          source_turn_id AS "sourceTurnId",
          source_sequence AS "sourceSequence",
          repository_root AS "repositoryRoot",
          repository_common_dir AS "repositoryCommonDir",
          base_oid AS "baseOid",
          lifecycle,
          availability,
          integration_root AS "integrationRoot",
          integration_common_dir AS "integrationCommonDir",
          integration_branch AS "integrationBranch",
          integration_oid AS "integrationOid",
          observed_head_oid AS "observedHeadOid",
          final_head_oid AS "finalHeadOid",
          close_reason AS "closeReason",
          is_current AS "current",
          admitted_at AS "admittedAt",
          updated_at AS "updatedAt",
          terminal_at AS "terminalAt"
        FROM projection_orchestrate_run_executions
        WHERE thread_id = ${threadId}
          AND run_id = ${runId}
          AND plan_revision = ${planRevision}
        LIMIT 1
      `,
  })

  const getCurrentOrchestrateRunExecutionRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionOrchestrateRunExecutionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          run_id AS "runId",
          plan_revision AS "planRevision",
          source_turn_id AS "sourceTurnId",
          source_sequence AS "sourceSequence",
          repository_root AS "repositoryRoot",
          repository_common_dir AS "repositoryCommonDir",
          base_oid AS "baseOid",
          lifecycle,
          availability,
          integration_root AS "integrationRoot",
          integration_common_dir AS "integrationCommonDir",
          integration_branch AS "integrationBranch",
          integration_oid AS "integrationOid",
          observed_head_oid AS "observedHeadOid",
          final_head_oid AS "finalHeadOid",
          close_reason AS "closeReason",
          is_current AS "current",
          admitted_at AS "admittedAt",
          updated_at AS "updatedAt",
          terminal_at AS "terminalAt"
        FROM projection_orchestrate_run_executions
        WHERE thread_id = ${threadId}
          AND is_current = 1
        LIMIT 1
      `,
  })

  const listOrchestrateExecutionJobRowsByIdentity = SqlSchema.findAll({
    Request: OrchestrateRunExecutionIdentity,
    Result: ProjectionOrchestrateExecutionJobDbRowSchema,
    execute: ({ threadId, runId, planRevision }) =>
      sql`
        SELECT
          job_id AS "jobId",
          thread_id AS "threadId",
          run_id AS "runId",
          plan_revision AS "planRevision",
          status,
          request_run_id AS "requestRunId",
          request_repository_root AS "requestRepositoryRoot",
          result_repository_root AS "resultRepositoryRoot",
          repository_common_dir AS "repositoryCommonDir",
          base_oid AS "baseOid",
          head_oid AS "headOid",
          worktree_root AS "worktreeRoot",
          branch,
          bound_at AS "boundAt"
        FROM projection_orchestrate_execution_jobs
        WHERE thread_id = ${threadId}
          AND run_id = ${runId}
          AND plan_revision = ${planRevision}
        ORDER BY job_id ASC
      `,
  })

  const executionKey = (input: {
    readonly threadId: string
    readonly runId: string
    readonly planRevision: number
  }): string => JSON.stringify([input.threadId, input.runId, input.planRevision])

  const mapOrchestrateRunExecutions = (
    rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionOrchestrateRunExecutionDbRowSchema>>,
    jobRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionOrchestrateExecutionJobDbRowSchema>>,
  ) =>
  {
    const jobsByExecution = new Map<
      string,
      Array<Schema.Schema.Type<typeof ProjectionOrchestrateExecutionJobDbRowSchema>>
    >()
    for (const job of jobRows)
    {
      const key = executionKey(job)
      const jobs = jobsByExecution.get(key) ?? []
      jobs.push(job)
      jobsByExecution.set(key, jobs)
    }
    return rows.map((row) =>
      mapOrchestrateRunExecutionRow(row, jobsByExecution.get(executionKey(row)) ?? []),
    )
  }

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN 0 ELSE 1 END ASC,
          CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN sequence ELSE NULL END ASC,
          created_at ASC,
          CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
          sequence ASC,
          CASE
            WHEN substr(kind, -8) = '.started' OR kind = 'tool.started' THEN 0
            WHEN substr(kind, -10) = '.completed' OR substr(kind, -9) = '.resolved' THEN 2
            ELSE 1
          END ASC,
          activity_id ASC
      `,
  })

  // preserve the latest import marker plus the live projector's 500 non-marker window
  const listCommandThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () => sql.unsafe(COMMAND_THREAD_ACTIVITY_QUERY_SQL),
  })

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  })

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY sessions.thread_id ASC
      `,
  })

  const listArchivedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  })

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.checkpoint_turn_count AS "checkpointTurnCount",
          turns.checkpoint_ref AS "checkpointRef",
          turns.checkpoint_status AS "status",
          turns.checkpoint_files_json AS "files",
          turns.assistant_message_id AS "assistantMessageId",
          turns.completed_at AS "completedAt",
          COALESCE(
            identities.checkpoint_capture_root,
            turns.checkpoint_capture_root
          ) AS "checkpointCaptureRoot",
          COALESCE(
            identities.checkpoint_repository_common_dir,
            turns.checkpoint_repository_common_dir
          ) AS "checkpointRepositoryCommonDir",
          COALESCE(
            identities.checkpoint_commit_oid,
            turns.checkpoint_commit_oid
          ) AS "checkpointCommitOid"
        FROM projection_turns AS turns
        LEFT JOIN projection_checkpoint_identities AS identities
          ON identities.thread_id = turns.thread_id
          AND identities.checkpoint_turn_count = turns.checkpoint_turn_count
        WHERE turns.checkpoint_turn_count IS NOT NULL
        ORDER BY turns.thread_id ASC, turns.checkpoint_turn_count ASC
      `,
  })

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  })

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  })

  const listArchivedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  })

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  })

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  })

  const readEventReplayStats = SqlSchema.findOne({
    Request: EventReplayStatsInput,
    Result: EventReplayStatsRowSchema,
    execute: ({ fromSequenceExclusive, toSequenceInclusive }) =>
      sql`
        SELECT
          COUNT(*) AS "eventCount",
          COALESCE(SUM(octet_length(payload_json)), 0) AS "payloadBytes"
        FROM orchestration_events
        WHERE sequence > ${fromSequenceExclusive}
          AND sequence <= ${toSequenceInclusive}
      `,
  })

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  })

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  })

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  })

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  })

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          pending_handoff_json AS "pendingHandoff",
          provider_switch_json AS "providerSwitch",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          interaction_orchestrate AS "interactionOrchestrate",
          branch,
          worktree_path AS "worktreePath",
          orchestrate_run_worktree_path AS "orchestrateRunWorktreePath",
          orchestrate_run_branch AS "orchestrateRunBranch",
          origin_json AS "originJson",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          archive_generation AS "archiveGeneration",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  })

  const getThreadImportFinalizedRow = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadImportFinalizedRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM projection_threads AS thread
          WHERE thread.thread_id = ${threadId}
            AND thread.deleted_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM projection_thread_activities AS activity
                INDEXED BY idx_projection_thread_activities_import_continuation
              WHERE activity.thread_id = thread.thread_id
                AND json_valid(activity.payload_json) = 1
                AND json_extract(activity.payload_json, '$.type')
                  = ${sql.literal(IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL)}
              LIMIT 1
            )
        ) AS "isFinalized"
      `,
  })

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  })

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  })

  const listThreadOrchestratePlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadOrchestratePlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          run_id AS "runId",
          revision,
          turn_id AS "turnId",
          workflow,
          task,
          stages_json AS "stages",
          total_workers AS "totalWorkers",
          max_workers AS "maxWorkers",
          source,
          lead_model_selection_json AS "leadModelSelection",
          status,
          source_sequence AS "sourceSequence",
          architecture_paths_json AS "architecturePaths",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_orchestrate_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, run_id ASC, revision ASC
      `,
  })

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql.unsafe(THREAD_DETAIL_ACTIVITY_QUERY_SQL, [threadId, threadId, threadId, threadId]),
  })
  const listThreadActivityIdRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId }) =>
      sql.unsafe(THREAD_DETAIL_ACTIVITY_ID_QUERY_SQL, [threadId, threadId, threadId, threadId]),
  })
  const listThreadActivityRowsByIds = SqlSchema.findAll({
    Request: ThreadActivityIdsLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ activityIds }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE ${sql.in('activity_id', activityIds)}
      `,
  })
  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  })

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  })

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.checkpoint_turn_count AS "checkpointTurnCount",
          turns.checkpoint_ref AS "checkpointRef",
          turns.checkpoint_status AS "status",
          turns.checkpoint_files_json AS "files",
          turns.assistant_message_id AS "assistantMessageId",
          turns.completed_at AS "completedAt",
          COALESCE(
            identities.checkpoint_capture_root,
            turns.checkpoint_capture_root
          ) AS "checkpointCaptureRoot",
          COALESCE(
            identities.checkpoint_repository_common_dir,
            turns.checkpoint_repository_common_dir
          ) AS "checkpointRepositoryCommonDir",
          COALESCE(
            identities.checkpoint_commit_oid,
            turns.checkpoint_commit_oid
          ) AS "checkpointCommitOid"
        FROM projection_turns AS turns
        LEFT JOIN projection_checkpoint_identities AS identities
          ON identities.thread_id = turns.thread_id
          AND identities.checkpoint_turn_count = turns.checkpoint_turn_count
        WHERE turns.thread_id = ${threadId}
          AND turns.checkpoint_turn_count IS NOT NULL
        ORDER BY turns.checkpoint_turn_count ASC
      `,
  })

  const getCheckpointIdentityRow = SqlSchema.findOneOption({
    Request: CheckpointIdentityLookupInput,
    Result: ProjectionCheckpointIdentityDbRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          ${threadId} AS "threadId",
          ${checkpointTurnCount} AS "checkpointTurnCount",
          COALESCE(identities.checkpoint_ref, turns.checkpoint_ref) AS "checkpointRef",
          COALESCE(
            identities.checkpoint_capture_root,
            turns.checkpoint_capture_root
          ) AS "checkpointCaptureRoot",
          COALESCE(
            identities.checkpoint_repository_common_dir,
            turns.checkpoint_repository_common_dir
          ) AS "checkpointRepositoryCommonDir",
          COALESCE(
            identities.checkpoint_commit_oid,
            turns.checkpoint_commit_oid
          ) AS "checkpointCommitOid"
        FROM (SELECT 1) AS seed
        LEFT JOIN projection_checkpoint_identities AS identities
          ON identities.thread_id = ${threadId}
          AND identities.checkpoint_turn_count = ${checkpointTurnCount}
        LEFT JOIN projection_turns AS turns
          ON turns.thread_id = ${threadId}
          AND turns.checkpoint_turn_count = ${checkpointTurnCount}
        WHERE COALESCE(identities.checkpoint_ref, turns.checkpoint_ref) IS NOT NULL
        LIMIT 1
      `,
  })

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  })

  const getSnapshot: ProjectionSnapshotQueryShape['getSnapshot'] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listProjects:query',
                'ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows',
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listThreads:query',
                'ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows',
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query',
                'ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows',
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query',
                'ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows',
              ),
            ),
          ),
          listThreadOrchestratePlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listThreadOrchestratePlans:query',
                'ProjectionSnapshotQuery.getSnapshot:listThreadOrchestratePlans:decodeRows',
              ),
            ),
          ),
          listOrchestrateRunRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listOrchestrateRuns:query',
                'ProjectionSnapshotQuery.getSnapshot:listOrchestrateRuns:decodeRows',
              ),
            ),
          ),
          listOrchestrateRunExecutionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listRunExecutions:query',
                'ProjectionSnapshotQuery.getSnapshot:listRunExecutions:decodeRows',
              ),
            ),
          ),
          listOrchestrateExecutionJobRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listExecutionJobs:query',
                'ProjectionSnapshotQuery.getSnapshot:listExecutionJobs:decodeRows',
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query',
                'ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows',
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query',
                'ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows',
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query',
                'ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows',
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query',
                'ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows',
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listProjectionState:query',
                'ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows',
              ),
            ),
          ),
          listApprovalOutcomeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getSnapshot:listApprovalOutcomes:query',
                'ProjectionSnapshotQuery.getSnapshot:listApprovalOutcomes:decodeRows',
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            orchestratePlanRows,
            orchestrateRunRows,
            orchestrateRunExecutionRows,
            orchestrateExecutionJobRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
            approvalOutcomeRows,
          ]) =>
            Effect.gen(function* ()
            {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>()
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>()
              const orchestratePlansByThread = new Map<string, Array<OrchestratePlanRevision>>()
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>()
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>()
              const sessionsByThread = new Map<string, OrchestrationSession>()
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>()
              const approvalOutcomesByThread = new Map<string, Array<ApprovalOutcome>>()
              const orchestrateRunExecutions = mapOrchestrateRunExecutions(
                orchestrateRunExecutionRows,
                orchestrateExecutionJobRows,
              )
              const currentExecutionByThread = new Map(
                orchestrateRunExecutions
                  .filter((execution) => execution.current)
                  .map((execution) => [execution.threadId, execution] as const),
              )

              let updatedAt: string | null = null

              for (const row of projectRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of threadRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of stateRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const execution of orchestrateRunExecutions)
              {
                updatedAt = maxIso(updatedAt, execution.updatedAt)
              }

              for (const row of messageRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
                const threadMessages = messagesByThread.get(row.threadId) ?? []
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                })
                messagesByThread.set(row.threadId, threadMessages)
              }

              for (const row of proposedPlanRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? []
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                })
                proposedPlansByThread.set(row.threadId, threadProposedPlans)
              }

              for (const row of orchestratePlanRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
                const threadOrchestratePlans = orchestratePlansByThread.get(row.threadId) ?? []
                threadOrchestratePlans.push(mapOrchestratePlanRow(row))
                orchestratePlansByThread.set(row.threadId, threadOrchestratePlans)
              }

              for (const row of activityRows)
              {
                updatedAt = maxIso(updatedAt, row.createdAt)
                const threadActivities = activitiesByThread.get(row.threadId) ?? []
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                })
                activitiesByThread.set(row.threadId, threadActivities)
              }

              for (const row of checkpointRows)
              {
                updatedAt = maxIso(updatedAt, row.completedAt)
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? []
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                  ...(row.checkpointCaptureRoot === null
                    ? {}
                    : { checkpointCaptureRoot: row.checkpointCaptureRoot }),
                  ...(row.checkpointRepositoryCommonDir === null
                    ? {}
                    : { checkpointRepositoryCommonDir: row.checkpointRepositoryCommonDir }),
                  ...(row.checkpointCommitOid === null
                    ? {}
                    : { checkpointCommitOid: row.checkpointCommitOid }),
                })
                checkpointsByThread.set(row.threadId, threadCheckpoints)
              }

              for (const row of latestTurnRows)
              {
                updatedAt = maxIso(updatedAt, row.requestedAt)
                if (row.startedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.startedAt)
                }
                if (row.completedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.completedAt)
                }
                if (latestTurnByThread.has(row.threadId))
                {
                  continue
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === 'error'
                      ? 'error'
                      : row.state === 'interrupted'
                        ? 'interrupted'
                        : row.state === 'completed'
                          ? 'completed'
                          : 'running',
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                })
              }

              for (const row of sessionRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                })
              }

              for (const row of approvalOutcomeRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt ?? row.createdAt)
                const outcomes = approvalOutcomesByThread.get(row.threadId) ?? []
                outcomes.push(mapApprovalOutcomeRow(row))
                approvalOutcomesByThread.set(row.threadId, outcomes)
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              )

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }))

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                modelSelection: row.modelSelection,
                pendingHandoff: row.pendingHandoff,
                providerSwitch: row.providerSwitch,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                ...(row.interactionOrchestrate === 1 ? { orchestrate: true } : {}),
                branch: row.branch,
                worktreePath: row.worktreePath,
                ...(row.orchestrateRunWorktreePath === null
                  ? {}
                  : { orchestrateRunWorktreePath: row.orchestrateRunWorktreePath }),
                ...(row.orchestrateRunBranch === null
                  ? {}
                  : { orchestrateRunBranch: row.orchestrateRunBranch }),
                orchestrateRunExecution: currentExecutionByThread.get(row.threadId) ?? null,
                origin: row.originJson,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                archiveGeneration: row.archiveGeneration,
                settledOverride: row.settledOverride,
                settledAt: row.settledAt,
                unsettledAt: row.unsettledAt,
                snoozedUntil: row.snoozedUntil,
                snoozedAt: row.snoozedAt,
                pinnedAt: row.pinnedAt,
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                orchestratePlans: orchestratePlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
                approvalOutcomes: approvalOutcomesByThread.get(row.threadId) ?? [],
              }))

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                orchestrateRuns: orchestrateRunRows,
                orchestrateRunExecutions,
                updatedAt: updatedAt ?? '1970-01-01T00:00:00.000Z',
              }

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError('ProjectionSnapshotQuery.getSnapshot:decodeReadModel'),
                ),
              )
            }),
        ),
        Effect.mapError((error) =>
        {
          if (isPersistenceError(error))
          {
            return error
          }
          return toPersistenceSqlError('ProjectionSnapshotQuery.getSnapshot:query')(error)
        }),
      )

  const getCommandReadModel: ProjectionSnapshotQueryShape['getCommandReadModel'] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listProjects:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows',
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listThreads:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows',
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows',
              ),
            ),
          ),
          listThreadOrchestratePlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listThreadOrchestratePlans:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listThreadOrchestratePlans:decodeRows',
              ),
            ),
          ),
          listOrchestrateRunRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listOrchestrateRuns:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listOrchestrateRuns:decodeRows',
              ),
            ),
          ),
          listOrchestrateRunExecutionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listRunExecutions:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listRunExecutions:decodeRows',
              ),
            ),
          ),
          listOrchestrateExecutionJobRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listExecutionJobs:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listExecutionJobs:decodeRows',
              ),
            ),
          ),
          listCommandThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listCommandThreadActivities:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listCommandThreadActivities:decodeRows',
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows',
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows',
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows',
              ),
            ),
          ),
          listApprovalOutcomeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getCommandReadModel:listApprovalOutcomes:query',
                'ProjectionSnapshotQuery.getCommandReadModel:listApprovalOutcomes:decodeRows',
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            proposedPlanRows,
            orchestratePlanRows,
            orchestrateRunRows,
            orchestrateRunExecutionRows,
            orchestrateExecutionJobRows,
            commandThreadActivityRows,
            sessionRows,
            latestTurnRows,
            stateRows,
            approvalOutcomeRows,
          ]) =>
            Effect.sync(() =>
            {
              let updatedAt: string | null = null
              const projects: OrchestrationProject[] = []
              const threads: OrchestrationThread[] = []
              const orchestrateRunExecutions = mapOrchestrateRunExecutions(
                orchestrateRunExecutionRows,
                orchestrateExecutionJobRows,
              )
              const currentExecutionByThread = new Map(
                orchestrateRunExecutions
                  .filter((execution) => execution.current)
                  .map((execution) => [execution.threadId, execution] as const),
              )

              for (let index = 0; index < projectRows.length; index += 1)
              {
                const row = projectRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.updatedAt)
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  defaultModelSelection: row.defaultModelSelection,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                })
              }
              for (let index = 0; index < threadRows.length; index += 1)
              {
                const row = threadRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1)
              {
                const row = proposedPlanRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (let index = 0; index < orchestratePlanRows.length; index += 1)
              {
                const row = orchestratePlanRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (let index = 0; index < commandThreadActivityRows.length; index += 1)
              {
                const row = commandThreadActivityRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.createdAt)
              }
              for (let index = 0; index < sessionRows.length; index += 1)
              {
                const row = sessionRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (let index = 0; index < latestTurnRows.length; index += 1)
              {
                const row = latestTurnRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.requestedAt)
                if (row.startedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.startedAt)
                }
                if (row.completedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.completedAt)
                }
              }
              for (let index = 0; index < stateRows.length; index += 1)
              {
                const row = stateRows[index]
                if (!row)
                {
                  continue
                }
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const execution of orchestrateRunExecutions)
              {
                updatedAt = maxIso(updatedAt, execution.updatedAt)
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>()
              for (let index = 0; index < latestTurnRows.length; index += 1)
              {
                const row = latestTurnRows[index]
                if (!row)
                {
                  continue
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row))
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>()
              const orchestratePlansByThread = new Map<string, Array<OrchestratePlanRevision>>()
              const commandActivitiesByThread = new Map<
                string,
                Array<OrchestrationThreadActivity>
              >()
              const sessionByThread = new Map<string, OrchestrationSession>()
              const approvalOutcomesByThread = new Map<string, Array<ApprovalOutcome>>()

              for (let index = 0; index < sessionRows.length; index += 1)
              {
                const row = sessionRows[index]
                if (!row)
                {
                  continue
                }
                sessionByThread.set(row.threadId, mapSessionRow(row))
              }

              for (const row of approvalOutcomeRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt ?? row.createdAt)
                const outcomes = approvalOutcomesByThread.get(row.threadId) ?? []
                outcomes.push(mapApprovalOutcomeRow(row))
                approvalOutcomesByThread.set(row.threadId, outcomes)
              }

              for (let index = 0; index < orchestratePlanRows.length; index += 1)
              {
                const row = orchestratePlanRows[index]
                if (!row)
                {
                  continue
                }
                const threadOrchestratePlans = orchestratePlansByThread.get(row.threadId) ?? []
                threadOrchestratePlans.push(mapOrchestratePlanRow(row))
                orchestratePlansByThread.set(row.threadId, threadOrchestratePlans)
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1)
              {
                const row = proposedPlanRows[index]
                if (!row)
                {
                  continue
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? []
                threadProposedPlans.push(mapProposedPlanRow(row))
                proposedPlansByThread.set(row.threadId, threadProposedPlans)
              }
              for (let index = 0; index < commandThreadActivityRows.length; index += 1)
              {
                const row = commandThreadActivityRows[index]
                if (!row)
                {
                  continue
                }
                const threadActivities = commandActivitiesByThread.get(row.threadId) ?? []
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                })
                commandActivitiesByThread.set(row.threadId, threadActivities)
              }

              for (let index = 0; index < threadRows.length; index += 1)
              {
                const row = threadRows[index]
                if (!row)
                {
                  continue
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  pendingHandoff: row.pendingHandoff,
                  providerSwitch: row.providerSwitch,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  ...(row.interactionOrchestrate === 1 ? { orchestrate: true } : {}),
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  ...(row.orchestrateRunWorktreePath === null
                    ? {}
                    : { orchestrateRunWorktreePath: row.orchestrateRunWorktreePath }),
                  ...(row.orchestrateRunBranch === null
                    ? {}
                    : { orchestrateRunBranch: row.orchestrateRunBranch }),
                  orchestrateRunExecution: currentExecutionByThread.get(row.threadId) ?? null,
                  origin: row.originJson,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  archiveGeneration: row.archiveGeneration,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  pinnedAt: row.pinnedAt,
                  deletedAt: row.deletedAt,
                  messages: [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  orchestratePlans: orchestratePlansByThread.get(row.threadId) ?? [],
                  activities: commandActivitiesByThread.get(row.threadId) ?? [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                  approvalOutcomes: approvalOutcomesByThread.get(row.threadId) ?? [],
                })
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                orchestrateRuns: orchestrateRunRows,
                orchestrateRunExecutions,
                updatedAt: updatedAt ?? '1970-01-01T00:00:00.000Z',
              } satisfies OrchestrationReadModel
            }),
        ),
        Effect.mapError((error) =>
        {
          if (isPersistenceError(error))
          {
            return error
          }
          return toPersistenceSqlError('ProjectionSnapshotQuery.getCommandReadModel:query')(error)
        }),
      )

  const getShellSnapshot: ProjectionSnapshotQueryShape['getShellSnapshot'] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listProjects:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows',
              ),
            ),
          ),
          listActiveThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listThreads:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows',
              ),
            ),
          ),
          listOrchestrateRunExecutionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listRunExecutions:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listRunExecutions:decodeRows',
              ),
            ),
          ),
          listOrchestrateExecutionJobRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listExecutionJobs:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listExecutionJobs:decodeRows',
              ),
            ),
          ),
          listActiveThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows',
              ),
            ),
          ),
          listActiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows',
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows',
              ),
            ),
          ),
          listApprovalOutcomeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getShellSnapshot:listApprovalOutcomes:query',
                'ProjectionSnapshotQuery.getShellSnapshot:listApprovalOutcomes:decodeRows',
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            orchestrateRunExecutionRows,
            orchestrateExecutionJobRows,
            sessionRows,
            latestTurnRows,
            stateRows,
            approvalOutcomeRows,
          ]) =>
            Effect.gen(function* ()
            {
              let updatedAt: string | null = null
              const currentExecutionByThread = new Map(
                mapOrchestrateRunExecutions(
                  orchestrateRunExecutionRows,
                  orchestrateExecutionJobRows,
                )
                  .filter((execution) => execution.current)
                  .map((execution) => [execution.threadId, execution] as const),
              )
              for (const row of projectRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of threadRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of sessionRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of latestTurnRows)
              {
                updatedAt = maxIso(updatedAt, row.requestedAt)
                if (row.startedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.startedAt)
                }
                if (row.completedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.completedAt)
                }
              }
              for (const row of stateRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }

              const repositoryIdentities =
                yield* resolveRepositoryIdentitiesForProjects(projectRows)
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              )
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              )
              const approvalOutcomesByThread = new Map<string, Array<ApprovalOutcome>>()
              for (const row of approvalOutcomeRows)
              {
                const outcomes = approvalOutcomesByThread.get(row.threadId) ?? []
                outcomes.push(mapApprovalOutcomeRow(row))
                approvalOutcomesByThread.set(row.threadId, outcomes)
              }

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                threads: Arr.filterMap(threadRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed({
                        id: row.threadId,
                        projectId: row.projectId,
                        title: row.title,
                        modelSelection: row.modelSelection,
                        providerSwitch: row.providerSwitch,
                        runtimeMode: row.runtimeMode,
                        interactionMode: row.interactionMode,
                        ...(row.interactionOrchestrate === 1 ? { orchestrate: true } : {}),
                        branch: row.branch,
                        worktreePath: row.worktreePath,
                        ...(row.orchestrateRunWorktreePath === null
                          ? {}
                          : { orchestrateRunWorktreePath: row.orchestrateRunWorktreePath }),
                        ...(row.orchestrateRunBranch === null
                          ? {}
                          : { orchestrateRunBranch: row.orchestrateRunBranch }),
                        orchestrateRunExecution: currentExecutionByThread.get(row.threadId) ?? null,
                        origin: row.originJson,
                        latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        archivedAt: row.archivedAt,
                        settledOverride: row.settledOverride,
                        settledAt: row.settledAt,
                        unsettledAt: row.unsettledAt,
                        snoozedUntil: row.snoozedUntil,
                        snoozedAt: row.snoozedAt,
                        pinnedAt: row.pinnedAt,
                        session: sessionByThread.get(row.threadId) ?? null,
                        latestUserMessageAt: row.latestUserMessageAt,
                        hasPendingApprovals: row.pendingApprovalCount > 0,
                        hasPendingUserInput: row.pendingUserInputCount > 0,
                        hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                        approvalOutcomes: approvalOutcomesByThread.get(row.threadId) ?? [],
                      } satisfies OrchestrationThreadShell)
                    : Result.failVoid,
                ),
                updatedAt: updatedAt ?? '1970-01-01T00:00:00.000Z',
              }

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    'ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot',
                  ),
                ),
              )
            }),
        ),
        Effect.mapError((error) =>
        {
          if (isPersistenceError(error))
          {
            return error
          }
          return toPersistenceSqlError('ProjectionSnapshotQuery.getShellSnapshot:query')(error)
        }),
      )

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape['getArchivedShellSnapshot'] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows',
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows',
              ),
            ),
          ),
          listOrchestrateRunExecutionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listRunExecutions:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listRunExecutions:decodeRows',
              ),
            ),
          ),
          listOrchestrateExecutionJobRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listExecutionJobs:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listExecutionJobs:decodeRows',
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows',
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows',
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows',
              ),
            ),
          ),
          listApprovalOutcomeRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listApprovalOutcomes:query',
                'ProjectionSnapshotQuery.getArchivedShellSnapshot:listApprovalOutcomes:decodeRows',
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            orchestrateRunExecutionRows,
            orchestrateExecutionJobRows,
            sessionRows,
            latestTurnRows,
            stateRows,
            approvalOutcomeRows,
          ]) =>
            Effect.gen(function* ()
            {
              let updatedAt: string | null = null
              const currentExecutionByThread = new Map(
                mapOrchestrateRunExecutions(
                  orchestrateRunExecutionRows,
                  orchestrateExecutionJobRows,
                )
                  .filter((execution) => execution.current)
                  .map((execution) => [execution.threadId, execution] as const),
              )
              for (const row of projectRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of threadRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of sessionRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }
              for (const row of latestTurnRows)
              {
                updatedAt = maxIso(updatedAt, row.requestedAt)
                if (row.startedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.startedAt)
                }
                if (row.completedAt !== null)
                {
                  updatedAt = maxIso(updatedAt, row.completedAt)
                }
              }
              for (const row of stateRows)
              {
                updatedAt = maxIso(updatedAt, row.updatedAt)
              }

              const activeProjectIds = new Set(threadRows.map((row) => row.projectId))
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => activeProjectIds.has(row.projectId)),
              )
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              )
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              )
              const approvalOutcomesByThread = new Map<string, Array<ApprovalOutcome>>()
              for (const row of approvalOutcomeRows)
              {
                const outcomes = approvalOutcomesByThread.get(row.threadId) ?? []
                outcomes.push(mapApprovalOutcomeRow(row))
                approvalOutcomesByThread.set(row.threadId, outcomes)
              }

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null && activeProjectIds.has(row.projectId)
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                threads: threadRows.map((row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  providerSwitch: row.providerSwitch,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  ...(row.interactionOrchestrate === 1 ? { orchestrate: true } : {}),
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  ...(row.orchestrateRunWorktreePath === null
                    ? {}
                    : { orchestrateRunWorktreePath: row.orchestrateRunWorktreePath }),
                  ...(row.orchestrateRunBranch === null
                    ? {}
                    : { orchestrateRunBranch: row.orchestrateRunBranch }),
                  orchestrateRunExecution: currentExecutionByThread.get(row.threadId) ?? null,
                  origin: row.originJson,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  unsettledAt: row.unsettledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  pinnedAt: row.pinnedAt,
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                  approvalOutcomes: approvalOutcomesByThread.get(row.threadId) ?? [],
                })),
                updatedAt: updatedAt ?? '1970-01-01T00:00:00.000Z',
              }

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    'ProjectionSnapshotQuery.getArchivedShellSnapshot:decodeShellSnapshot',
                  ),
                ),
              )
            }),
        ),
        Effect.mapError((error) =>
        {
          if (isPersistenceError(error))
          {
            return error
          }
          return toPersistenceSqlError('ProjectionSnapshotQuery.getArchivedShellSnapshot:query')(
            error,
          )
        }),
      )

  const getSnapshotSequence: ProjectionSnapshotQueryShape['getSnapshotSequence'] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.getSnapshotSequence:query',
          'ProjectionSnapshotQuery.getSnapshotSequence:decodeRows',
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    )

  const getCounts: ProjectionSnapshotQueryShape['getCounts'] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.getCounts:query',
          'ProjectionSnapshotQuery.getCounts:decodeRow',
        ),
      ),
      Effect.map((row): ProjectionSnapshotCounts => ({
        projectCount: row.projectCount,
        threadCount: row.threadCount,
      })),
    )

  const getEventReplayStats: ProjectionSnapshotQueryShape['getEventReplayStats'] = (input) =>
    readEventReplayStats(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.getEventReplayStats:query',
          'ProjectionSnapshotQuery.getEventReplayStats:decodeRow',
        ),
      ),
      Effect.map((row): ProjectionEventReplayStats => ({
        eventCount: row.eventCount,
        payloadBytes: row.payloadBytes,
      })),
    )

  const getImportReconciliationContext: ProjectionSnapshotQueryShape['getImportReconciliationContext'] =
    () =>
      sql
        .withTransaction(
          Effect.all([
            listImportProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  'ProjectionSnapshotQuery.getImportReconciliationContext:listProjects:query',
                  'ProjectionSnapshotQuery.getImportReconciliationContext:listProjects:decodeRows',
                ),
              ),
            ),
            listImportThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  'ProjectionSnapshotQuery.getImportReconciliationContext:listThreads:query',
                  'ProjectionSnapshotQuery.getImportReconciliationContext:listThreads:decodeRows',
                ),
              ),
            ),
          ]),
        )
        .pipe(
          Effect.map(([projects, threads]): ProjectionImportReconciliationContext => ({
            projects,
            threads: threads.map((thread) => ({
              threadId: thread.threadId,
              projectId: thread.projectId,
              modelSelection: thread.modelSelection,
              origin: thread.origin,
              archived: thread.archived === 1,
            })),
          })),
          Effect.mapError((error) =>
            isPersistenceError(error)
              ? error
              : toPersistenceSqlError(
                  'ProjectionSnapshotQuery.getImportReconciliationContext:transaction',
                )(error),
          ),
        )

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape['getActiveProjectByWorkspaceRoot'] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query',
            'ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow',
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      )

  const getProjectShellById: ProjectionSnapshotQueryShape['getProjectShellById'] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.getProjectShellById:query',
          'ProjectionSnapshotQuery.getProjectShellById:decodeRow',
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    )

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape['getFirstActiveThreadIdByProjectId'] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query',
            'ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow',
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      )

  const getCheckpointIdentity: ProjectionSnapshotQueryShape['getCheckpointIdentity'] = (
    threadId,
    checkpointTurnCount,
  ) =>
    getCheckpointIdentityRow({ threadId, checkpointTurnCount }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.getCheckpointIdentity:query',
          'ProjectionSnapshotQuery.getCheckpointIdentity:decodeRow',
        ),
      ),
      Effect.map(
        Option.map((row): ProjectionCheckpointIdentity => ({
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          checkpointCaptureRoot: row.checkpointCaptureRoot,
          checkpointRepositoryCommonDir: row.checkpointRepositoryCommonDir,
          checkpointCommitOid: row.checkpointCommitOid,
        })),
      ),
    )

  const getOrchestrateRunExecution: ProjectionSnapshotQueryShape['getOrchestrateRunExecution'] = (
    identity,
  ) =>
    Effect.gen(function* ()
    {
      const row = yield* getOrchestrateRunExecutionRow(identity).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getOrchestrateRunExecution:query',
            'ProjectionSnapshotQuery.getOrchestrateRunExecution:decodeRow',
          ),
        ),
      )
      if (Option.isNone(row))
      {
        return Option.none()
      }
      const jobs = yield* listOrchestrateExecutionJobRowsByIdentity(identity).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getOrchestrateRunExecution:listJobs:query',
            'ProjectionSnapshotQuery.getOrchestrateRunExecution:listJobs:decodeRows',
          ),
        ),
      )
      return Option.some(mapOrchestrateRunExecutionRow(row.value, jobs))
    })

  const getCurrentOrchestrateRunExecution: ProjectionSnapshotQueryShape['getCurrentOrchestrateRunExecution'] =
    (threadId) =>
      Effect.gen(function* ()
      {
        const row = yield* getCurrentOrchestrateRunExecutionRow({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getCurrentOrchestrateRunExecution:query',
              'ProjectionSnapshotQuery.getCurrentOrchestrateRunExecution:decodeRow',
            ),
          ),
        )
        if (Option.isNone(row))
        {
          return Option.none()
        }
        const identity = {
          threadId: row.value.threadId,
          runId: row.value.runId,
          planRevision: row.value.planRevision,
        }
        const jobs = yield* listOrchestrateExecutionJobRowsByIdentity(identity).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getCurrentOrchestrateRunExecution:listJobs:query',
              'ProjectionSnapshotQuery.getCurrentOrchestrateRunExecution:listJobs:decodeRows',
            ),
          ),
        )
        return Option.some(mapOrchestrateRunExecutionRow(row.value, jobs))
      })

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape['getThreadCheckpointContext'] = (
    threadId,
  ) =>
    Effect.gen(function* ()
    {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query',
            'ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow',
          ),
        ),
      )
      if (Option.isNone(threadRow))
      {
        return Option.none<ProjectionThreadCheckpointContext>()
      }

      const checkpointRows = yield* listCheckpointRowsByThread({
        threadId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query',
            'ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows',
          ),
        ),
      )
      const baselineCheckpointIdentity = yield* getCheckpointIdentity(threadId, 0)

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        ...(Option.isNone(baselineCheckpointIdentity)
          ? {}
          : { baselineCheckpointIdentity: baselineCheckpointIdentity.value }),
        checkpoints: checkpointRows.map((row): OrchestrationCheckpointSummary => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
          ...(row.checkpointCaptureRoot === null
            ? {}
            : { checkpointCaptureRoot: row.checkpointCaptureRoot }),
          ...(row.checkpointRepositoryCommonDir === null
            ? {}
            : { checkpointRepositoryCommonDir: row.checkpointRepositoryCommonDir }),
          ...(row.checkpointCommitOid === null
            ? {}
            : { checkpointCommitOid: row.checkpointCommitOid }),
        })),
      })
    })

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape['getFullThreadDiffContext']
  > = (threadId, toTurnCount) =>
    Effect.gen(function* ()
    {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getFullThreadDiffContext:query',
            'ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow',
          ),
        ),
      )
      if (Option.isNone(row))
      {
        return Option.none<ProjectionFullThreadDiffContext>()
      }

      const [fromCheckpointIdentity, toCheckpointIdentity] = yield* Effect.all([
        getCheckpointIdentity(threadId, 0),
        getCheckpointIdentity(threadId, toTurnCount),
      ])
      const targetIdentity = Option.getOrNull(toCheckpointIdentity)

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        ...(Option.isNone(fromCheckpointIdentity)
          ? {}
          : { fromCheckpointIdentity: fromCheckpointIdentity.value }),
        ...(targetIdentity === null
          ? {}
          : {
              toCheckpointIdentity: targetIdentity,
              toCheckpointRef: targetIdentity.checkpointRef,
            }),
      })
    })

  const getThreadShellById: ProjectionSnapshotQueryShape['getThreadShellById'] = (threadId) =>
    Effect.gen(function* ()
    {
      const [threadRow, latestTurnRow, sessionRow, approvalOutcomeRows, currentRunExecution] =
        yield* Effect.all([
          getActiveThreadRowById({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getThreadShellById:getThread:query',
                'ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow',
              ),
            ),
          ),
          getLatestTurnRowByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query',
                'ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow',
              ),
            ),
          ),
          getThreadSessionRowByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getThreadShellById:getSession:query',
                'ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow',
              ),
            ),
          ),
          listApprovalOutcomeRowsByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                'ProjectionSnapshotQuery.getThreadShellById:listApprovalOutcomes:query',
                'ProjectionSnapshotQuery.getThreadShellById:listApprovalOutcomes:decodeRows',
              ),
            ),
          ),
          getCurrentOrchestrateRunExecution(threadId),
        ])

      if (Option.isNone(threadRow))
      {
        return Option.none<OrchestrationThreadShell>()
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        providerSwitch: threadRow.value.providerSwitch,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        ...(threadRow.value.interactionOrchestrate === 1 ? { orchestrate: true } : {}),
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        ...(threadRow.value.orchestrateRunWorktreePath === null
          ? {}
          : { orchestrateRunWorktreePath: threadRow.value.orchestrateRunWorktreePath }),
        ...(threadRow.value.orchestrateRunBranch === null
          ? {}
          : { orchestrateRunBranch: threadRow.value.orchestrateRunBranch }),
        orchestrateRunExecution: Option.getOrNull(currentRunExecution),
        origin: threadRow.value.originJson,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        pinnedAt: threadRow.value.pinnedAt,
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        approvalOutcomes: approvalOutcomeRows.map(mapApprovalOutcomeRow),
      } satisfies OrchestrationThreadShell)
    })

  const isThreadImportFinalized: ProjectionSnapshotQueryShape['isThreadImportFinalized'] = (
    threadId,
  ) =>
    getThreadImportFinalizedRow({ threadId }).pipe(
      Effect.map((row) => row.isFinalized === 1),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.isThreadImportFinalized:query',
          'ProjectionSnapshotQuery.isThreadImportFinalized:decodeRow',
        ),
      ),
    )

  const listProjectedThreadActivities = Effect.fn(
    'ProjectionSnapshotQuery.listProjectedThreadActivities',
  )(function* (threadId: ThreadId)
  {
    const activityIdRows = yield* listThreadActivityIdRowsByThread({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:query',
          'ProjectionSnapshotQuery.getThreadDetailById:listActivityIds:decodeRows',
        ),
      ),
    )
    const activities: OrchestrationThreadActivity[] = []

    for (
      let offset = 0;
      offset < activityIdRows.length;
      offset += THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE
    )
    {
      const activityIds = activityIdRows
        .slice(offset, offset + THREAD_DETAIL_ACTIVITY_PAYLOAD_BATCH_SIZE)
        .map((row) => row.activityId)
      const rows = yield* listThreadActivityRowsByIds({ activityIds }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:query',
            'ProjectionSnapshotQuery.getThreadDetailById:listActivityPayloadBatch:decodeRows',
          ),
        ),
      )
      const rowById = new Map(rows.map((row) => [row.activityId, row] as const))
      for (const activityId of activityIds)
      {
        const row = rowById.get(activityId)
        if (row !== undefined)
        {
          activities.push(projectActivityPayload(mapThreadActivityRow(row)))
        }
      }
    }

    return activities
  })

  type ThreadDetailActivityRead = { readonly mode: 'raw' } | { readonly mode: 'client' }

  const getThreadDetailByIdWithActivityRead = (
    threadId: ThreadId,
    activityRead: ThreadDetailActivityRead,
  ) =>
    Effect.gen(function* ()
    {
      const activitiesEffect =
        activityRead.mode === 'client'
          ? listProjectedThreadActivities(threadId)
          : listThreadActivityRowsByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  'ProjectionSnapshotQuery.getThreadDetailById:listActivities:query',
                  'ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows',
                ),
              ),
              Effect.map((rows) => rows.map(mapThreadActivityRow)),
            )
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        orchestratePlanRows,
        activities,
        checkpointRows,
        latestTurnRow,
        sessionRow,
        approvalOutcomeRows,
        currentRunExecution,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:getThread:query',
              'ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow',
            ),
          ),
        ),
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:listMessages:query',
              'ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows',
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:listPlans:query',
              'ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows',
            ),
          ),
        ),
        listThreadOrchestratePlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:listOrchestratePlans:query',
              'ProjectionSnapshotQuery.getThreadDetailById:listOrchestratePlans:decodeRows',
            ),
          ),
        ),
        activitiesEffect,
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query',
              'ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows',
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query',
              'ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow',
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:getSession:query',
              'ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow',
            ),
          ),
        ),
        listApprovalOutcomeRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'ProjectionSnapshotQuery.getThreadDetailById:listApprovalOutcomes:query',
              'ProjectionSnapshotQuery.getThreadDetailById:listApprovalOutcomes:decodeRows',
            ),
          ),
        ),
        getCurrentOrchestrateRunExecution(threadId),
      ])

      if (Option.isNone(threadRow))
      {
        return Option.none<OrchestrationThread>()
      }

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        pendingHandoff: threadRow.value.pendingHandoff,
        providerSwitch: threadRow.value.providerSwitch,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        ...(threadRow.value.interactionOrchestrate === 1 ? { orchestrate: true } : {}),
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        ...(threadRow.value.orchestrateRunWorktreePath === null
          ? {}
          : { orchestrateRunWorktreePath: threadRow.value.orchestrateRunWorktreePath }),
        ...(threadRow.value.orchestrateRunBranch === null
          ? {}
          : { orchestrateRunBranch: threadRow.value.orchestrateRunBranch }),
        orchestrateRunExecution: Option.getOrNull(currentRunExecution),
        origin: threadRow.value.originJson,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        archiveGeneration: threadRow.value.archiveGeneration,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        unsettledAt: threadRow.value.unsettledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        pinnedAt: threadRow.value.pinnedAt,
        deletedAt: null,
        messages: messageRows.map((row) =>
        {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }
          if (row.attachments !== null)
          {
            return Object.assign(message, { attachments: row.attachments })
          }
          return message
        }),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        activities,
        orchestratePlans: orchestratePlanRows.map(mapOrchestratePlanRow),
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
          ...(row.checkpointCaptureRoot === null
            ? {}
            : { checkpointCaptureRoot: row.checkpointCaptureRoot }),
          ...(row.checkpointRepositoryCommonDir === null
            ? {}
            : { checkpointRepositoryCommonDir: row.checkpointRepositoryCommonDir }),
          ...(row.checkpointCommitOid === null
            ? {}
            : { checkpointCommitOid: row.checkpointCommitOid }),
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        approvalOutcomes: approvalOutcomeRows.map(mapApprovalOutcomeRow),
      }

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError('ProjectionSnapshotQuery.getThreadDetailById:decodeThread'),
          ),
        ),
      )
    })

  const getThreadDetailById: ProjectionSnapshotQueryShape['getThreadDetailById'] = (threadId) =>
    getThreadDetailByIdWithActivityRead(threadId, { mode: 'raw' })

  const getThreadDetailSnapshot: ProjectionSnapshotQueryShape['getThreadDetailSnapshot'] = (
    threadId,
  ) =>
    // read the thread detail and the snapshot sequence within a single
    // transaction so the sequence is consistent with the returned state; a
    // projector update landing between two separate reads could otherwise return
    // a sequence ahead of the thread detail, causing the client to resume from
    // too far and drop events.
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const thread = yield* getThreadDetailByIdWithActivityRead(threadId, { mode: 'client' })
          if (Option.isNone(thread))
          {
            return Option.none<OrchestrationThreadDetailSnapshot>()
          }
          const { snapshotSequence } = yield* getSnapshotSequence()
          return Option.some({ snapshotSequence, thread: thread.value })
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError('ProjectionSnapshotQuery.getThreadDetailSnapshot:transaction')(
                error,
              ),
        ),
      )

  return {
    getCommandReadModel,
    searchThreads,
    getSnapshot,
    getShellSnapshot,
    getArchivedShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getEventReplayStats,
    getImportReconciliationContext,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getCheckpointIdentity,
    getOrchestrateRunExecution,
    getCurrentOrchestrateRunExecution,
    getThreadShellById,
    isThreadImportFinalized,
    getThreadDetailById,
    getThreadDetailSnapshot,
  } satisfies ProjectionSnapshotQueryShape
})

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
)
