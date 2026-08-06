// apps/server/src/orchestration/Layers/ProjectionSnapshotMappers.ts
// row schemas and domain mappers for projection snapshots

import {
  ApprovalAcceptanceEvidence,
  ApprovalOutcomeStatus,
  ApprovalRequestId,
  ChatAttachment,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestratePlanRevision,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationPendingHandoff,
  OrchestrationProviderSwitch,
  ThreadOrigin,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  ModelSelection,
  ProjectId,
  ProviderApprovalDecision,
  ThreadId,
  type ApprovalOutcome,
  ProjectScript,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'

import { ProjectionCheckpoint } from '../../persistence/Services/ProjectionCheckpoints.ts'
import { ProjectionProject } from '../../persistence/Services/ProjectionProjects.ts'
import { ProjectionState } from '../../persistence/Services/ProjectionState.ts'
import { ProjectionThreadActivity } from '../../persistence/Services/ProjectionThreadActivities.ts'
import { ProjectionThreadMessage } from '../../persistence/Services/ProjectionThreadMessages.ts'
import { ProjectionThreadProposedPlan } from '../../persistence/Services/ProjectionThreadProposedPlans.ts'
import { ProjectionThreadSession } from '../../persistence/Services/ProjectionThreadSessions.ts'
import { ProjectionThread } from '../../persistence/Services/ProjectionThreads.ts'

export const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
)
export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
)
export const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan
export const ProjectionThreadOrchestratePlanDbRowSchema = Schema.Struct({
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
  status: OrchestratePlanRevision.fields.status,
  createdAt: OrchestratePlanRevision.fields.createdAt,
  updatedAt: OrchestratePlanRevision.fields.updatedAt,
})
export const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    pendingHandoff: Schema.NullOr(Schema.fromJsonString(OrchestrationPendingHandoff)),
    providerSwitch: Schema.NullOr(Schema.fromJsonString(OrchestrationProviderSwitch)),
    originJson: Schema.NullOr(Schema.fromJsonString(ThreadOrigin)),
  }),
)
export const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
)
export const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession
export const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
)
export const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
})
export const ProjectionStateDbRowSchema = ProjectionState
export const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
})
export const ProjectionImportProjectRowSchema = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
})
export const ProjectionImportThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: Schema.fromJsonString(ModelSelection),
  origin: Schema.fromJsonString(ThreadOrigin),
  archived: Schema.Number,
})
export const ProjectionThreadImportFinalizedRowSchema = Schema.Struct({
  isFinalized: Schema.Number,
})
export const ProjectionApprovalOutcomeDbRowSchema = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  status: ApprovalOutcomeStatus,
  requestedDecision: Schema.NullOr(ProviderApprovalDecision),
  decision: Schema.NullOr(ProviderApprovalDecision),
  detail: Schema.NullOr(Schema.String),
  actionId: Schema.NullOr(Schema.String),
  acceptanceEvidence: Schema.NullOr(Schema.fromJsonString(ApprovalAcceptanceEvidence)),
  updatedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
})
export const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
})
export const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
})
export const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
})
export const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema
export const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
})
export const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
})
export const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
})
export const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
})

export function maxIso(left: string | null, right: string): string
{
  if (left === null)
  {
    return right
  }
  return left > right ? left : right
}

export function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn
{
  return {
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
  }
}

export function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession
{
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  }
}

export function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject['repositoryIdentity'],
): OrchestrationProjectShell
{
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan
{
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function mapApprovalOutcomeRow(
  row: Schema.Schema.Type<typeof ProjectionApprovalOutcomeDbRowSchema>,
): ApprovalOutcome
{
  return {
    requestId: row.requestId,
    status: row.status,
    ...(row.requestedDecision === null ? {} : { requestedDecision: row.requestedDecision }),
    ...(row.decision === null ? {} : { decision: row.decision }),
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.actionId === null ? {} : { actionId: row.actionId }),
    ...(row.acceptanceEvidence === null ? {} : { acceptanceEvidence: row.acceptanceEvidence }),
    updatedAt: row.updatedAt ?? row.createdAt,
  }
}

export function mapOrchestratePlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadOrchestratePlanDbRowSchema>,
): OrchestratePlanRevision
{
  return {
    runId: row.runId,
    revision: row.revision,
    turnId: row.turnId,
    workflow: row.workflow,
    task: row.task,
    stages: row.stages,
    totalWorkers: row.totalWorkers,
    maxWorkers: row.maxWorkers,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
