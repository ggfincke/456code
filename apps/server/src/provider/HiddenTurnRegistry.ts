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
const pendingWaitersBySession = new Map<string, HiddenTurnWaiter>()
const waitersByTurn = new Map<string, HiddenTurnWaiter>()
const hiddenEvents = new WeakSet<ProviderRuntimeEvent>()

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
  let waiter =
    event.turnId === undefined
      ? undefined
      : waitersByTurn.get(turnKey(providerInstanceId, event.threadId, event.turnId))
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

  const interruptAndAwaitTerminalState = Effect.fn('interruptAndAwaitHiddenTurnTerminalState')(
    function* ()
    {
      const interruptInput =
        waiter.providerTurnId === null
          ? { threadId: input.request.threadId }
          : { threadId: input.request.threadId, turnId: waiter.providerTurnId }
      yield* Effect.all(
        [
          providerService.interruptTurn(interruptInput).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning('failed to interrupt hidden provider turn during cleanup', {
                threadId: input.request.threadId,
                turnId: waiter.providerTurnId,
                cause,
              }),
            ),
            Effect.timeoutOption(INTERRUPT_GRACE_TIMEOUT),
            Effect.asVoid,
          ),
          Deferred.await(waiter.result).pipe(
            Effect.timeoutOption(INTERRUPT_GRACE_TIMEOUT),
            Effect.asVoid,
          ),
        ],
        { concurrency: 'unbounded', discard: true },
      )
      if (waiter.terminalState === null)
      {
        // no terminal event confirmed: stop the session so a still-running
        // compaction turn cannot leak visible output once the waiter is gone;
        // the stopped binding keeps its cursor, so the next turn recovers
        yield* providerService.stopSession({ threadId: input.request.threadId }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('failed to stop session after hidden turn cleanup', {
              threadId: input.request.threadId,
              cause,
            }),
          ),
        )
      }
    },
  )

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
        waiter.providerTurnId === null
          ? Effect.failCause(cause)
          : interruptAndAwaitTerminalState().pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    )
    if (Option.isSome(awaited))
    {
      return awaited.value
    }

    yield* interruptAndAwaitTerminalState()
    return yield* new HiddenTurnAwaitError({
      threadId: input.request.threadId,
      detail: 'Hidden provider turn timed out after 120 seconds.',
    })
  }).pipe(
    Effect.ensuring(
      Effect.sync(() =>
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
        }
      }),
    ),
  )
})
