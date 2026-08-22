// apps/server/src/mcp/toolkits/orchestrate/tools.ts
// declares authenticated orchestrate plan and execution tools

import {
  NonNegativeInt,
  OrchestratePlanRevision,
  OrchestratePlanRunId,
  OrchestratePlanStage,
  OrchestrateRunExecution,
  OrchestrateRunExecutionAvailability,
  TrimmedNonEmptyString,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Schema from 'effect/Schema'
import { Tool, Toolkit } from 'effect/unstable/ai'

import * as McpInvocationContext from '../../McpInvocationContext.ts'
import * as CheckpointIdentity from '../../../checkpointing/CheckpointIdentity.ts'
import * as ProjectionSnapshotQuery from '../../../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as OrchestrationEngine from '../../../orchestration/Services/OrchestrationEngine.ts'
import * as ProviderService from '../../../provider/Services/ProviderService.ts'
import * as WorkerBrokerStore from '../../../workers/WorkerBrokerStore.ts'
import { GitVcsDriver } from '../../../vcs/GitVcsDriver.ts'

export const OrchestratePlanUpsertInput = Schema.Struct({
  runId: OrchestratePlanRunId,
  workflow: OrchestratePlanRevision.fields.workflow,
  task: OrchestratePlanRevision.fields.task,
  stages: Schema.Array(OrchestratePlanStage),
  totalWorkers: Schema.optional(OrchestratePlanRevision.fields.totalWorkers),
  maxWorkers: Schema.optional(OrchestratePlanRevision.fields.maxWorkers),
  architecturePaths: OrchestratePlanRevision.fields.architecturePaths,
})
export type OrchestratePlanUpsertInput = typeof OrchestratePlanUpsertInput.Type

// the decider owns the exact committed revision returned to the caller
export const OrchestratePlanUpsertResult = OrchestratePlanRevision
export type OrchestratePlanUpsertResult = typeof OrchestratePlanUpsertResult.Type

export class OrchestratePlanUpsertError extends Schema.TaggedErrorClass<OrchestratePlanUpsertError>()(
  'OrchestratePlanUpsertError',
  {
    operation: Schema.String,
    code: Schema.Literals([
      'capability-unavailable',
      'identity-mismatch',
      'not-found',
      'persistence-failed',
    ]),
    detail: Schema.String,
    runId: Schema.optional(OrchestratePlanRunId),
  },
)
{
  override get message(): string
  {
    return `Orchestrate plan upsert failed (${this.operation}): ${this.detail}`
  }
}

export const OrchestrateExecutionAdmitInput = Schema.Struct({
  runId: OrchestratePlanRunId,
  planRevision: NonNegativeInt,
})
export type OrchestrateExecutionAdmitInput = typeof OrchestrateExecutionAdmitInput.Type

export const OrchestrateExecutionUpdateInput = Schema.Struct({
  runId: OrchestratePlanRunId,
  planRevision: NonNegativeInt,
  jobIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  integrationRoot: TrimmedNonEmptyString,
  integrationBranch: Schema.NullOr(TrimmedNonEmptyString),
  integrationOid: TrimmedNonEmptyString,
  lifecycle: Schema.Literals(['active', 'completed', 'failed', 'cancelled']),
  availability: OrchestrateRunExecutionAvailability,
  closeReason: Schema.optional(TrimmedNonEmptyString),
})
export type OrchestrateExecutionUpdateInput = typeof OrchestrateExecutionUpdateInput.Type

export const OrchestrateExecutionResult = OrchestrateRunExecution
export type OrchestrateExecutionResult = typeof OrchestrateExecutionResult.Type

export class OrchestrateExecutionError extends Schema.TaggedErrorClass<OrchestrateExecutionError>()(
  'OrchestrateExecutionError',
  {
    operation: Schema.String,
    code: Schema.Literals([
      'capability-unavailable',
      'identity-mismatch',
      'not-found',
      'persistence-failed',
      'evidence-unavailable',
      'evidence-mismatch',
      'repository-mismatch',
      'invalid-transition',
      'duplicate',
    ]),
    detail: Schema.String,
    runId: OrchestratePlanRunId,
    planRevision: NonNegativeInt,
    jobId: Schema.optional(TrimmedNonEmptyString),
  },
)
{
  override get message(): string
  {
    return `Orchestrate execution failed (${this.operation}): ${this.detail}`
  }
}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  OrchestrationEngine.OrchestrationEngineService,
  CheckpointIdentity.CheckpointIdentityResolver,
  ProviderService.ProviderService,
  WorkerBrokerStore.WorkerBrokerStore,
  GitVcsDriver,
  Crypto.Crypto,
]

export const OrchestratePlanUpsertTool = Tool.make('orchestrate_plan_upsert', {
  description:
    'Persist an immutable orchestrate plan revision for the authenticated active orchestrate turn. When this toolkit is available, call this tool first, then ALSO emit the fenced orchestrate-plan block with the same runId as the render anchor the client mounts the persisted revision into; without this toolkit the fence alone is the supported form. Optional architecturePaths are existing repository-relative files or directories for the standing Repository Map scope strip; never invent paths. Stage scope stays worker text. The authenticated MCP session supplies thread and turn identity, so do not pass them. Reusing a runId appends its next revision and supersedes earlier pending revisions. The response returns the exact committed plan revision chosen by the serialized decider.',
  parameters: OrchestratePlanUpsertInput,
  success: OrchestratePlanUpsertResult,
  failure: OrchestratePlanUpsertError,
  dependencies,
})
  .annotate(Tool.Title, 'Upsert orchestrate plan')
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)

export const OrchestrateExecutionAdmitTool = Tool.make('orchestrate_execution_admit', {
  description:
    'Admit exactly one authoritative execution for an approved orchestrate plan revision owned by this authenticated active turn. The server captures the live provider repository root, Git common-directory anchor, and immutable base OID; callers cannot supply repository identity. A byte-identical retry returns the already committed execution.',
  parameters: OrchestrateExecutionAdmitInput,
  success: OrchestrateExecutionResult,
  failure: OrchestrateExecutionError,
  dependencies,
})
  .annotate(Tool.Title, 'Admit orchestrate execution')
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

export const OrchestrateExecutionUpdateTool = Tool.make('orchestrate_execution_update', {
  description:
    'Advance the current authoritative execution using explicitly named worker-broker job records and an exact integration Git OID. Every job is re-read and verified against the admitted run, canonical repository, immutable base, terminal status, live worktree branch, and HEAD before it can bind. Terminal updates freeze the final OID; a byte-identical retry returns the already committed execution.',
  parameters: OrchestrateExecutionUpdateInput,
  success: OrchestrateExecutionResult,
  failure: OrchestrateExecutionError,
  dependencies,
})
  .annotate(Tool.Title, 'Update orchestrate execution')
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

export const OrchestrateToolkit = Toolkit.make(
  OrchestratePlanUpsertTool,
  OrchestrateExecutionAdmitTool,
  OrchestrateExecutionUpdateTool,
)
