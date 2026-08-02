// apps/server/src/mcp/toolkits/orchestrate/handlers.ts
// derives orchestrate plan authority from MCP context and persists revisions

import {
  CommandId,
  OrchestratePlanRevision,
  type OrchestrationCommand,
  type OrchestratePlanRunId,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import type { ThreadOrchestratePlanUpsertCommand } from '../../../orchestration/decider.ts'
import * as OrchestrationEngine from '../../../orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from '../../../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
import {
  OrchestratePlanUpsertError,
  OrchestrateToolkit,
  type OrchestratePlanUpsertInput,
} from './tools.ts'

// compiled once at module scope; rebuilding per call is a lint-flagged cost
const decodeOrchestratePlanRevision = Schema.decodeUnknownEffect(OrchestratePlanRevision)

function orchestratePlanError(
  operation: string,
  code: ConstructorParameters<typeof OrchestratePlanUpsertError>[0]['code'],
  detail: string,
  runId?: OrchestratePlanRunId,
): OrchestratePlanUpsertError
{
  return new OrchestratePlanUpsertError({
    operation,
    code,
    detail,
    ...(runId === undefined ? {} : { runId }),
  })
}

function errorDetail(cause: unknown): string
{
  return cause instanceof Error ? cause.message : String(cause)
}

const handlers = {
  orchestrate_plan_upsert: (input: OrchestratePlanUpsertInput) =>
    Effect.gen(function* ()
    {
      const scope = yield* McpInvocationContext.McpInvocationContext
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService

      if (!scope.capabilities.has('orchestrate'))
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.authorize',
          'capability-unavailable',
          'The authenticated MCP session does not grant the orchestrate capability.',
          input.runId,
        )
      }
      if (scope.activeTurnId === undefined)
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_plan',
          'identity-mismatch',
          'The authenticated MCP session is not bound to an active provider turn.',
          input.runId,
        )
      }

      const threadOption = yield* snapshots
        .getThreadDetailById(scope.threadId)
        .pipe(
          Effect.mapError((cause) =>
            orchestratePlanError(
              'orchestrate_plan_upsert.resolve_thread',
              'persistence-failed',
              errorDetail(cause),
              input.runId,
            ),
          ),
        )
      if (Option.isNone(threadOption))
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_thread',
          'not-found',
          'The authenticated source thread is not active.',
          input.runId,
        )
      }
      const thread = threadOption.value
      if (
        thread.session?.status !== 'running' ||
        thread.session.activeTurnId !== scope.activeTurnId ||
        thread.latestTurn?.state !== 'running' ||
        thread.latestTurn.turnId !== scope.activeTurnId
      )
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_plan',
          'identity-mismatch',
          "The authenticated MCP turn does not match the thread's active projected turn.",
          input.runId,
        )
      }
      if (thread.interactionMode !== 'orchestrate')
      {
        return yield* orchestratePlanError(
          'orchestrate_plan_upsert.resolve_plan',
          'identity-mismatch',
          'The authenticated MCP turn is not running in orchestrate mode.',
          input.runId,
        )
      }

      const persistedMaxRevision = yield* orchestrationEngine
        .readEvents(0, Number.MAX_SAFE_INTEGER)
        .pipe(
          Stream.runFold(
            () => 0,
            (maxRevision, event) =>
              event.type === 'thread.orchestrate-plan-upserted' &&
              event.payload.threadId === scope.threadId &&
              event.payload.plan.runId === input.runId
                ? Math.max(maxRevision, event.payload.plan.revision)
                : maxRevision,
          ),
          Effect.mapError((cause) =>
            orchestratePlanError(
              'orchestrate_plan_upsert.resolve_revision',
              'persistence-failed',
              errorDetail(cause),
              input.runId,
            ),
          ),
        )
      const projectedMaxRevision = thread.orchestratePlans.reduce(
        (maxRevision, plan) =>
          plan.runId === input.runId ? Math.max(maxRevision, plan.revision) : maxRevision,
        0,
      )
      const createdAt = DateTime.formatIso(yield* DateTime.now)
      const totalWorkers =
        input.totalWorkers ?? input.stages.reduce((total, stage) => total + stage.workers, 0)
      const plan = yield* decodeOrchestratePlanRevision({
        runId: input.runId,
        revision: Math.max(persistedMaxRevision, projectedMaxRevision) + 1,
        turnId: scope.activeTurnId,
        workflow: input.workflow,
        task: input.task,
        stages: input.stages,
        totalWorkers,
        maxWorkers: input.maxWorkers ?? totalWorkers,
        source: 'tool',
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      }).pipe(
        Effect.mapError((cause) =>
          orchestratePlanError(
            'orchestrate_plan_upsert.validate_revision',
            'persistence-failed',
            errorDetail(cause),
            input.runId,
          ),
        ),
      )

      const crypto = yield* Crypto.Crypto
      const command: ThreadOrchestratePlanUpsertCommand = {
        type: 'thread.orchestrate-plan.upsert',
        commandId: CommandId.make(
          `provider:orchestrate-plan-upsert:${yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) =>
              orchestratePlanError(
                'orchestrate_plan_upsert.create_command',
                'persistence-failed',
                errorDetail(cause),
                input.runId,
              ),
            ),
          )}`,
        ),
        threadId: scope.threadId,
        plan,
        createdAt,
      }
      yield* orchestrationEngine
        .dispatch(command as unknown as OrchestrationCommand)
        .pipe(
          Effect.mapError((cause) =>
            orchestratePlanError(
              'orchestrate_plan_upsert.persist',
              'persistence-failed',
              errorDetail(cause),
              input.runId,
            ),
          ),
        )
      return plan
    }),
} satisfies Parameters<typeof OrchestrateToolkit.toLayer>[0]

export const OrchestrateToolkitHandlersLive = OrchestrateToolkit.toLayer(handlers)
