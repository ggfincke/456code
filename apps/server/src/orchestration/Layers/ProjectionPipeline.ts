// apps/server/src/orchestration/Layers/ProjectionPipeline.ts
// projects orchestration events into durable read models

import {
  ApprovalRequestId,
  type ChatAttachment,
  type ApprovalOutcomeStatus,
  type ProviderApprovalDecision,
  ModelSelection,
  NonNegativeInt,
  OrchestrateArchitecturePaths,
  OrchestratePlanRevision,
  type OrchestrateRunExecution,
  type OrchestrationEvent,
  ThreadId,
  ThreadOrigin,
} from '@t3tools/contracts'
import { classifyApprovalFailure } from '@t3tools/shared/approvalOutcomeClassifier'
import { isAdjacentProviderSwitchActivity } from '@t3tools/shared/providerSwitchActivity'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import {
  PersistenceSqlError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from '../../persistence/Errors.ts'
import { AttachmentLifecycleRepositoryLive } from '../../persistence/Layers/AttachmentLifecycle.ts'
import { AttachmentLifecycleRepository } from '../../persistence/Services/AttachmentLifecycle.ts'
import { OrchestrationEventStore } from '../../persistence/Services/OrchestrationEventStore.ts'
import { ProjectionPendingApprovalRepository } from '../../persistence/Services/ProjectionPendingApprovals.ts'
import { ProjectionProjectRepository } from '../../persistence/Services/ProjectionProjects.ts'
import { ProjectionStateRepository } from '../../persistence/Services/ProjectionState.ts'
import { ProjectionThreadActivityRepository } from '../../persistence/Services/ProjectionThreadActivities.ts'
import { type ProjectionThreadActivity } from '../../persistence/Services/ProjectionThreadActivities.ts'
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from '../../persistence/Services/ProjectionThreadMessages.ts'
import { ProjectionThreadProposedPlanRepository } from '../../persistence/Services/ProjectionThreadProposedPlans.ts'
import { ProjectionThreadSessionRepository } from '../../persistence/Services/ProjectionThreadSessions.ts'
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from '../../persistence/Services/ProjectionTurns.ts'
import { ProjectionThreadRepository } from '../../persistence/Services/ProjectionThreads.ts'
import { ProjectionPendingApprovalRepositoryLive } from '../../persistence/Layers/ProjectionPendingApprovals.ts'
import { ProjectionProjectRepositoryLive } from '../../persistence/Layers/ProjectionProjects.ts'
import { ProjectionStateRepositoryLive } from '../../persistence/Layers/ProjectionState.ts'
import { ProjectionThreadActivityRepositoryLive } from '../../persistence/Layers/ProjectionThreadActivities.ts'
import { ProjectionThreadMessageRepositoryLive } from '../../persistence/Layers/ProjectionThreadMessages.ts'
import { ProjectionThreadProposedPlanRepositoryLive } from '../../persistence/Layers/ProjectionThreadProposedPlans.ts'
import { ProjectionThreadSessionRepositoryLive } from '../../persistence/Layers/ProjectionThreadSessions.ts'
import { ProjectionTurnRepositoryLive } from '../../persistence/Layers/ProjectionTurns.ts'
import { ProjectionThreadRepositoryLive } from '../../persistence/Layers/ProjectionThreads.ts'
import { ServerConfig } from '../../config.ts'
import { pickOccupiedOrchestratePlanForRespondFailure } from '../projector.ts'
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from '../Services/ProjectionPipeline.ts'
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from '../../attachments/attachmentStore.ts'

import {
  deriveHasActionableProposedPlan,
  derivePendingUserInputCountFromActivities,
  extractActivityRequestId,
  settledTurnStateForSessionStatus,
} from './ProjectionDerivedState.ts'
import {
  retainProjectionActivitiesAfterRevert,
  retainProjectionMessagesAfterRevert,
  retainProjectionProposedPlansAfterRevert,
} from './ProjectionRevertRetention.ts'

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: 'projection.projects',
  threads: 'projection.threads',
  threadMessages: 'projection.thread-messages',
  threadProposedPlans: 'projection.thread-proposed-plans',
  threadOrchestratePlans: 'projection.thread-orchestrate-plans',
  orchestrateRunExecutions: 'projection.orchestrate-run-executions',
  threadActivities: 'projection.thread-activities',
  threadSessions: 'projection.thread-sessions',
  threadTurns: 'projection.thread-turns',
  checkpoints: 'projection.checkpoints',
  pendingApprovals: 'projection.pending-approvals',
} as const

const encodeThreadOriginJson = Schema.encodeSync(Schema.fromJsonString(ThreadOrigin))
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString)
const encodeOrchestratePlanStagesJson = Schema.encodeSync(
  Schema.fromJsonString(OrchestratePlanRevision.fields.stages),
)
const encodeOrchestratePlanLeadModelJson = Schema.encodeSync(
  Schema.NullOr(Schema.fromJsonString(ModelSelection)),
)
const encodeOrchestratePlanArchitecturePathsJson = Schema.encodeSync(
  Schema.NullOr(Schema.fromJsonString(OrchestrateArchitecturePaths)),
)
const ProjectionThreadOrchestratePlanDbRow = Schema.Struct({
  threadId: ThreadId,
  runId: OrchestratePlanRevision.fields.runId,
  revision: OrchestratePlanRevision.fields.revision,
  turnId: OrchestratePlanRevision.fields.turnId,
  workflow: OrchestratePlanRevision.fields.workflow,
  task: OrchestratePlanRevision.fields.task,
  stages: Schema.fromJsonString(OrchestratePlanRevision.fields.stages),
  totalWorkers: OrchestratePlanRevision.fields.totalWorkers,
  maxWorkers: OrchestratePlanRevision.fields.maxWorkers,
  source: OrchestratePlanRevision.fields.source,
  // NULL on every revision persisted before migration 054; nothing can
  // backfill it, so the column stays nullable rather than defaulted
  leadModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  status: OrchestratePlanRevision.fields.status,
  sourceSequence: Schema.NullOr(NonNegativeInt),
  // NULL when the revision omitted paths or was written before migration 068
  architecturePaths: Schema.NullOr(Schema.fromJsonString(OrchestrateArchitecturePaths)),
  createdAt: OrchestratePlanRevision.fields.createdAt,
  updatedAt: OrchestratePlanRevision.fields.updatedAt,
})
type ProjectionThreadOrchestratePlanDbRow = typeof ProjectionThreadOrchestratePlanDbRow.Type
const ProjectionThreadOrchestratePlanKey = Schema.Struct({
  threadId: ThreadId,
  runId: OrchestratePlanRevision.fields.runId,
  revision: OrchestratePlanRevision.fields.revision,
})
type ProjectionThreadOrchestratePlanKey = typeof ProjectionThreadOrchestratePlanKey.Type
const ProjectionThreadOrchestratePlansByThread = Schema.Struct({
  threadId: ThreadId,
})

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES]

// turn state to settle still-running turns with when their session leaves the
// "running" status, or null while the session is (re)starting or running and
// turns must stay unsettled.

interface ProjectorDefinition
{
  readonly name: ProjectorName
  readonly eventTypes: ReadonlySet<OrchestrationEvent['type']>
  readonly apply: (
    event: OrchestrationEvent,
    attachmentCleanupIntents: AttachmentCleanupIntents,
  ) => Effect.Effect<void, ProjectionRepositoryError>
}

interface AttachmentCleanupIntents
{
  readonly deletedThreads: Map<string, string>
  readonly removedRelativePaths: Set<string>
}

interface DirectAttachmentSideEffects
{
  readonly deletedThreadIds: Set<string>
  readonly prunedThreadRelativePaths: Map<string, Set<string>>
}

interface LegacyProviderSwitchReplayState
{
  readonly currentModelSelection: ModelSelection | null
  readonly pendingSwitch: {
    readonly requestId: string
    readonly sourceModelSelection: ModelSelection | null
    readonly targetModelSelection: ModelSelection
  } | null
}

const materializeAttachmentsForProjection = Effect.fn('materializeAttachmentsForProjection')(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
)

