// apps/server/src/orchestration/Layers/ArchitectureAutoAnalysisReactor.ts
// requests checkpoint-pair architecture analyses through durable event replay

import {
  DiffAnalysisError,
  type DiffAnalysisErrorCode,
  NonNegativeInt,
  OrchestrationEvent,
  ServerSettingsError,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { DiffAnalysisService } from '../../cartographer/DiffAnalysisService.ts'
import { isPersistenceError, ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import type { ReactorActionRecord } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import { ServerSettingsService } from '../../serverSettings.ts'
import {
  architectureAutoAnalysisActionDuration,
  architectureAutoAnalysisActionsTotal,
  withMetrics,
} from '../../observability/Metrics.ts'
import {
  ArchitectureAutoAnalysisReactor,
  type ArchitectureAutoAnalysisReactorShape,
} from '../Services/ArchitectureAutoAnalysisReactor.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
  type ReactorEffectResult,
} from '../Services/DurableReactorRunner.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'

export const ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID = 'architecture-auto-analysis' as const
const OPERATION_VERSION = 1
const EFFECT_KIND = 'architecture.diff-analysis.request'
const TARGET_KIND = 'thread-turn-checkpoint'
const EventPayload = Schema.fromJsonString(OrchestrationEvent)
const ActionTarget = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.String, NonNegativeInt]),
)
const AutoAnalysisOutcome = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Literals([
      'requested',
      'cache-hit',
      'equal-tree',
      'setting-not-auto',
      'superseded',
      'checkpoint-ref-missing',
      'thread-deleted',
      'non-git',
      'not-ready',
      'failure',
    ]),
  }),
)
type AutoAnalysisOutcome = typeof AutoAnalysisOutcome.Type
type AutoAnalysisActionResult = AutoAnalysisOutcome['result']
const encodeEventPayload = Schema.encodeEffect(EventPayload)
const decodeEventPayload = Schema.decodeUnknownEffect(EventPayload)
const encodeActionTarget = Schema.encodeSync(ActionTarget)
const encodeOutcome = Schema.encodeSync(AutoAnalysisOutcome)
const decodeOutcome = Schema.decodeUnknownSync(AutoAnalysisOutcome)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

class ArchitectureAutoAnalysisPayloadError extends Schema.TaggedErrorClass<ArchitectureAutoAnalysisPayloadError>()(
  'ArchitectureAutoAnalysisPayloadError',
  { detail: Schema.String },
)
{}

const isArchitectureAutoAnalysisPayloadError = Schema.is(ArchitectureAutoAnalysisPayloadError)
const isDiffAnalysisError = Schema.is(DiffAnalysisError)
const isServerSettingsError = Schema.is(ServerSettingsError)
const RETRYABLE_DIFF_ANALYSIS_ERROR_CODES: ReadonlySet<DiffAnalysisErrorCode> = new Set([
  'repository-identity-failed',
  'materialization-failed',
  'analysis-timeout',
  'analysis-failed',
  'request-cancelled',
  'server-restarted',
  'persistence-failed',
])

const isPayloadError = (cause: unknown): boolean =>
  Schema.isSchemaError(cause) || isArchitectureAutoAnalysisPayloadError(cause)

const succeeded = (result: AutoAnalysisOutcome['result']): ReactorEffectResult => ({
  status: 'succeeded',
  resultJson: encodeOutcome({ result }),
})

function terminalDiffResult(cause: unknown): AutoAnalysisActionResult | null
{
  if (!isDiffAnalysisError(cause))
  {
    return null
  }
  switch (cause.code)
  {
    case 'checkpoint-ref-missing':
      return 'checkpoint-ref-missing'
    case 'thread-not-found':
      return 'thread-deleted'
    case 'not-git-repository':
      return 'non-git'
    case 'unsupported':
      return 'not-ready'
    default:
      return null
  }
}

function classifyFailure(cause: unknown): 'poison' | 'retryable' | 'manual'
{
  if (isPayloadError(cause))
  {
    return 'poison'
  }
  if (
    isServerSettingsError(cause) ||
    isPersistenceError(cause) ||
    (isDiffAnalysisError(cause) && RETRYABLE_DIFF_ANALYSIS_ERROR_CODES.has(cause.code))
  )
  {
    return 'retryable'
  }
  return 'manual'
}

