// apps/server/src/mcp/toolkits/orchestrate/tools.ts
// declares the authenticated orchestrate plan revision tool

import {
  OrchestratePlanRevision,
  OrchestratePlanRunId,
  OrchestratePlanStage,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Schema from 'effect/Schema'
import { Tool, Toolkit } from 'effect/unstable/ai'

import * as McpInvocationContext from '../../McpInvocationContext.ts'
import * as ProjectionSnapshotQuery from '../../../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as OrchestrationEngine from '../../../orchestration/Services/OrchestrationEngine.ts'

export const OrchestratePlanUpsertInput = Schema.Struct({
  runId: OrchestratePlanRunId,
  workflow: OrchestratePlanRevision.fields.workflow,
  task: OrchestratePlanRevision.fields.task,
  stages: Schema.Array(OrchestratePlanStage),
  totalWorkers: Schema.optional(OrchestratePlanRevision.fields.totalWorkers),
  maxWorkers: Schema.optional(OrchestratePlanRevision.fields.maxWorkers),
})
export type OrchestratePlanUpsertInput = typeof OrchestratePlanUpsertInput.Type

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

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  OrchestrationEngine.OrchestrationEngineService,
  Crypto.Crypto,
]

export const OrchestratePlanUpsertTool = Tool.make('orchestrate_plan_upsert', {
  description:
    'Persist an immutable orchestrate plan revision for the authenticated active orchestrate turn. When this toolkit is available, call this tool first, then ALSO emit the fenced orchestrate-plan block with the same runId as the render anchor the client mounts the persisted revision into; without this toolkit the fence alone is the supported form. The authenticated MCP session supplies thread and turn identity, so do not pass them. Reusing a runId appends its next revision and supersedes earlier pending revisions.',
  parameters: OrchestratePlanUpsertInput,
  success: OrchestratePlanRevision,
  failure: OrchestratePlanUpsertError,
  dependencies,
})
  .annotate(Tool.Title, 'Upsert orchestrate plan')
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)

export const OrchestrateToolkit = Toolkit.make(OrchestratePlanUpsertTool)