function retainProjectionOrchestratePlansAfterRevert(
  orchestratePlans: ReadonlyArray<ProjectionThreadOrchestratePlanDbRow>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadOrchestratePlanDbRow>
{
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  )
  return orchestratePlans.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId))
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string>
{
  const threadSegment = toSafeThreadAttachmentSegment(threadId)
  if (!threadSegment)
  {
    return new Set()
  }
  const relativePaths = new Set<string>()
  for (const message of messages)
  {
    for (const attachment of message.attachments ?? [])
    {
      if (attachment.type !== 'image')
      {
        continue
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id)
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment)
      {
        continue
      }
      relativePaths.add(attachmentRelativePath(attachment))
    }
  }
  return relativePaths
}

// a full refresh reads the entire thread history, so reserve it for activity
// lifecycle changes that can alter the projected shell summary
function shouldRefreshThreadShellSummaryForActivity(
  activity: Pick<ProjectionThreadActivity, 'kind'>,
): boolean
{
  switch (activity.kind)
  {
    case 'approval.requested':
    case 'approval.resolved':
    case 'provider.approval.respond.failed':
    case 'user-input.requested':
    case 'user-input.resolved':
    case 'provider.user-input.respond.failed':
      return true
    default:
      return false
  }
}

const runAttachmentSideEffects = Effect.fn('runAttachmentSideEffects')(function* (
  sideEffects: DirectAttachmentSideEffects,
)
{
  const serverConfig = yield* Effect.service(ServerConfig)
  const fileSystem = yield* Effect.service(FileSystem.FileSystem)
  const path = yield* Effect.service(Path.Path)

  const attachmentsRootDir = serverConfig.attachmentsDir
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))

  const removeDeletedThreadAttachmentEntry = Effect.fn('removeDeletedThreadAttachmentEntry')(
    function* (threadSegment: string, entry: string)
    {
      const normalizedEntry = entry.replace(/^[/\\]+/, '').replace(/\\/g, '/')
      if (normalizedEntry.length === 0 || normalizedEntry.includes('/'))
      {
        return
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry)
      if (!attachmentId)
      {
        return
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId)
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment)
      {
        return
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      })
    },
  )

  const deleteThreadAttachments = Effect.fn('deleteThreadAttachments')(function* (
    threadId: string,
  )
  {
    const threadSegment = toSafeThreadAttachmentSegment(threadId)
    if (!threadSegment)
    {
      yield* Effect.logWarning('skipping attachment cleanup for unsafe thread id', {
        threadId,
      })
      return
    }

    const entries = yield* readAttachmentRootEntries
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    )
  })

  const pruneThreadAttachmentEntry = Effect.fn('pruneThreadAttachmentEntry')(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  )
  {
    const relativePath = entry.replace(/^[/\\]+/, '').replace(/\\/g, '/')
    if (relativePath.length === 0 || relativePath.includes('/'))
    {
      return
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath)
    if (!attachmentId)
    {
      return
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId)
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment)
    {
      return
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath)
    const fileInfo = yield* fileSystem.stat(absolutePath).pipe(Effect.orElseSucceed(() => null))
    if (!fileInfo || fileInfo.type !== 'File')
    {
      return
    }

    if (!keptThreadRelativePaths.has(relativePath))
    {
      yield* fileSystem.remove(absolutePath, { force: true })
    }
  })

  const pruneThreadAttachments = Effect.fn('pruneThreadAttachments')(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  )
  {
    if (sideEffects.deletedThreadIds.has(threadId))
    {
      return
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId)
    if (!threadSegment)
    {
      yield* Effect.logWarning('skipping attachment prune for unsafe thread id', { threadId })
      return
    }

    const entries = yield* readAttachmentRootEntries
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    )
  })

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  })

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  )
})

const listThreadAttachmentRelativePaths = Effect.fn('listThreadAttachmentRelativePaths')(function* (
  threadId: string,
)
{
  const serverConfig = yield* Effect.service(ServerConfig)
  const fileSystem = yield* Effect.service(FileSystem.FileSystem)
  const threadSegment = toSafeThreadAttachmentSegment(threadId)
  if (!threadSegment)
  {
    return yield* Effect.die(new Error(`Unsafe thread id '${threadId}' for attachment lookup`))
  }
  if (!(yield* fileSystem.exists(serverConfig.attachmentsDir)))
  {
    return []
  }
  const entries = yield* fileSystem.readDirectory(serverConfig.attachmentsDir, {
    recursive: false,
  })
  return entries
    .flatMap((entry) =>
    {
      const relativePath = entry.replace(/^[/\\]+/, '').replace(/\\/g, '/')
      if (relativePath.length === 0 || relativePath.includes('/')) return []
      const attachmentId = parseAttachmentIdFromRelativePath(relativePath)
      if (!attachmentId) return []
      return parseThreadSegmentFromAttachmentId(attachmentId) === threadSegment
        ? [relativePath]
        : []
    })
    .toSorted()
})