export const makeArchitectureAutoAnalysisReactor = Effect.gen(function* ()
{
  const delivery = yield* OrchestrationReactorDelivery
  const projection = yield* ProjectionSnapshotQuery
  const durableRunner = yield* DurableReactorRunner
  const serverSettings = yield* ServerSettingsService
  const diffAnalysis = yield* DiffAnalysisService

  const definition: DurableReactorDefinition = {
    reactorId: ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID,
    operationVersion: OPERATION_VERSION,
    plan: (event) =>
    {
      if (event.type !== 'thread.turn-diff-completed' || event.payload.status !== 'ready')
      {
        return Effect.succeed([])
      }
      return encodeEventPayload(event).pipe(
        Effect.map((payloadJson) => [
          {
            outputIndex: 0,
            effectKind: EFFECT_KIND,
            targetKind: TARGET_KIND,
            targetId: encodeActionTarget([
              event.payload.threadId,
              event.payload.turnId,
              event.payload.checkpointTurnCount,
            ]),
            payloadJson,
          },
        ]),
      )
    },
    execute: (action: ReactorActionRecord) =>
    {
      let actionResult: AutoAnalysisActionResult = 'failure'
      return Effect.gen(function* ()
      {
        const event = yield* decodeEventPayload(action.payloadJson)
        if (
          event.type !== 'thread.turn-diff-completed' ||
          event.payload.status !== 'ready' ||
          action.effectKind !== EFFECT_KIND ||
          action.targetKind !== TARGET_KIND ||
          action.targetId !==
            encodeActionTarget([
              event.payload.threadId,
              event.payload.turnId,
              event.payload.checkpointTurnCount,
            ])
        )
        {
          return yield* new ArchitectureAutoAnalysisPayloadError({
            detail: `Action ${action.actionId} does not contain its ready checkpoint target.`,
          })
        }

        const settings = yield* serverSettings.getSettings
        if (settings.architectureAutoAnalysis !== 'auto')
        {
          return succeeded('setting-not-auto')
        }

        const context = yield* projection.getThreadCheckpointContext(event.payload.threadId)
        if (Option.isNone(context))
        {
          return succeeded('thread-deleted')
        }
        const latestReadyCheckpointTurnCount = context.value.checkpoints.reduce(
          (latest, checkpoint) =>
            checkpoint.status === 'ready'
              ? Math.max(latest, checkpoint.checkpointTurnCount)
              : latest,
          0,
        )
        if (latestReadyCheckpointTurnCount > event.payload.checkpointTurnCount)
        {
          return succeeded('superseded')
        }
        const checkpointIsCurrent = context.value.checkpoints.some(
          (checkpoint) =>
            checkpoint.status === 'ready' &&
            checkpoint.turnId === event.payload.turnId &&
            checkpoint.checkpointTurnCount === event.payload.checkpointTurnCount &&
            checkpoint.checkpointRef === event.payload.checkpointRef,
        )
        if (!checkpointIsCurrent)
        {
          return succeeded('checkpoint-ref-missing')
        }

        const workspaceRoot = context.value.worktreePath ?? context.value.workspaceRoot
        const requested = yield* diffAnalysis
          .request({
            workspaceRoot,
            source: {
              sourceKind: 'checkpoint',
              threadId: event.payload.threadId,
              fromTurnCount: Math.max(0, event.payload.checkpointTurnCount - 1),
              toTurnCount: event.payload.checkpointTurnCount,
            },
          })
          .pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
              {
                const result = terminalDiffResult(cause)
                return result === null ? Effect.fail(cause) : Effect.succeed(succeeded(result))
              },
              // a ready returned row is an observable cache reuse; P3 does not
              // expose a separate equal-tree signal, so other admissions are requested
              onSuccess: (generation) =>
                Effect.succeed(succeeded(generation.state === 'ready' ? 'cache-hit' : 'requested')),
            }),
          )
        return requested
      }).pipe(
        Effect.withSpan('ArchitectureAutoAnalysisReactor.execute'),
        Effect.tap((result) =>
          Effect.sync(() =>
          {
            if (result.resultJson !== undefined)
            {
              actionResult = decodeOutcome(result.resultJson).result
            }
          }),
        ),
        withMetrics({
          counter: architectureAutoAnalysisActionsTotal,
          timer: architectureAutoAnalysisActionDuration,
          attributes: () => ({ actionResult }),
        }),
      )
    },
    classify: classifyFailure,
    onLeaseExpiry: 'retryable',
  }

  const start: ArchitectureAutoAnalysisReactorShape['start'] = Effect.fn(
    'ArchitectureAutoAnalysisReactor.start',
  )(function* ()
  {
    const startedAt = yield* nowIso
    const existingProgress = yield* delivery.getProgress(ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID)
    const initialSequence = Option.isSome(existingProgress)
      ? 0
      : (yield* projection.getSnapshotSequence().pipe(
          Effect.mapError(
            (cause) =>
              new ReactorDeliveryError({
                operation: 'ArchitectureAutoAnalysisReactor.start:initialSequence',
                cause,
              }),
          ),
        )).snapshotSequence
    const progress = yield* delivery.ensureProgress({
      reactorId: ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID,
      operationVersion: OPERATION_VERSION,
      initialSequence,
      mode: 'durable',
      now: startedAt,
    })
    if (progress.mode === 'shadow')
    {
      yield* delivery.setMode({
        reactorId: ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID,
        mode: 'durable',
        ownerId: `${ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID}:cutover`,
        now: startedAt,
      })
    }
    yield* durableRunner.start(definition)
  })

  return {
    start,
    drain: durableRunner.drain(ARCHITECTURE_AUTO_ANALYSIS_REACTOR_ID),
  } satisfies ArchitectureAutoAnalysisReactorShape
})

export const ArchitectureAutoAnalysisReactorLive = Layer.effect(
  ArchitectureAutoAnalysisReactor,
  makeArchitectureAutoAnalysisReactor,
).pipe(Layer.provideMerge(DurableReactorInfrastructureLive))
