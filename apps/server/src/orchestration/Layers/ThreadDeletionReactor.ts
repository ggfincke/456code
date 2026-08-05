// apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts
// cleans up runtime resources after durable thread deletion

import type { OrchestrationEvent } from '@t3tools/contracts'
import { makeDrainableWorker } from '@t3tools/shared/DrainableWorker'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import { CartographerEmbedBroker } from '../../cartographer/CartographerEmbedBroker.ts'
import { ProposalGenerationService } from '../../proposal/ProposalGenerationService.ts'
import { ProviderService } from '../../provider/Services/ProviderService.ts'
import * as TerminalManager from '../../terminal/Manager.ts'
import { OrchestrationEngineService } from '../Services/OrchestrationEngine.ts'
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from '../Services/ThreadDeletionReactor.ts'

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: 'thread.deleted' }>

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>
  readonly message: string
  readonly threadId: ThreadDeletedEvent['payload']['threadId']
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
    {
      if (Cause.hasInterruptsOnly(cause))
      {
        return Effect.failCause(cause)
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      })
    }),
  )

export function runThreadDeletionCleanup<CancelError, EmbedError, ProviderError, TerminalError>({
  cancelProposalGeneration,
  closeCartographerEmbed,
  stopProviderSession,
  closeThreadTerminals,
}: {
  readonly cancelProposalGeneration: Effect.Effect<void, CancelError>
  readonly closeCartographerEmbed: Effect.Effect<void, EmbedError>
  readonly stopProviderSession: Effect.Effect<void, ProviderError>
  readonly closeThreadTerminals: Effect.Effect<void, TerminalError>
}): Effect.Effect<void, CancelError | EmbedError | ProviderError | TerminalError>
{
  return Effect.gen(function* ()
  {
    // install bounded-resource tombstones before slower external cleanup
    yield* cancelProposalGeneration
    yield* closeCartographerEmbed
    yield* stopProviderSession
    yield* closeThreadTerminals
  })
}

const make = Effect.gen(function* ()
{
  const orchestrationEngine = yield* OrchestrationEngineService
  const providerService = yield* ProviderService
  const terminalManager = yield* TerminalManager.TerminalManager
  const proposalGenerationService = yield* ProposalGenerationService
  const cartographerEmbedBroker = yield* CartographerEmbedBroker

  const stopProviderSession = (threadId: ThreadDeletedEvent['payload']['threadId']) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: 'thread deletion cleanup skipped provider session stop',
      threadId,
    })

  const closeThreadTerminals = (threadId: ThreadDeletedEvent['payload']['threadId']) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: 'thread deletion cleanup skipped terminal close',
      threadId,
    })

  const cancelProposalGeneration = (threadId: ThreadDeletedEvent['payload']['threadId']) =>
    logCleanupCauseUnlessInterrupted({
      effect: proposalGenerationService.cancelThread(threadId),
      message: 'thread deletion cleanup skipped proposal generation cancellation',
      threadId,
    })

  const closeCartographerEmbed = (threadId: ThreadDeletedEvent['payload']['threadId']) =>
    logCleanupCauseUnlessInterrupted({
      effect: cartographerEmbedBroker.closeThread(threadId),
      message: 'thread deletion cleanup skipped cartographer embed close',
      threadId,
    })

  const processThreadDeleted = Effect.fn('processThreadDeleted')(function* (
    event: ThreadDeletedEvent,
  )
  {
    const { threadId } = event.payload
    yield* runThreadDeletionCleanup({
      cancelProposalGeneration: cancelProposalGeneration(threadId),
      closeCartographerEmbed: closeCartographerEmbed(threadId),
      stopProviderSession: stopProviderSession(threadId),
      closeThreadTerminals: closeThreadTerminals(threadId),
    })
  })

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) =>
      {
        if (Cause.hasInterruptsOnly(cause))
        {
          return Effect.failCause(cause)
        }
        return Effect.logWarning('thread deletion reactor failed to process event', {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        })
      }),
    )

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely)

  const start: ThreadDeletionReactorShape['start'] = Effect.fn('start')(function* ()
  {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      {
        if (event.type !== 'thread.deleted')
        {
          return Effect.void
        }
        return worker.enqueue(event)
      }),
    )
  })

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape
})

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make)
