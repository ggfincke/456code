// apps/server/src/provider/HiddenTurnRegistry.ts
// awaits provider turns while keeping their runtime events out of conversation projections

import type {
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import type { ProviderServiceError } from './Errors.ts'
import type { ProviderRoutingAuthority, ProviderServiceShape } from './Services/ProviderService.ts'

export type HiddenTurnTerminalState =
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'aborted'
  | 'runtime-error'
  | 'session-exited'

export interface HiddenTurnResult
{
  readonly turnId: TurnId
  readonly text: string
  readonly terminalState: HiddenTurnTerminalState
}

export class HiddenTurnAwaitError extends Data.TaggedError('HiddenTurnAwaitError')<{
  readonly threadId: ThreadId
  readonly detail: string
}>
{}

interface HiddenTurnWaiter
{
  readonly providerInstanceId: ProviderInstanceId
  readonly threadId: ThreadId
  readonly result: Deferred.Deferred<HiddenTurnResult>
  providerTurnId: TurnId | null
  text: string
  terminalState: HiddenTurnTerminalState | null
}

const WAIT_TIMEOUT = Duration.seconds(120)
const INTERRUPT_GRACE_TIMEOUT = Duration.seconds(10)
const CLEANUP_RETRY_DELAY = Duration.seconds(5)
const pendingWaitersBySession = new Map<string, HiddenTurnWaiter>()
const waitersByTurn = new Map<string, HiddenTurnWaiter>()
const hiddenTurnTombstones = new Set<string>()
const hiddenEvents = new WeakSet<ProviderRuntimeEvent>()
const MAX_HIDDEN_TURN_TOMBSTONES = 10_000

const sessionKey = (providerInstanceId: ProviderInstanceId, threadId: ThreadId) =>
  JSON.stringify([providerInstanceId, threadId])
const turnKey = (
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  providerTurnId: TurnId,
) => JSON.stringify([providerInstanceId, threadId, providerTurnId])

function markEventHidden(event: ProviderRuntimeEvent): void
{
  hiddenEvents.add(event)
}

function terminalStateFromEvent(event: ProviderRuntimeEvent): HiddenTurnTerminalState | null
{
  switch (event.type)
  {
    case 'turn.completed':
      return event.payload.state
    case 'turn.aborted':
      return 'aborted'
    case 'runtime.error':
      return 'runtime-error'
    case 'session.exited':
      return 'session-exited'
    default:
      return null
  }
}

const completeWaiterIfReady = (waiter: HiddenTurnWaiter) =>
  waiter.providerTurnId !== null && waiter.terminalState !== null
    ? Deferred.succeed(waiter.result, {
        turnId: waiter.providerTurnId,
        text: waiter.text,
        terminalState: waiter.terminalState,
      }).pipe(Effect.asVoid)
    : Effect.void

function bindWaiterToTurn(waiter: HiddenTurnWaiter, providerTurnId: TurnId): void
{
  waiter.providerTurnId = providerTurnId
  waitersByTurn.set(turnKey(waiter.providerInstanceId, waiter.threadId, providerTurnId), waiter)
}

export const observeHiddenTurnRuntimeEvent = Effect.fn('observeHiddenTurnRuntimeEvent')(function* (
  event: ProviderRuntimeEvent,
)
{
  const providerInstanceId = event.providerInstanceId
  if (providerInstanceId === undefined)
  {
    return
  }
  const key = sessionKey(providerInstanceId, event.threadId)
  const eventTurnKey =
    event.turnId === undefined
      ? undefined
      : turnKey(providerInstanceId, event.threadId, event.turnId)
  if (eventTurnKey !== undefined && hiddenTurnTombstones.has(eventTurnKey))
  {
    markEventHidden(event)
    return
  }
  let waiter = eventTurnKey === undefined ? undefined : waitersByTurn.get(eventTurnKey)
  if (waiter === undefined && event.type === 'turn.started' && event.turnId)
  {
    waiter = pendingWaitersBySession.get(key)
    if (waiter !== undefined)
    {
      bindWaiterToTurn(waiter, event.turnId)
    }
  }
  // session-scoped terminal signals (exit, turn-less runtime errors) have
  // no turn id; route them to the session's pending waiter
  const isSessionScopedTerminal =
    event.type === 'session.exited' ||
    (event.type === 'runtime.error' && event.turnId === undefined)
  if (waiter === undefined && isSessionScopedTerminal)
  {
    waiter = pendingWaitersBySession.get(key)
  }
  if (waiter === undefined)
  {
    return
  }

  if (
    !isSessionScopedTerminal &&
    (waiter.providerTurnId === null || event.turnId !== waiter.providerTurnId)
  )
  {
    return
  }

  markEventHidden(event)
  if (event.type === 'content.delta' && event.payload.streamKind === 'assistant_text')
  {
    waiter.text += event.payload.delta
  }
  waiter.terminalState = terminalStateFromEvent(event) ?? waiter.terminalState
  yield* completeWaiterIfReady(waiter)
})

export function isHiddenTurnRuntimeEvent(event: ProviderRuntimeEvent): boolean
{
  return hiddenEvents.has(event)
}

// lets the turn-start path refuse to steer into an in-flight compaction turn
export function hasPendingHiddenTurnForThread(threadId: ThreadId): boolean
{
  for (const waiter of pendingWaitersBySession.values())
  {
    if (waiter.threadId === threadId)
    {
      return true
    }
  }
  return false
}

export const sendTurnAndAwait = Effect.fn('sendTurnAndAwait')(function* (
  providerService: ProviderServiceShape,
  input: {
    readonly providerInstanceId: ProviderInstanceId
    readonly request: ProviderSendTurnInput
    readonly routingAuthority?: ProviderRoutingAuthority
  },
): Effect.fn.Return<HiddenTurnResult, ProviderServiceError | HiddenTurnAwaitError>
{
  const key = sessionKey(input.providerInstanceId, input.request.threadId)
  if (pendingWaitersBySession.has(key))
  {
    return yield* new HiddenTurnAwaitError({
      threadId: input.request.threadId,
      detail: 'A hidden provider turn is already pending for this thread.',
    })
  }

  const waiter: HiddenTurnWaiter = {
    providerInstanceId: input.providerInstanceId,
    threadId: input.request.threadId,
    result: yield* Deferred.make<HiddenTurnResult>(),
    providerTurnId: null,
    text: '',
    terminalState: null,
  }
  pendingWaitersBySession.set(key, waiter)
  let cleanupConfirmed = false

  const removeWaiter = Effect.sync(() =>
  {
    if (pendingWaitersBySession.get(key) === waiter)
    {
      pendingWaitersBySession.delete(key)
    }
    if (waiter.providerTurnId !== null)
    {
      const waiterTurnKey = turnKey(
        waiter.providerInstanceId,
        waiter.threadId,
        waiter.providerTurnId,
      )
      if (waitersByTurn.get(waiterTurnKey) === waiter)
      {
        waitersByTurn.delete(waiterTurnKey)
      }
      hiddenTurnTombstones.add(waiterTurnKey)
      if (hiddenTurnTombstones.size > MAX_HIDDEN_TURN_TOMBSTONES)
      {
        hiddenTurnTombstones.delete(hiddenTurnTombstones.values().next().value!)
      }
    }
  })

  const interruptAndAwaitTerminalState = Effect.fn('interruptAndAwaitHiddenTurnTerminalState')(
    function* (): Effect.fn.Return<boolean>
    {
      const interruptInput =
        waiter.providerTurnId === null
          ? { threadId: input.request.threadId }
          : { threadId: input.request.threadId, turnId: waiter.providerTurnId }
      yield* providerService.interruptTurn(interruptInput).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('failed to interrupt hidden provider turn during cleanup', {
            threadId: input.request.threadId,
            turnId: waiter.providerTurnId,
            cause,
          }),
        ),
        Effect.timeoutOption(INTERRUPT_GRACE_TIMEOUT),
        Effect.asVoid,
      )
      if (waiter.terminalState !== null)
      {
        cleanupConfirmed = true
        return true
      }
      const stopped = yield* providerService
        .stopSession({
          threadId: input.request.threadId,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning('failed to stop session after hidden turn cleanup', {
              threadId: input.request.threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        )
      if (stopped)
      {
        cleanupConfirmed = true
      }
      return stopped
    },
  )

  const retryCleanup = Effect.fn('retryHiddenTurnCleanup')(function* (): Effect.fn.Return<void>
  {
    while (!cleanupConfirmed)
    {
      yield* Effect.sleep(CLEANUP_RETRY_DELAY)
      yield* interruptAndAwaitTerminalState()
    }
    yield* removeWaiter
  })

  return yield* Effect.gen(function* ()
  {
    const awaited = yield* Effect.gen(function* ()
    {
      const turn = yield* providerService.sendTurn(input.request, input.routingAuthority)
      if (waiter.providerTurnId !== null && waiter.providerTurnId !== turn.turnId)
      {
        return yield* new HiddenTurnAwaitError({
          threadId: input.request.threadId,
          detail: [
            `Hidden turn correlation mismatch: observed '${waiter.providerTurnId}'`,
            `before send returned '${turn.turnId}'.`,
          ].join(' '),
        })
      }
      if (waiter.providerTurnId === null)
      {
        bindWaiterToTurn(waiter, turn.turnId)
      }
      yield* completeWaiterIfReady(waiter)
      return yield* Deferred.await(waiter.result)
    }).pipe(
      Effect.timeoutOption(WAIT_TIMEOUT),
      Effect.catchCause((cause) =>
        interruptAndAwaitTerminalState().pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    )
    if (Option.isSome(awaited))
    {
      cleanupConfirmed = true
      return awaited.value
    }

    yield* interruptAndAwaitTerminalState()
    return yield* new HiddenTurnAwaitError({
      threadId: input.request.threadId,
      detail: 'Hidden provider turn timed out after 120 seconds.',
    })
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* ()
      {
        if (cleanupConfirmed)
        {
          yield* removeWaiter
        }
        else
        {
          yield* retryCleanup().pipe(Effect.forkDetach)
        }
      }),
    ),
  )
})