const makeOrchestrationProjectionPipeline = Effect.fn('makeOrchestrationProjectionPipeline')(
  function* ()
  {
    const sql = yield* SqlClient.SqlClient
    const eventStore = yield* OrchestrationEventStore
    const projectionStateRepository = yield* ProjectionStateRepository
    const projectionProjectRepository = yield* ProjectionProjectRepository
    const projectionThreadRepository = yield* ProjectionThreadRepository
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository
    const projectionTurnRepository = yield* ProjectionTurnRepository
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository
    const attachmentLifecycleRepository = yield* AttachmentLifecycleRepository

    const recoverLegacyProviderSwitchSelections = Effect.fn(
      'recoverLegacyProviderSwitchSelections',
    )(function* (
      terminalEvent: Extract<OrchestrationEvent, { type: 'thread.provider-switch-failed' }>,
    )
    {
      const threadId = terminalEvent.payload.threadId
      const replayState = yield* eventStore.readFromSequence(0).pipe(
        Stream.takeWhile((event) => event.sequence < terminalEvent.sequence),
        Stream.runFold(
          (): LegacyProviderSwitchReplayState => ({
            currentModelSelection: null,
            pendingSwitch: null,
          }),
          (state, event): LegacyProviderSwitchReplayState =>
          {
            if (event.aggregateKind !== 'thread' || event.aggregateId !== threadId)
            {
              return state
            }
            switch (event.type)
            {
              case 'thread.created':
                return {
                  currentModelSelection: event.payload.modelSelection,
                  pendingSwitch: null,
                }
              case 'thread.meta-updated':
                return event.payload.modelSelection === undefined
                  ? state
                  : { ...state, currentModelSelection: event.payload.modelSelection }
              case 'thread.provider-switch-requested':
                return {
                  ...state,
                  pendingSwitch: {
                    requestId: event.eventId,
                    sourceModelSelection:
                      event.payload.sourceModelSelection ?? state.currentModelSelection,
                    targetModelSelection: event.payload.targetModelSelection,
                  },
                }
              case 'thread.provider-switch-failed':
                return event.payload.requestId !== undefined &&
                  state.pendingSwitch?.requestId !== event.payload.requestId
                  ? state
                  : { ...state, pendingSwitch: null }
              case 'thread.provider-switched':
                return event.payload.requestId !== undefined &&
                  state.pendingSwitch?.requestId !== event.payload.requestId
                  ? state
                  : {
                      currentModelSelection: event.payload.modelSelection,
                      pendingSwitch: null,
                    }
              default:
                return state
            }
          },
        ),
      )
      if (
        terminalEvent.payload.requestId !== undefined &&
        replayState.pendingSwitch?.requestId !== terminalEvent.payload.requestId
      )
      {
        return null
      }
      return replayState.pendingSwitch
    })

    const updateApprovalOutcome = (input: {
      readonly requestId: ApprovalRequestId
      readonly status: ApprovalOutcomeStatus
      readonly requestedDecision: ProviderApprovalDecision | null
      readonly decision: ProviderApprovalDecision | null
      readonly detail: string | null
      readonly actionId: string | null
      readonly acceptanceEvidence: string | null
      readonly updatedAt: string
    }) =>
      sql`
        UPDATE projection_pending_approvals
        SET
          outcome_status = ${input.status},
          outcome_requested_decision = ${input.requestedDecision},
          outcome_decision = ${input.decision},
          outcome_detail = ${input.detail},
          outcome_action_id = ${input.actionId},
          outcome_acceptance_evidence = ${input.acceptanceEvidence},
          outcome_updated_at = ${input.updatedAt}
        WHERE request_id = ${input.requestId}
          AND (
            outcome_status NOT IN ('accepted', 'stale-terminal')
            OR outcome_status = ${input.status}
          )
      `.pipe(
        Effect.mapError(toPersistenceSqlError('ProjectionPipeline.updateApprovalOutcome:query')),
      )

    const findThreadOrchestratePlanRow = SqlSchema.findOneOption({
      Request: ProjectionThreadOrchestratePlanKey,
      Result: ProjectionThreadOrchestratePlanDbRow,
      execute: ({ threadId, runId, revision }) => sql`
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
          AND run_id = ${runId}
          AND revision = ${revision}
        LIMIT 1
      `,
    })

    const listThreadOrchestratePlanRows = SqlSchema.findAll({
      Request: ProjectionThreadOrchestratePlansByThread,
      Result: ProjectionThreadOrchestratePlanDbRow,
      execute: ({ threadId }) => sql`
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

    const upsertThreadOrchestratePlanRow = Effect.fn('upsertThreadOrchestratePlanRow')(function* (
      row: ProjectionThreadOrchestratePlanDbRow,
    )
    {
      const stagesJson = encodeOrchestratePlanStagesJson(row.stages)
      const leadModelSelectionJson = encodeOrchestratePlanLeadModelJson(row.leadModelSelection)
      const architecturePathsJson = encodeOrchestratePlanArchitecturePathsJson(
        row.architecturePaths,
      )
      yield* sql`
          INSERT INTO projection_thread_orchestrate_plans (
            thread_id,
            run_id,
            revision,
            turn_id,
            workflow,
            task,
            stages_json,
            total_workers,
            max_workers,
            source,
            lead_model_selection_json,
            status,
            source_sequence,
            architecture_paths_json,
            created_at,
            updated_at
          )
          VALUES (
            ${row.threadId},
            ${row.runId},
            ${row.revision},
            ${row.turnId},
            ${row.workflow},
            ${row.task},
            ${stagesJson},
            ${row.totalWorkers},
            ${row.maxWorkers},
            ${row.source},
            ${leadModelSelectionJson},
            ${row.status},
            ${row.sourceSequence},
            ${architecturePathsJson},
            ${row.createdAt},
            ${row.updatedAt}
          )
          ON CONFLICT (thread_id, run_id, revision)
          DO UPDATE SET
            turn_id = excluded.turn_id,
            workflow = excluded.workflow,
            task = excluded.task,
            stages_json = excluded.stages_json,
            total_workers = excluded.total_workers,
            max_workers = excluded.max_workers,
            source = excluded.source,
            lead_model_selection_json = excluded.lead_model_selection_json,
            status = excluded.status,
            source_sequence = excluded.source_sequence,
            architecture_paths_json = excluded.architecture_paths_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError('ProjectionThreadOrchestratePlanRepository.upsert:query'),
        ),
      )
    })

    const insertOrchestrateExecutionJobs = Effect.fn('insertOrchestrateExecutionJobs')(function* (
      execution: OrchestrateRunExecution,
    )
    {
      yield* Effect.forEach(
        execution.jobs,
        (job) =>
          Effect.gen(function* ()
          {
            yield* sql`
              INSERT INTO projection_orchestrate_execution_jobs (
                job_id,
                thread_id,
                run_id,
                plan_revision,
                status,
                request_run_id,
                request_repository_root,
                result_repository_root,
                repository_common_dir,
                base_oid,
                head_oid,
                worktree_root,
                branch,
                bound_at
              )
              VALUES (
                ${job.jobId},
                ${execution.threadId},
                ${execution.runId},
                ${execution.planRevision},
                ${job.status},
                ${job.requestRunId},
                ${job.requestRepositoryRoot},
                ${job.resultRepositoryRoot},
                ${job.repositoryCommonDir},
                ${job.baseOid},
                ${job.headOid},
                ${job.worktreeRoot},
                ${job.branch},
                ${job.boundAt}
              )
              ON CONFLICT (job_id) DO NOTHING
              `
            const rows = yield* sql<{
              readonly jobId: string
              readonly threadId: string
              readonly runId: string
              readonly planRevision: number
              readonly status: string
              readonly requestRunId: string
              readonly requestRepositoryRoot: string
              readonly resultRepositoryRoot: string | null
              readonly repositoryCommonDir: string
              readonly baseOid: string
              readonly headOid: string | null
              readonly worktreeRoot: string | null
              readonly branch: string | null
              readonly boundAt: string
            }>`
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
                WHERE job_id = ${job.jobId}
              `
            const row = rows[0]
            if (
              row === undefined ||
              rows.length !== 1 ||
              row.jobId !== job.jobId ||
              row.threadId !== execution.threadId ||
              row.runId !== execution.runId ||
              row.planRevision !== execution.planRevision ||
              row.status !== job.status ||
              row.requestRunId !== job.requestRunId ||
              row.requestRepositoryRoot !== job.requestRepositoryRoot ||
              row.resultRepositoryRoot !== job.resultRepositoryRoot ||
              row.repositoryCommonDir !== job.repositoryCommonDir ||
              row.baseOid !== job.baseOid ||
              row.headOid !== job.headOid ||
              row.worktreeRoot !== job.worktreeRoot ||
              row.branch !== job.branch ||
              row.boundAt !== job.boundAt
            )
            {
              return yield* new PersistenceSqlError({
                operation: 'ProjectionOrchestrateRunExecutions.bindJob',
                detail:
                  `Broker job '${job.jobId}' is already bound with different immutable ` +
                  'execution identity or evidence.',
              })
            }
          }),
        { concurrency: 1, discard: true },
      )
    })

    const insertOrchestrateRunExecution = Effect.fn('insertOrchestrateRunExecution')(function* (
      execution: OrchestrateRunExecution,
    )
    {
      yield* sql`
          INSERT INTO projection_orchestrate_runs (
            thread_id,
            run_id,
            current_plan_revision,
            created_at,
            updated_at
          )
          VALUES (
            ${execution.threadId},
            ${execution.runId},
            ${execution.planRevision},
            ${execution.admittedAt},
            ${execution.updatedAt}
          )
          ON CONFLICT (thread_id, run_id)
          DO UPDATE SET
            current_plan_revision = excluded.current_plan_revision,
            updated_at = excluded.updated_at
        `
      yield* sql`
          UPDATE projection_orchestrate_run_executions
          SET is_current = 0
          WHERE thread_id = ${execution.threadId}
            AND is_current = 1
        `
      yield* sql`
          INSERT INTO projection_orchestrate_run_executions (
            thread_id,
            run_id,
            plan_revision,
            source_turn_id,
            source_sequence,
            repository_root,
            repository_common_dir,
            base_oid,
            lifecycle,
            availability,
            integration_root,
            integration_common_dir,
            integration_branch,
            integration_oid,
            observed_head_oid,
            final_head_oid,
            close_reason,
            is_current,
            admitted_at,
            updated_at,
            terminal_at
          )
          VALUES (
            ${execution.threadId},
            ${execution.runId},
            ${execution.planRevision},
            ${execution.sourceTurnId},
            ${execution.sourceSequence},
            ${execution.repositoryRoot},
            ${execution.repositoryCommonDir},
            ${execution.baseOid},
            ${execution.lifecycle},
            ${execution.availability},
            ${execution.integrationRoot},
            ${execution.integrationCommonDir},
            ${execution.integrationBranch},
            ${execution.integrationOid},
            ${execution.observedHeadOid},
            ${execution.finalHeadOid},
            ${execution.closeReason},
            ${execution.current ? 1 : 0},
            ${execution.admittedAt},
            ${execution.updatedAt},
            ${execution.terminalAt}
          )
        `
      yield* insertOrchestrateExecutionJobs(execution)
    })

    const updateOrchestrateRunExecution = Effect.fn('updateOrchestrateRunExecution')(function* (
      execution: OrchestrateRunExecution,
    )
    {
      yield* sql`
          UPDATE projection_orchestrate_run_executions
          SET
            lifecycle = ${execution.lifecycle},
            availability = ${execution.availability},
            integration_root = ${execution.integrationRoot},
            integration_common_dir = ${execution.integrationCommonDir},
            integration_branch = ${execution.integrationBranch},
            integration_oid = ${execution.integrationOid},
            observed_head_oid = ${execution.observedHeadOid},
            final_head_oid = ${execution.finalHeadOid},
            close_reason = ${execution.closeReason},
            is_current = ${execution.current ? 1 : 0},
            updated_at = ${execution.updatedAt},
            terminal_at = ${execution.terminalAt}
          WHERE thread_id = ${execution.threadId}
            AND run_id = ${execution.runId}
            AND plan_revision = ${execution.planRevision}
        `
      yield* sql`
          UPDATE projection_orchestrate_runs
          SET updated_at = ${execution.updatedAt}
          WHERE thread_id = ${execution.threadId}
            AND run_id = ${execution.runId}
        `
      yield* insertOrchestrateExecutionJobs(execution)
    })

    const deleteThreadOrchestratePlanRow = Effect.fn('deleteThreadOrchestratePlanRow')(function* (
      key: ProjectionThreadOrchestratePlanKey,
    )
    {
      yield* sql`
          DELETE FROM proposal_orchestrate_plan_links
          WHERE source_thread_id = ${key.threadId}
            AND run_id = ${key.runId}
            AND orchestrate_revision = ${key.revision}
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError('ProposalOrchestratePlanLinkRepository.deleteExact:query'),
        ),
      )
      yield* sql`
          DELETE FROM projection_thread_orchestrate_plans
          WHERE thread_id = ${key.threadId}
            AND run_id = ${key.runId}
            AND revision = ${key.revision}
        `.pipe(
        Effect.mapError(
          toPersistenceSqlError('ProjectionThreadOrchestratePlanRepository.deleteExact:query'),
        ),
      )
    })

    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const serverConfig = yield* ServerConfig

    const applyProjectsProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyProjectsProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'project.created':
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          })
          return

        case 'project.meta-updated':
        {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'project.deleted':
        {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          })
          return
        }

        default:
          return
      }
    })

    const refreshThreadShellSummary = Effect.fn('refreshThreadShellSummary')(function* (
      threadId: ThreadId,
    )
    {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      })
      if (Option.isNone(existingRow))
      {
        return
      }

      const [messages, proposedPlans, activities, pendingApprovals] = yield* Effect.all([
        projectionThreadMessageRepository.listByThreadId({ threadId }),
        projectionThreadProposedPlanRepository.listByThreadId({ threadId }),
        projectionThreadActivityRepository.listByThreadId({ threadId }),
        projectionPendingApprovalRepository.listByThreadId({ threadId }),
      ])

      let latestUserMessageAt: string | null = null
      for (const message of messages)
      {
        if (
          message.role === 'user' &&
          (latestUserMessageAt === null || message.createdAt > latestUserMessageAt)
        )
        {
          latestUserMessageAt = message.createdAt
        }
      }

      const pendingApprovalCount = pendingApprovals.filter(
        (approval) => approval.status === 'pending',
      ).length
      const pendingUserInputCount = derivePendingUserInputCountFromActivities(activities)
      const hasActionableProposedPlan = deriveHasActionableProposedPlan({
        latestTurnId: existingRow.value.latestTurnId,
        proposedPlans,
      })

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt,
        pendingApprovalCount,
        pendingUserInputCount,
        hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      })
    })

    const applyThreadsProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyThreadsProjection',
    )(function* (event, attachmentCleanupIntents)
    {
      switch (event.type)
      {
        case 'thread.created':
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            pendingHandoff: null,
            providerSwitch: null,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            interactionOrchestrate: event.payload.orchestrate === true ? 1 : 0,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            // a thread is never born inside a run; the integration target is
            // declared later and reaches this row through the shell refresh
            orchestrateRunWorktreePath: null,
            orchestrateRunBranch: null,
            originJson:
              event.payload.origin === null ? null : encodeThreadOriginJson(event.payload.origin),
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            archiveGeneration: 0,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          })
          return

        case 'thread.archived':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            archiveGeneration: event.payload.archiveGeneration ?? 0,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.unarchived':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.settled':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: 'settled',
            settledAt: event.payload.settledAt,
            unsettledAt: null,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.unsettled':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === 'user' ? 'active' : null,
            settledAt: null,
            // clearing an existing active pin is not a list re-entry
            unsettledAt:
              existingRow.value.settledOverride === 'active'
                ? existingRow.value.unsettledAt
                : event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.snoozed':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.unsnoozed':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.meta-updated':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        // updatedAt is deliberately untouched: adoption is a server observation,
        // and bumping it would reorder the user's thread list for a change the
        // user never made
        case 'thread.orchestrate-run-integration-set':
        {
          const authoritative = yield* sql<{ readonly present: number }>`
            SELECT EXISTS (
              SELECT 1
              FROM projection_orchestrate_run_executions
              WHERE thread_id = ${event.payload.threadId}
                AND is_current = 1
            ) AS present
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionThreads.authoritativeRunExists:query'),
            ),
          )
          if (authoritative[0]?.present === 1)
          {
            return
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            orchestrateRunWorktreePath: event.payload.worktreePath,
            orchestrateRunBranch: event.payload.branch,
          })
          return
        }

        case 'thread.orchestrate-run-execution-admitted':
        case 'thread.orchestrate-run-execution-updated':
        {
          const execution = event.payload.execution
          if (!execution.current)
          {
            return
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: execution.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          const available = execution.availability === 'available'
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            orchestrateRunWorktreePath: available ? execution.integrationRoot : null,
            orchestrateRunBranch: available ? execution.integrationBranch : null,
          })
          return
        }

        case 'thread.runtime-mode-set':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.interaction-mode-set':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            interactionOrchestrate: event.payload.orchestrate === true ? 1 : 0,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.provider-switch-requested':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            providerSwitch: {
              phase: 'pending',
              targetInstanceId: event.payload.targetModelSelection.instanceId,
              targetModel: event.payload.targetModelSelection.model,
              requestedAt: event.occurredAt,
              requestId: event.eventId,
              requestSequence: event.sequence,
              sourceModelSelection:
                event.payload.sourceModelSelection ?? existingRow.value.modelSelection,
            },
            updatedAt: event.occurredAt,
          })
          return
        }

        case 'thread.provider-switch-progressed':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (
            Option.isNone(existingRow) ||
            existingRow.value.providerSwitch === null ||
            (event.payload.requestId !== undefined &&
              existingRow.value.providerSwitch.requestId !== event.payload.requestId)
          )
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            providerSwitch: {
              ...existingRow.value.providerSwitch,
              phase: event.payload.phase,
            },
            updatedAt: event.occurredAt,
          })
          return
        }

        case 'thread.provider-switch-failed':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          if (
            event.payload.requestId !== undefined &&
            existingRow.value.providerSwitch?.requestId !== event.payload.requestId
          )
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            providerSwitch: null,
            updatedAt: event.occurredAt,
          })
          return
        }

        case 'thread.provider-switched':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: ThreadId.make(event.aggregateId),
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          if (
            event.payload.requestId !== undefined &&
            existingRow.value.providerSwitch?.requestId !== event.payload.requestId
          )
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            modelSelection: event.payload.modelSelection,
            providerSwitch: null,
            pendingHandoff:
              event.payload.handoffText.trim().length > 0
                ? {
                    text: event.payload.handoffText,
                    fromInstanceId: event.payload.fromInstanceId,
                    ...(event.payload.fromModel !== undefined
                      ? { fromModel: event.payload.fromModel }
                      : {}),
                    createdAt: event.occurredAt,
                  }
                : existingRow.value.pendingHandoff,
            updatedAt: event.occurredAt,
          })
          return
        }

        case 'thread.handoff-cleared':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pendingHandoff: null,
            updatedAt: event.occurredAt,
          })
          return
        }

        case 'thread.deleted':
        {
          const threadSegment = toSafeThreadAttachmentSegment(event.payload.threadId)
          if (threadSegment !== null)
          {
            attachmentCleanupIntents.deletedThreads.set(event.payload.threadId, threadSegment)
          }
          else
          {
            yield* Effect.logWarning('skipping attachment cleanup intent for unsafe thread id', {
              threadId: event.payload.threadId,
            })
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          })
          return
        }

        case 'thread.message-sent':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          const isImportedTranscriptMessage =
            existingRow.value.originJson !== null &&
            existingRow.value.latestTurnId === null &&
            event.payload.turnId === null &&
            !event.payload.streaming
          if (event.payload.role === 'user' || isImportedTranscriptMessage)
          {
            const latestUserMessageAt =
              event.payload.role === 'user' &&
              (existingRow.value.latestUserMessageAt === null ||
                event.payload.createdAt > existingRow.value.latestUserMessageAt)
                ? event.payload.createdAt
                : existingRow.value.latestUserMessageAt
            yield* projectionThreadRepository.upsert({
              ...existingRow.value,
              latestUserMessageAt,
              updatedAt: event.occurredAt,
            })
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          })
          return
        }

        case 'thread.activity-appended':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          const isImportedTranscriptActivity =
            existingRow.value.originJson !== null &&
            existingRow.value.latestTurnId === null &&
            event.payload.activity.turnId === null &&
            event.payload.activity.sequence !== undefined
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pendingHandoff:
              event.payload.activity.kind === 'provider.handoff.delivered'
                ? null
                : existingRow.value.pendingHandoff,
            updatedAt: event.occurredAt,
          })
          if (
            !isImportedTranscriptActivity &&
            shouldRefreshThreadShellSummaryForActivity(event.payload.activity)
          )
          {
            yield* refreshThreadShellSummary(event.payload.threadId)
          }
          return
        }

        case 'thread.proposed-plan-upserted':
        case 'thread.orchestrate-plan-upserted':
        case 'thread.orchestrate-plan-response-requested':
        case 'thread.approval-response-requested':
        case 'thread.user-input-response-requested':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          })
          yield* refreshThreadShellSummary(event.payload.threadId)
          return
        }

        case 'thread.session-set':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          const latestTurnId =
            event.payload.session.status === 'running' &&
            event.payload.session.activeTurnId !== null
              ? event.payload.session.activeTurnId
              : existingRow.value.latestTurnId
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          })
          yield* refreshThreadShellSummary(event.payload.threadId)
          return
        }

        case 'thread.turn-diff-completed':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          })
          yield* refreshThreadShellSummary(event.payload.threadId)
          return
        }

        case 'thread.reverted':
        {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          })
          if (Option.isNone(existingRow))
          {
            return
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          let latestTurnId: ProjectionTurn['turnId'] = null
          let latestCheckpointTurnCount = -1
          for (let index = 0; index < retainedTurns.length; index += 1)
          {
            const turn = retainedTurns[index]
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            )
            {
              continue
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount)
            {
              latestCheckpointTurnCount = turn.checkpointTurnCount
              latestTurnId = turn.turnId
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          })
          yield* refreshThreadShellSummary(event.payload.threadId)
          return
        }

        default:
          return
      }
    })

    const applyThreadMessagesProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyThreadMessagesProjection',
    )(function* (event, attachmentCleanupIntents)
    {
      switch (event.type)
      {
        case 'thread.message-sent':
        {
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          })
          const previousMessage = Option.getOrUndefined(existingMessage)
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) =>
            {
              if (event.payload.streaming)
              {
                return `${message.text}${event.payload.text}`
              }
              if (event.payload.text.length === 0)
              {
                return message.text
              }
              return event.payload.text
            },
          })
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments
          if (previousMessage !== undefined && event.payload.attachments !== undefined)
          {
            const previousRelativePaths = collectThreadAttachmentRelativePaths(
              event.payload.threadId,
              [previousMessage],
            )
            const nextRelativePaths = collectThreadAttachmentRelativePaths(event.payload.threadId, [
              { ...previousMessage, attachments: nextAttachments ?? [] },
            ])
            for (const relativePath of previousRelativePaths)
            {
              if (!nextRelativePaths.has(relativePath))
              {
                attachmentCleanupIntents.removedRelativePaths.add(relativePath)
              }
            }
          }
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: event.payload.streaming,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          })
          return
        }

        case 'thread.reverted':
        {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          if (existingRows.length === 0)
          {
            return
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          )
          if (keptRows.length === existingRows.length)
          {
            return
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          })
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid)
          const existingRelativePaths = collectThreadAttachmentRelativePaths(
            event.payload.threadId,
            existingRows,
          )
          const keptRelativePaths = collectThreadAttachmentRelativePaths(
            event.payload.threadId,
            keptRows,
          )
          for (const relativePath of existingRelativePaths)
          {
            if (!keptRelativePaths.has(relativePath))
            {
              attachmentCleanupIntents.removedRelativePaths.add(relativePath)
            }
          }
          return
        }

        default:
          return
      }
    })

    const applyThreadProposedPlansProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyThreadProposedPlansProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'thread.proposed-plan-upserted':
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          })
          return

        case 'thread.reverted':
        {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          if (existingRows.length === 0)
          {
            return
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          )
          if (keptRows.length === existingRows.length)
          {
            return
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          })
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid)
          return
        }

        default:
          return
      }
    })

    const applyThreadOrchestratePlansProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyThreadOrchestratePlansProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'thread.orchestrate-plan-upserted':
          // a new revision supersedes older pending revisions of the same run
          yield* sql`
            UPDATE projection_thread_orchestrate_plans
            SET
              status = 'superseded',
              updated_at = ${event.payload.plan.updatedAt}
            WHERE thread_id = ${event.payload.threadId}
              AND run_id = ${event.payload.plan.runId}
              AND revision < ${event.payload.plan.revision}
              AND status = 'pending'
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError(
                'ProjectionThreadOrchestratePlanRepository.supersedePending:query',
              ),
            ),
          )
          yield* upsertThreadOrchestratePlanRow({
            threadId: event.payload.threadId,
            ...event.payload.plan,
            architecturePaths: event.payload.plan.architecturePaths ?? null,
            sourceSequence: event.sequence,
          })
          return

        case 'thread.orchestrate-plan-response-requested':
        {
          const existingRow = yield* findThreadOrchestratePlanRow({
            threadId: event.payload.threadId,
            runId: event.payload.runId,
            revision: event.payload.revision,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionThreadOrchestratePlanRepository.get:query'),
            ),
          )
          if (Option.isNone(existingRow))
          {
            yield* Effect.logWarning('ignoring response for unknown orchestrate plan revision', {
              threadId: event.payload.threadId,
              runId: event.payload.runId,
              revision: event.payload.revision,
            })
            return
          }
          if (event.payload.decision === 'discuss')
          {
            return
          }

          const status = event.payload.decision === 'approve' ? 'approved' : 'rejected'
          yield* sql`
            UPDATE projection_thread_orchestrate_plans
            SET
              status = ${status},
              updated_at = ${event.payload.createdAt}
            WHERE thread_id = ${event.payload.threadId}
              AND run_id = ${event.payload.runId}
              AND revision = ${event.payload.revision}
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionThreadOrchestratePlanRepository.respond:query'),
            ),
          )
          return
        }

        case 'thread.activity-appended':
        {
          if (event.payload.activity.kind !== 'provider.orchestrate-plan.respond.failed')
          {
            return
          }
          const existingRows = yield* listThreadOrchestratePlanRows({
            threadId: event.payload.threadId,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError(
                'ProjectionThreadOrchestratePlanRepository.revertRespondFailure:list',
              ),
            ),
          )
          const target = pickOccupiedOrchestratePlanForRespondFailure(
            existingRows,
            event.payload.activity.payload,
            event.payload.activity.createdAt,
          )
          if (target === null)
          {
            return
          }
          yield* sql`
            UPDATE projection_thread_orchestrate_plans
            SET
              status = 'pending',
              updated_at = ${event.payload.activity.createdAt}
            WHERE thread_id = ${event.payload.threadId}
              AND run_id = ${target.runId}
              AND revision = ${target.revision}
              AND status IN ('approved', 'rejected')
              AND updated_at <= ${event.payload.activity.createdAt}
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError(
                'ProjectionThreadOrchestratePlanRepository.revertRespondFailure:query',
              ),
            ),
          )
          return
        }

        case 'thread.reverted':
        {
          const existingRows = yield* listThreadOrchestratePlanRows({
            threadId: event.payload.threadId,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionThreadOrchestratePlanRepository.list:query'),
            ),
          )
          if (existingRows.length === 0)
          {
            return
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          const keptRows = retainProjectionOrchestratePlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          )
          if (keptRows.length === existingRows.length)
          {
            return
          }

          const prunedRows = existingRows.filter(
            (row) =>
              !keptRows.some(
                (kept) =>
                  kept.threadId === row.threadId &&
                  kept.runId === row.runId &&
                  kept.revision === row.revision,
              ),
          )
          yield* Effect.forEach(prunedRows, deleteThreadOrchestratePlanRow, {
            concurrency: 1,
          }).pipe(Effect.asVoid)
          return
        }

        default:
          return
      }
    })

    const applyOrchestrateRunExecutionsProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyOrchestrateRunExecutionsProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'thread.orchestrate-run-execution-admitted':
          yield* insertOrchestrateRunExecution(event.payload.execution).pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionOrchestrateRunExecutions.admit:query'),
            ),
          )
          return

        case 'thread.orchestrate-run-execution-updated':
          yield* updateOrchestrateRunExecution(event.payload.execution).pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionOrchestrateRunExecutions.update:query'),
            ),
          )
          return

        default:
          return
      }
    })

    const applyThreadActivitiesProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyThreadActivitiesProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'thread.provider-switch-failed':
        {
          const sourceModelSelection = event.payload.sourceModelSelection
          const targetModelSelection = event.payload.targetModelSelection
          const thread =
            sourceModelSelection === undefined || targetModelSelection === undefined
              ? yield* projectionThreadRepository.getById({ threadId: event.payload.threadId })
              : Option.none()
          const legacyThread = Option.getOrUndefined(thread)
          const target = legacyThread?.providerSwitch ?? null
          const liveTargetModelSelection =
            target === null
              ? undefined
              : { instanceId: target.targetInstanceId, model: target.targetModel }
          const recovered =
            target === null &&
            (sourceModelSelection === undefined || targetModelSelection === undefined)
              ? yield* recoverLegacyProviderSwitchSelections(event)
              : null
          const source =
            sourceModelSelection ??
            (target === null
              ? (recovered?.sourceModelSelection ?? legacyThread?.modelSelection)
              : legacyThread?.modelSelection)
          const resolvedTargetModelSelection =
            targetModelSelection ?? liveTargetModelSelection ?? recovered?.targetModelSelection
          const activity: ProjectionThreadActivity = {
            activityId: event.eventId,
            threadId: event.payload.threadId,
            turnId: null,
            tone: 'error',
            kind: 'provider.switch.failed',
            summary: 'Provider switch failed',
            payload: {
              reasonCode: event.payload.reasonCode,
              detail: event.payload.detail,
              ...(source === undefined
                ? {}
                : {
                    fromInstanceId: source.instanceId,
                    fromModel: source.model,
                  }),
              ...(resolvedTargetModelSelection === undefined
                ? {}
                : {
                    toInstanceId: resolvedTargetModelSelection.instanceId,
                    toModel: resolvedTargetModelSelection.model,
                    retryTargetModelSelection: resolvedTargetModelSelection,
                  }),
            },
            sequence: event.sequence,
            createdAt: event.occurredAt,
          }
          if (event.payload.activityVersion === undefined)
          {
            const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
              threadId: event.payload.threadId,
            })
            if (existingRows.some((row) => isAdjacentProviderSwitchActivity(row, activity)))
            {
              return
            }
          }
          yield* projectionThreadActivityRepository.upsert(activity)
          return
        }

        case 'thread.provider-switched':
        {
          const threadId = ThreadId.make(event.aggregateId)
          const sourceModelSelection = event.payload.sourceModelSelection ?? {
            instanceId: event.payload.fromInstanceId,
            ...(event.payload.fromModel === undefined ? {} : { model: event.payload.fromModel }),
          }
          const activity: ProjectionThreadActivity = {
            activityId: event.eventId,
            threadId,
            turnId: null,
            tone: 'info',
            kind: 'provider.switch.completed',
            summary: `Switched from ${
              sourceModelSelection.model ?? sourceModelSelection.instanceId ?? 'prior provider'
            } to ${event.payload.modelSelection.model || event.payload.modelSelection.instanceId}`,
            payload: {
              fromInstanceId: sourceModelSelection.instanceId,
              ...(sourceModelSelection.model === undefined
                ? {}
                : { fromModel: sourceModelSelection.model }),
              toInstanceId: event.payload.modelSelection.instanceId,
              toModel: event.payload.modelSelection.model,
              targetModelSelection: event.payload.modelSelection,
            },
            sequence: event.sequence,
            createdAt: event.occurredAt,
          }
          if (event.payload.activityVersion === undefined)
          {
            const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
              threadId,
            })
            if (existingRows.some((row) => isAdjacentProviderSwitchActivity(row, activity)))
            {
              return
            }
          }
          yield* projectionThreadActivityRepository.upsert(activity)
          return
        }

        case 'thread.activity-appended':
        {
          const isProviderSwitchActivity =
            event.payload.activity.kind === 'provider.switch.failed' ||
            event.payload.activity.kind === 'provider.switch.completed'
          const activity: ProjectionThreadActivity = {
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : isProviderSwitchActivity
                ? { sequence: event.sequence }
                : {}),
            createdAt: event.payload.activity.createdAt,
          }
          if (isProviderSwitchActivity)
          {
            const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
              threadId: event.payload.threadId,
            })
            const replacedActivityId = existingRows.findLast(
              (row) =>
                event.causationEventId === row.activityId ||
                isAdjacentProviderSwitchActivity(row, activity),
            )?.activityId
            if (replacedActivityId !== undefined)
            {
              yield* projectionThreadActivityRepository.deleteByThreadId({
                threadId: event.payload.threadId,
              })
              yield* Effect.forEach(
                existingRows.filter((row) => row.activityId !== replacedActivityId),
                projectionThreadActivityRepository.upsert,
                { concurrency: 1, discard: true },
              )
            }
          }
          yield* projectionThreadActivityRepository.upsert(activity)
          return
        }

        case 'thread.reverted':
        {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          if (existingRows.length === 0)
          {
            return
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          )
          if (keptRows.length === existingRows.length)
          {
            return
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          })
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid)
          return
        }

        default:
          return
      }
    })

    const applyThreadSessionsProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyThreadSessionsProjection',
    )(function* (event, _attachmentSideEffects)
    {
      if (event.type !== 'thread.session-set')
      {
        return
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      })
    })

    const applyThreadTurnsProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyThreadTurnsProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'thread.turn-start-requested':
        {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          })
          return
        }

        case 'thread.session-set':
        {
          const turnId = event.payload.session.activeTurnId
          if (turnId === null || event.payload.session.status !== 'running')
          {
            if (
              event.payload.session.status === 'error' ||
              event.payload.session.status === 'stopped' ||
              event.payload.session.status === 'interrupted'
            )
            {
              yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
                threadId: event.payload.threadId,
              })
            }
            // leaving the "running" session status is the turn-end signal:
            // settle still-running turns so their duration reflects the whole
            // turn rather than the last assistant message.
            const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status)
            if (settledTurnState === null)
            {
              return
            }
            const existingTurns = yield* projectionTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            })
            yield* Effect.forEach(
              existingTurns.filter((turn) => turn.turnId !== null && turn.state === 'running'),
              (turn) =>
                turn.turnId === null
                  ? Effect.void
                  : projectionTurnRepository.upsertByTurnId({
                      ...turn,
                      turnId: turn.turnId,
                      state: settledTurnState,
                      // a running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: event.payload.session.updatedAt,
                    }),
              { concurrency: 1 },
            )
            return
          }

          // a new active turn supersedes any still-running turn on the same
          // thread — steering can open a new turn without the provider ever
          // completing the previous one.
          const otherRunningTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          yield* Effect.forEach(
            otherRunningTurns.filter(
              (turn) => turn.turnId !== null && turn.turnId !== turnId && turn.state === 'running',
            ),
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: 'completed',
                    completedAt: event.payload.session.updatedAt,
                  }),
            { concurrency: 1 },
          )

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          })
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          })
          if (Option.isSome(existingTurn))
          {
            const nextState =
              existingTurn.value.state === 'completed' || existingTurn.value.state === 'error'
                ? existingTurn.value.state
                : 'running'
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            })
          }
          else
          {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: 'running',
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
              checkpointCaptureRoot: null,
              checkpointRepositoryCommonDir: null,
              checkpointCommitOid: null,
            })
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          })
          return
        }

        case 'thread.message-sent':
        {
          if (event.payload.turnId === null || event.payload.role !== 'assistant')
          {
            return
          }
          // a completed assistant message only settles the turn once the
          // session is no longer running it — providers may emit several
          // assistant messages per turn (commentary between tool calls), and
          // the turn must stay unsettled until the provider reports turn end
          // (projected as thread.session-set leaving the "running" status).
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          })
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === 'running' &&
            session.value.activeTurnId === event.payload.turnId
          const settlesTurn = !event.payload.streaming && !turnStillRunning
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          })
          if (Option.isSome(existingTurn))
          {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: settlesTurn
                ? existingTurn.value.state === 'interrupted'
                  ? 'interrupted'
                  : existingTurn.value.state === 'error'
                    ? 'error'
                    : 'completed'
                : existingTurn.value.state,
              completedAt: settlesTurn
                ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            })
            return
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: settlesTurn ? 'completed' : 'running',
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: settlesTurn ? event.payload.updatedAt : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
            checkpointCaptureRoot: null,
            checkpointRepositoryCommonDir: null,
            checkpointCommitOid: null,
          })
          return
        }

        case 'thread.turn-interrupt-requested':
        {
          if (event.payload.turnId === undefined)
          {
            return
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          })
          if (Option.isSome(existingTurn))
          {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: 'interrupted',
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            })
            return
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: 'interrupted',
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
            checkpointCaptureRoot: null,
            checkpointRepositoryCommonDir: null,
            checkpointCommitOid: null,
          })
          return
        }

        case 'thread.turn-diff-completed':
        {
          // mid-turn diff updates produce placeholder checkpoints; record the
          // checkpoint, but don't settle a turn its session is still running.
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          })
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === 'running' &&
            session.value.activeTurnId === event.payload.turnId
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          })
          const nextState = event.payload.status === 'error' ? 'error' : 'completed'
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          })

          if (Option.isSome(existingTurn))
          {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: turnStillRunning ? existingTurn.value.state : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              checkpointCaptureRoot: event.payload.checkpointCaptureRoot ?? null,
              checkpointRepositoryCommonDir: event.payload.checkpointRepositoryCommonDir ?? null,
              checkpointCommitOid: event.payload.checkpointCommitOid ?? null,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            })
            return
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: turnStillRunning ? 'running' : nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
            checkpointCaptureRoot: event.payload.checkpointCaptureRoot ?? null,
            checkpointRepositoryCommonDir: event.payload.checkpointRepositoryCommonDir ?? null,
            checkpointCommitOid: event.payload.checkpointCommitOid ?? null,
          })
          return
        }

        case 'thread.reverted':
        {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          })
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          )
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          })
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid)
          return
        }

        default:
          return
      }
    })

    const upsertCheckpointIdentity = Effect.fn('upsertCheckpointIdentity')(function* (input: {
      readonly threadId: ThreadId
      readonly checkpointTurnCount: number
      readonly checkpointRef: string
      readonly checkpointCaptureRoot: string | null
      readonly checkpointRepositoryCommonDir: string | null
      readonly checkpointCommitOid: string | null
      readonly capturedAt: string
    })
    {
      yield* sql`
        INSERT INTO projection_checkpoint_identities (
          thread_id,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_capture_root,
          checkpoint_repository_common_dir,
          checkpoint_commit_oid,
          captured_at
        )
        VALUES (
          ${input.threadId},
          ${input.checkpointTurnCount},
          ${input.checkpointRef},
          ${input.checkpointCaptureRoot},
          ${input.checkpointRepositoryCommonDir},
          ${input.checkpointCommitOid},
          ${input.capturedAt}
        )
        ON CONFLICT (thread_id, checkpoint_turn_count)
        DO UPDATE SET
          checkpoint_ref = excluded.checkpoint_ref,
          checkpoint_capture_root = COALESCE(
            excluded.checkpoint_capture_root,
            projection_checkpoint_identities.checkpoint_capture_root
          ),
          checkpoint_repository_common_dir = COALESCE(
            excluded.checkpoint_repository_common_dir,
            projection_checkpoint_identities.checkpoint_repository_common_dir
          ),
          checkpoint_commit_oid = COALESCE(
            excluded.checkpoint_commit_oid,
            projection_checkpoint_identities.checkpoint_commit_oid
          ),
          captured_at = excluded.captured_at
      `.pipe(
        Effect.mapError(toPersistenceSqlError('ProjectionPipeline.upsertCheckpointIdentity:query')),
      )
    })

    const applyCheckpointsProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyCheckpointsProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'thread.checkpoint-baseline-recorded':
          yield* upsertCheckpointIdentity(event.payload)
          return

        case 'thread.turn-diff-completed':
          yield* upsertCheckpointIdentity({
            threadId: event.payload.threadId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointCaptureRoot: event.payload.checkpointCaptureRoot ?? null,
            checkpointRepositoryCommonDir: event.payload.checkpointRepositoryCommonDir ?? null,
            checkpointCommitOid: event.payload.checkpointCommitOid ?? null,
            capturedAt: event.payload.completedAt,
          })
          return

        case 'thread.reverted':
          yield* sql`
            DELETE FROM projection_checkpoint_identities
            WHERE thread_id = ${event.payload.threadId}
              AND checkpoint_turn_count > ${event.payload.turnCount}
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionPipeline.deleteStaleCheckpointIdentities:query'),
            ),
          )
          return

        case 'thread.deleted':
          yield* sql`
            DELETE FROM projection_checkpoint_identities
            WHERE thread_id = ${event.payload.threadId}
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError('ProjectionPipeline.deleteCheckpointIdentities:query'),
            ),
          )
          return

        default:
          return
      }
    })

    const applyPendingApprovalsProjection: ProjectorDefinition['apply'] = Effect.fn(
      'applyPendingApprovalsProjection',
    )(function* (event, _attachmentSideEffects)
    {
      switch (event.type)
      {
        case 'thread.activity-appended':
        {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null
          if (requestId === null)
          {
            return
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          })
          if (event.payload.activity.kind === 'approval.resolved')
          {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === 'object' &&
              event.payload.activity.payload !== null &&
              'decision' in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null
            const resolvedDecision =
              resolvedDecisionRaw === 'accept' ||
              resolvedDecisionRaw === 'acceptForSession' ||
              resolvedDecisionRaw === 'acceptAlways' ||
              resolvedDecisionRaw === 'decline' ||
              resolvedDecisionRaw === 'cancel'
                ? resolvedDecisionRaw
                : null
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: 'resolved',
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            })
            const payload =
              typeof event.payload.activity.payload === 'object' &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null
            const evidence =
              typeof payload?.acceptanceEvidence === 'object' && payload.acceptanceEvidence !== null
                ? encodeUnknownJsonString(payload.acceptanceEvidence)
                : encodeUnknownJsonString({ providerEventId: event.payload.activity.id })
            yield* updateApprovalOutcome({
              requestId,
              status: 'accepted',
              requestedDecision:
                payload?.requestedDecision === 'accept' ||
                payload?.requestedDecision === 'acceptForSession' ||
                payload?.requestedDecision === 'acceptAlways' ||
                payload?.requestedDecision === 'decline' ||
                payload?.requestedDecision === 'cancel'
                  ? payload.requestedDecision
                  : resolvedDecision,
              decision: resolvedDecision,
              detail: null,
              actionId: typeof payload?.actionId === 'string' ? payload.actionId : null,
              acceptanceEvidence: evidence,
              updatedAt: event.payload.activity.createdAt,
            })
            return
          }
          if (event.payload.activity.kind === 'provider.approval.respond.failed')
          {
            const payload =
              typeof event.payload.activity.payload === 'object' &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null
            const rawDetail = typeof payload?.detail === 'string' ? payload.detail : null
            const embeddedOutcome =
              typeof payload?.approvalOutcome === 'object' && payload.approvalOutcome !== null
                ? (payload.approvalOutcome as Record<string, unknown>)
                : null
            const classification = classifyApprovalFailure(payload)
            const outcomeStatus = classification.status
            if (Option.isNone(existingRow))
            {
              return
            }
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: existingRow.value.threadId,
              turnId: existingRow.value.turnId,
              status: classification.clearsBlockingRequest ? 'resolved' : 'pending',
              decision: null,
              createdAt: existingRow.value.createdAt,
              resolvedAt: classification.clearsBlockingRequest
                ? event.payload.activity.createdAt
                : null,
            })
            yield* updateApprovalOutcome({
              requestId,
              status: outcomeStatus,
              requestedDecision:
                embeddedOutcome?.requestedDecision === 'accept' ||
                embeddedOutcome?.requestedDecision === 'acceptForSession' ||
                embeddedOutcome?.requestedDecision === 'acceptAlways' ||
                embeddedOutcome?.requestedDecision === 'decline' ||
                embeddedOutcome?.requestedDecision === 'cancel'
                  ? embeddedOutcome.requestedDecision
                  : existingRow.value.decision,
              decision: null,
              detail:
                typeof embeddedOutcome?.detail === 'string' ? embeddedOutcome.detail : rawDetail,
              actionId:
                typeof embeddedOutcome?.actionId === 'string' ? embeddedOutcome.actionId : null,
              acceptanceEvidence: null,
              updatedAt: event.payload.activity.createdAt,
            })
            return
          }
          // only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingUserInputCountFromActivities.
          if (event.payload.activity.kind !== 'approval.requested')
          {
            return
          }
          if (Option.isSome(existingRow) && existingRow.value.status === 'resolved')
          {
            return
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: 'pending',
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          })
          yield* updateApprovalOutcome({
            requestId,
            status: 'pending',
            requestedDecision: null,
            decision: null,
            detail: null,
            actionId: null,
            acceptanceEvidence: null,
            updatedAt: event.payload.activity.createdAt,
          })
          return
        }

        case 'thread.approval-response-requested':
        {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          })
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: 'pending',
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: null,
          })
          yield* updateApprovalOutcome({
            requestId: event.payload.requestId,
            status: 'responding',
            requestedDecision: event.payload.decision,
            decision: null,
            detail: null,
            actionId: event.payload.approvalOutcome?.actionId ?? null,
            acceptanceEvidence: null,
            updatedAt: event.payload.createdAt,
          })
          return
        }

        default:
          return
      }
    })

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        eventTypes: new Set(['project.created', 'project.meta-updated', 'project.deleted']),
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        eventTypes: new Set(['thread.message-sent', 'thread.reverted']),
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        eventTypes: new Set(['thread.proposed-plan-upserted', 'thread.reverted']),
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        eventTypes: new Set([
          'thread.provider-switch-failed',
          'thread.provider-switched',
          'thread.activity-appended',
          'thread.reverted',
        ]),
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        eventTypes: new Set(['thread.session-set']),
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        eventTypes: new Set([
          'thread.turn-start-requested',
          'thread.session-set',
          'thread.message-sent',
          'thread.turn-interrupt-requested',
          'thread.turn-diff-completed',
          'thread.reverted',
        ]),
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadOrchestratePlans,
        eventTypes: new Set([
          'thread.orchestrate-plan-upserted',
          'thread.orchestrate-plan-response-requested',
          'thread.activity-appended',
          'thread.reverted',
        ]),
        apply: applyThreadOrchestratePlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.orchestrateRunExecutions,
        eventTypes: new Set([
          'thread.orchestrate-run-execution-admitted',
          'thread.orchestrate-run-execution-updated',
        ]),
        apply: applyOrchestrateRunExecutionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        eventTypes: new Set([
          'thread.checkpoint-baseline-recorded',
          'thread.turn-diff-completed',
          'thread.reverted',
          'thread.deleted',
        ]),
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        eventTypes: new Set(['thread.activity-appended', 'thread.approval-response-requested']),
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        eventTypes: new Set([
          'thread.created',
          'thread.archived',
          'thread.unarchived',
          'thread.settled',
          'thread.unsettled',
          'thread.snoozed',
          'thread.unsnoozed',
          'thread.meta-updated',
          'thread.orchestrate-run-integration-set',
          'thread.orchestrate-run-execution-admitted',
          'thread.orchestrate-run-execution-updated',
          'thread.runtime-mode-set',
          'thread.interaction-mode-set',
          'thread.provider-switch-requested',
          'thread.provider-switch-progressed',
          'thread.provider-switch-failed',
          'thread.provider-switched',
          'thread.handoff-cleared',
          'thread.deleted',
          'thread.message-sent',
          'thread.activity-appended',
          'thread.proposed-plan-upserted',
          'thread.orchestrate-plan-upserted',
          'thread.orchestrate-plan-response-requested',
          'thread.approval-response-requested',
          'thread.user-input-response-requested',
          'thread.session-set',
          'thread.turn-diff-completed',
          'thread.reverted',
        ]),
        apply: applyThreadsProjection,
      },
    ]

    const applyProjectorForEvent = Effect.fn('applyProjectorForEvent')(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    )
    {
      const attachmentCleanupIntents: AttachmentCleanupIntents = {
        deletedThreads: new Map<string, string>(),
        removedRelativePaths: new Set<string>(),
      }

      if (projector.eventTypes.has(event.type))
      {
        yield* projector.apply(event, attachmentCleanupIntents)
      }
      yield* Effect.forEach(
        attachmentCleanupIntents.removedRelativePaths,
        (relativePath) =>
          attachmentLifecycleRepository.enqueuePathCleanup({
            cleanupKey: `projection:${projector.name}:${event.sequence}:path:${relativePath}`,
            stagingKey: null,
            relativePath,
            stagingRelativePath: null,
            reason: `projection removed attachment reference during ${event.type}`,
            sourceSequence: event.sequence,
            now: event.occurredAt,
          }),
        { concurrency: 1 },
      )
      yield* Effect.forEach(
        attachmentCleanupIntents.deletedThreads,
        ([threadId, threadSegment]) =>
          attachmentLifecycleRepository.enqueueThreadCleanup({
            cleanupKey: `projection:${projector.name}:${event.sequence}:thread:${threadSegment}`,
            threadId: ThreadId.make(threadId),
            threadSegment,
            reason: 'projection deleted thread attachments',
            sourceSequence: event.sequence,
            now: event.occurredAt,
          }),
        { concurrency: 1 },
      )
      yield* projectionStateRepository.upsert({
        projector: projector.name,
        lastAppliedSequence: event.sequence,
        updatedAt: event.occurredAt,
      })
    })

    const runProjectorForEvent = (projector: ProjectorDefinition, event: OrchestrationEvent) =>
      sql.withTransaction(applyProjectorForEvent(projector, event))

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                Number.MAX_SAFE_INTEGER,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        )

    const projectEvent: OrchestrationProjectionPipelineShape['projectEvent'] = (event) =>
      sql
        .withTransaction(
          Effect.forEach(projectors, (projector) => applyProjectorForEvent(projector, event), {
            concurrency: 1,
          }),
        )
        .pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.asVoid,
          Effect.catchTag('SqlError', (sqlError) =>
            Effect.fail(toPersistenceSqlError('ProjectionPipeline.projectEvent:query')(sqlError)),
          ),
        )

    const bootstrap: OrchestrationProjectionPipelineShape['bootstrap'] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug('orchestration projection pipeline bootstrapped').pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag('SqlError', (sqlError) =>
        Effect.fail(toPersistenceSqlError('ProjectionPipeline.bootstrap:query')(sqlError)),
      ),
    )

    const provideAttachmentOwnerServices = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ServerConfig>,
    ) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
      )

    const verifyThreadAttachmentSet: NonNullable<
      OrchestrationProjectionPipelineShape['verifyThreadAttachmentSet']
    > = (input) =>
      provideAttachmentOwnerServices(listThreadAttachmentRelativePaths(input.threadId)).pipe(
        Effect.map((actualRelativePaths) =>
        {
          const expectedRelativePaths = [...input.expectedRelativePaths].toSorted()
          return {
            complete:
              actualRelativePaths.length === expectedRelativePaths.length &&
              actualRelativePaths.every((value, index) => value === expectedRelativePaths[index]),
            actualRelativePaths,
          }
        }),
      )

    const cleanupDeletedThreadAttachments: NonNullable<
      OrchestrationProjectionPipelineShape['cleanupDeletedThreadAttachments']
    > = (threadId) =>
      provideAttachmentOwnerServices(
        runAttachmentSideEffects({
          deletedThreadIds: new Set([threadId]),
          prunedThreadRelativePaths: new Map(),
        }).pipe(
          Effect.andThen(listThreadAttachmentRelativePaths(threadId)),
          Effect.map((remainingRelativePaths) => ({
            complete: remainingRelativePaths.length === 0,
            remainingRelativePaths,
          })),
        ),
      )

    return {
      bootstrap,
      projectEvent,
      verifyThreadAttachmentSet,
      cleanupDeletedThreadAttachments,
    } satisfies OrchestrationProjectionPipelineShape
  },
)

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
  Layer.provideMerge(AttachmentLifecycleRepositoryLive),
)
