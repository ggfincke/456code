// tests/apps/server/provider/HiddenTurnRegistry.test.ts
// verifies hidden turn failure cleanup and waiter lifecycle

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInterruptTurnInput,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Result from 'effect/Result'
import * as TestClock from 'effect/testing/TestClock'
import { expect, vi } from 'vite-plus/test'

import { ProviderAdapterRequestError } from '../../../../apps/server/src/provider/Errors.ts'
import {
  hasPendingHiddenTurnForThread,
  HiddenTurnAwaitError,
  isHiddenTurnRuntimeEvent,
  observeHiddenTurnRuntimeEvent,
  sendTurnAndAwait,
} from '../../../../apps/server/src/provider/HiddenTurnRegistry.ts'
import type { ProviderServiceShape } from '../../../../apps/server/src/provider/Services/ProviderService.ts'

const provider = ProviderDriverKind.make('codex')
const providerInstanceId = ProviderInstanceId.make('codex')
const threadId = ThreadId.make('thread-hidden-cleanup')
const turnId = TurnId.make('turn-hidden-cleanup')

function turnStartedEvent(
  eventId: string,
  eventTurnId = turnId,
  eventProviderInstanceId = providerInstanceId,
): ProviderRuntimeEvent
{
  return {
    type: 'turn.started',
    eventId: EventId.make(eventId),
    provider,
    providerInstanceId: eventProviderInstanceId,
    threadId,
    turnId: eventTurnId,
    createdAt: '2026-07-31T12:00:00.000Z',
    payload: {},
  }
}

function turnAbortedEvent(eventId: string, eventTurnId = turnId): ProviderRuntimeEvent
{
  return {
    type: 'turn.aborted',
    eventId: EventId.make(eventId),
    provider,
    providerInstanceId,
    threadId,
    turnId: eventTurnId,
    createdAt: '2026-07-31T12:00:01.000Z',
    payload: { reason: 'late abort' },
  }
}

const assertWaiterRemoved = Effect.fn('assertHiddenTurnWaiterRemoved')(function* (
  lateEventId: string,
  eventTurnId = turnId,
)
{
  expect(hasPendingHiddenTurnForThread(threadId)).toBe(false)
  const lateEvent = turnAbortedEvent(lateEventId, eventTurnId)
  yield* observeHiddenTurnRuntimeEvent(lateEvent)
  expect(isHiddenTurnRuntimeEvent(lateEvent)).toBe(true)
})

it.effect('times out by interrupting the provider turn and stopping an unconfirmed session', () =>
  Effect.gen(function* ()
  {
    const interruptRequested = yield* Deferred.make<ProviderInterruptTurnInput>()
    const sendTurn = vi.fn<ProviderServiceShape['sendTurn']>((request) =>
      Effect.succeed({ threadId: request.threadId, turnId }),
    )
    const interruptTurn = vi.fn<ProviderServiceShape['interruptTurn']>((input) =>
      Deferred.succeed(interruptRequested, input).pipe(Effect.asVoid),
    )
    const stopSession = vi.fn<ProviderServiceShape['stopSession']>(() => Effect.void)
    const providerService = {
      sendTurn,
      interruptTurn,
      stopSession,
    } as unknown as ProviderServiceShape

    const resultFiber = yield* sendTurnAndAwait(providerService, {
      providerInstanceId,
      request: { threadId, input: 'compact' },
    }).pipe(Effect.result, Effect.forkChild)

    yield* Effect.yieldNow
    yield* TestClock.adjust('120 seconds')
    const interruptInput = yield* Deferred.await(interruptRequested)
    yield* TestClock.adjust('10 seconds')
    const result = yield* Fiber.join(resultFiber)

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
    {
      expect(result.failure).toBeInstanceOf(HiddenTurnAwaitError)
    }
    expect(interruptInput).toEqual({ threadId, turnId })
    expect(stopSession).toHaveBeenCalledExactlyOnceWith({ threadId })
    yield* assertWaiterRemoved('evt-late-timeout-abort')
  }),
)

