// apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts
// executes durable ordered cleanup after thread deletion

import { OrchestrationEvent } from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { CartographerEmbedBroker } from '../../cartographer/CartographerEmbedBroker.ts'
import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import { ProposalGenerationService } from '../../proposal/ProposalGenerationService.ts'
import { ProviderService } from '../../provider/Services/ProviderService.ts'
import * as TerminalManager from '../../terminal/Manager.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../Services/DurableReactorRunner.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from '../Services/ThreadDeletionReactor.ts'

const REACTOR_ID = 'thread-deletion' as const
const OPERATION_VERSION = 1
const EventPayload = Schema.fromJsonString(OrchestrationEvent)
const encodeEventPayload = Schema.encodeEffect(EventPayload)
const decodeEventPayload = Schema.decodeUnknownEffect(EventPayload)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

class ThreadDeletionPayloadError extends Schema.TaggedErrorClass<ThreadDeletionPayloadError>()(
  'ThreadDeletionPayloadError',
  { detail: Schema.String },
)
{}
const isThreadDeletionPayloadError = Schema.is(ThreadDeletionPayloadError)

function isPayloadError(cause: unknown): boolean
{
  return Schema.isSchemaError(cause) || isThreadDeletionPayloadError(cause)
}

const make = Effect.gen(function* ()
{
  const delivery = yield* OrchestrationReactorDelivery
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const durableRunner = yield* DurableReactorRunner
  const providerService = yield* ProviderService
  const terminalManager = yield* TerminalManager.TerminalManager
  const proposalGenerationService = yield* ProposalGenerationService
  const cartographerEmbedBroker = yield* CartographerEmbedBroker

  const definition: DurableReactorDefinition = {
    reactorId: REACTOR_ID,
    operationVersion: OPERATION_VERSION,
    plan: (event) =>
    {
      if (event.type !== 'thread.deleted')
      {
        return Effect.succeed([])
      }
      return encodeEventPayload(event).pipe(
        Effect.map((payloadJson) => [
          {
            outputIndex: 0,
            effectKind: 'proposal-generation.cancel',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson,
          },
          {
            outputIndex: 1,
            effectKind: 'cartographer-embed.close',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson,
          },
          {
            outputIndex: 2,
            effectKind: 'provider-session.stop',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson,
          },
          {
            outputIndex: 3,
            effectKind: 'terminal.close-and-delete-history',
            targetKind: 'thread',
            targetId: event.payload.threadId,
            payloadJson,
          },
        ]),
      )
    },
    execute: Effect.fn('ThreadDeletionReactor.execute')(function* (action)
    {
      const event = yield* decodeEventPayload(action.payloadJson)
      if (event.type !== 'thread.deleted' || event.payload.threadId !== action.targetId)
      {
        return yield* new ThreadDeletionPayloadError({
          detail: `Action ${action.actionId} does not contain its thread.deleted target.`,
        })
      }

      switch (action.effectKind)
      {
        case 'proposal-generation.cancel':
          yield* proposalGenerationService.cancelThread(event.payload.threadId)
          break
        case 'cartographer-embed.close':
          yield* cartographerEmbedBroker.closeThread(event.payload.threadId)
          break
        case 'provider-session.stop':
          yield* providerService
            .stopSession({ threadId: event.payload.threadId })
            .pipe(
              Effect.catch((cause) =>
                cause._tag === 'ProviderSessionNotFoundError' ? Effect.void : Effect.fail(cause),
              ),
            )
          break
        case 'terminal.close-and-delete-history':
          yield* terminalManager.close({ threadId: event.payload.threadId, deleteHistory: true })
          break
        default:
          return yield* new ThreadDeletionPayloadError({
            detail: `Unsupported thread deletion effect kind '${action.effectKind}'.`,
          })
      }
      return { status: 'succeeded' as const }
    }),
    classify: (cause) => (isPayloadError(cause) ? 'poison' : 'retryable'),
    onLeaseExpiry: 'retryable',
  }

  const start: ThreadDeletionReactorShape['start'] = Effect.fn('ThreadDeletionReactor.start')(
    function* ()
    {
      const startedAt = yield* nowIso
      // an install that predates this reactor's durable progress row would
      // otherwise start at 0 and replay history as unhandled, re-running
      // deletion cleanup for threads deleted long ago
      const existingProgress = yield* delivery.getProgress(REACTOR_ID)
      const initialSequence = Option.isSome(existingProgress)
        ? 0
        : (yield* projectionSnapshotQuery.getSnapshotSequence().pipe(
            Effect.mapError(
              (cause) =>
                new ReactorDeliveryError({
                  operation: 'ThreadDeletionReactor.start:initialSequence',
                  cause,
                }),
            ),
          )).snapshotSequence
      const progress = yield* delivery.ensureProgress({
        reactorId: REACTOR_ID,
        operationVersion: OPERATION_VERSION,
        initialSequence,
        mode: 'durable',
        now: startedAt,
      })
      if (progress.mode === 'shadow')
      {
        yield* delivery.setMode({
          reactorId: REACTOR_ID,
          mode: 'durable',
          ownerId: `${REACTOR_ID}:cutover`,
          now: startedAt,
        })
      }
      yield* durableRunner.start(definition)
    },
  )

  return {
    start,
    drain: durableRunner.drain(REACTOR_ID),
  } satisfies ThreadDeletionReactorShape
})

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make).pipe(
  Layer.provideMerge(DurableReactorInfrastructureLive),
)
