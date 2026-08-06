// apps/server/src/provider/Layers/AcpAdapterSessionLifecycle.ts
// owns shared ACP adapter session finalization and lookup ordering

import type { ProviderDriverKind, ProviderSession, ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'

import { ProviderAdapterSessionNotFoundError } from '../Errors.ts'
import type { AcpTerminationClassification } from '../acp/AcpAdapterSupport.ts'
import { makeKeyedSemaphore } from './KeyedSemaphore.ts'

export interface AcpAdapterSessionContext
{
  readonly threadId: ThreadId
  readonly generationId: string
  session: ProviderSession
  readonly scope: Scope.Closeable
  notificationFiber: Fiber.Fiber<void, never> | undefined
  readonly finalizationState: Ref.Ref<'open' | 'graceful' | 'abnormal'>
  stopped: boolean
}

interface AcpAdapterSessionLifecycleOptions<Context, Error, Requirements>
{
  readonly provider: ProviderDriverKind
  readonly enableAbnormalTermination: boolean
  readonly settlePending: (context: Context) => Effect.Effect<void, Error, Requirements>
  readonly emitSessionExited: (
    context: Context,
    classification: AcpTerminationClassification,
  ) => Effect.Effect<void, Error, Requirements>
}

export const makeAcpAdapterSessionLifecycle = Effect.fn('makeAcpAdapterSessionLifecycle')(
  function* <Context extends AcpAdapterSessionContext, Error = never, Requirements = never>(
    options: AcpAdapterSessionLifecycleOptions<Context, Error, Requirements>,
  )
  {
    const sessions = new Map<ThreadId, Context>()
    const threadLocks = yield* makeKeyedSemaphore<string>()

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      threadLocks.withPermit(threadId, effect)

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<Context, ProviderAdapterSessionNotFoundError> =>
    {
      const context = sessions.get(threadId)
      if (context === undefined || context.stopped)
      {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: options.provider, threadId }),
        )
      }
      return Effect.succeed(context)
    }

    const finalizeSessionLocked = (
      context: Context,
      classification: AcpTerminationClassification,
    ) =>
      Effect.gen(function* ()
      {
        const claimed = yield* Ref.modify(context.finalizationState, (state) =>
          state === 'open'
            ? ([true, classification.finalization] as const)
            : ([false, state] as const),
        )
        if (!claimed) return

        context.stopped = true
        yield* options.settlePending(context)

        const liveContext = sessions.get(context.threadId)
        const isLiveGeneration =
          liveContext === context && liveContext.generationId === context.generationId
        if (isLiveGeneration)
        {
          sessions.delete(context.threadId)
        }
        if (
          isLiveGeneration &&
          (classification.finalization === 'graceful' || options.enableAbnormalTermination)
        )
        {
          yield* options.emitSessionExited(context, classification)
        }
        if (context.notificationFiber !== undefined)
        {
          yield* Fiber.interrupt(context.notificationFiber)
        }
        yield* Effect.ignore(Scope.close(context.scope, Exit.void))
      }).pipe(Effect.uninterruptible)

    const finalizeSession = (context: Context, classification: AcpTerminationClassification) =>
      withThreadLock(context.threadId, finalizeSessionLocked(context, classification))

    const stopSession = (threadId: ThreadId, classification: AcpTerminationClassification) =>
      withThreadLock(
        threadId,
        Effect.gen(function* ()
        {
          const context = yield* requireSession(threadId)
          yield* finalizeSessionLocked(context, classification)
        }),
      )

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })))

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() =>
      {
        const context = sessions.get(threadId)
        return context !== undefined && !context.stopped
      })

    const stopAll = (classification: AcpTerminationClassification) =>
      Effect.forEach(
        Array.from(sessions.values()),
        (context) => finalizeSession(context, classification),
        { discard: true },
      )

    return {
      sessions,
      withThreadLock,
      requireSession,
      finalizeSessionLocked,
      finalizeSession,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
    }
  },
)