it.effect('cleans up a started turn after send failure and preserves the original cause', () =>
  Effect.gen(function* ()
  {
    const failedTurnId = TurnId.make('turn-hidden-send-failure')
    const originalCause = new ProviderAdapterRequestError({
      provider: 'codex',
      method: 'session/prompt',
      detail: 'prompt rejected after turn start',
    })
    const interruptRequested = yield* Deferred.make<ProviderInterruptTurnInput>()
    const sendTurn = vi.fn<ProviderServiceShape['sendTurn']>(() =>
      observeHiddenTurnRuntimeEvent(
        turnStartedEvent('evt-start-before-send-failure', failedTurnId),
      ).pipe(Effect.andThen(Effect.fail(originalCause))),
    )
    const interruptTurn = vi.fn<ProviderServiceShape['interruptTurn']>((input) =>
      Deferred.succeed(interruptRequested, input).pipe(Effect.asVoid),
    )
    const stopSession = vi.fn<ProviderServiceShape['stopSession']>(() => Effect.void)
    const providerService = {
      sendTurn,
      interruptTurn,
      stopSession,
    } as unknown as ProviderServiceShape

    const resultFiber = yield* sendTurnAndAwait(providerService, {
      providerInstanceId,
      request: { threadId, input: 'compact' },
    }).pipe(Effect.result, Effect.forkChild)

    const interruptInput = yield* Deferred.await(interruptRequested)
    yield* TestClock.adjust('10 seconds')
    const result = yield* Fiber.join(resultFiber)

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
    {
      expect(result.failure).toBe(originalCause)
    }
    expect(interruptInput).toEqual({ threadId, turnId: failedTurnId })
    expect(stopSession).toHaveBeenCalledExactlyOnceWith({ threadId })
    yield* assertWaiterRemoved('evt-late-send-failure-abort', failedTurnId)
  }),
)

it.effect('retains hidden correlation until retry confirms provider cleanup', () =>
  Effect.gen(function* ()
  {
    const retryInstanceId = ProviderInstanceId.make('codex-hidden-retry')
    const retryTurnId = TurnId.make('turn-hidden-cleanup-retry')
    let stopAttempts = 0
    const stopFailure = new ProviderAdapterRequestError({
      provider: 'codex',
      method: 'session/stop',
      detail: 'stop outcome indeterminate',
    })
    const providerService = {
      sendTurn: vi.fn<ProviderServiceShape['sendTurn']>(() =>
        observeHiddenTurnRuntimeEvent(
          turnStartedEvent('evt-start-before-cleanup-retry', retryTurnId, retryInstanceId),
        ).pipe(Effect.as({ threadId, turnId: retryTurnId })),
      ),
      interruptTurn: vi.fn<ProviderServiceShape['interruptTurn']>(() => Effect.void),
      stopSession: vi.fn<ProviderServiceShape['stopSession']>(() =>
        ++stopAttempts === 1 ? Effect.fail(stopFailure) : Effect.void,
      ),
    } as unknown as ProviderServiceShape

    const resultFiber = yield* sendTurnAndAwait(providerService, {
      providerInstanceId: retryInstanceId,
      request: { threadId, input: 'compact' },
    }).pipe(Effect.result, Effect.forkChild)

    yield* Effect.yieldNow
    yield* TestClock.adjust('120 seconds')
    const result = yield* Fiber.join(resultFiber)
    expect(Result.isFailure(result)).toBe(true)
    expect(hasPendingHiddenTurnForThread(threadId)).toBe(true)

    const lateDelta: ProviderRuntimeEvent = {
      type: 'content.delta',
      eventId: EventId.make('evt-late-hidden-cleanup-delta'),
      provider,
      providerInstanceId: retryInstanceId,
      threadId,
      turnId: retryTurnId,
      createdAt: '2026-07-31T12:00:02.000Z',
      payload: { streamKind: 'assistant_text', delta: 'must stay hidden' },
    }
    yield* observeHiddenTurnRuntimeEvent(lateDelta)
    expect(isHiddenTurnRuntimeEvent(lateDelta)).toBe(true)

    yield* Effect.yieldNow
    yield* TestClock.adjust('5 seconds')
    yield* Effect.yieldNow
    expect(hasPendingHiddenTurnForThread(threadId)).toBe(false)
    expect(stopAttempts).toBe(2)
  }),
)
