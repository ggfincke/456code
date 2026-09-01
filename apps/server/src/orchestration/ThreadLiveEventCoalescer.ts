// apps/server/src/orchestration/ThreadLiveEventCoalescer.ts
// coalesces nonterminal live tool updates within one bounded subscription

import {
  type OrchestrationEvent,
  OrchestrationGetSnapshotError,
  type OrchestrationThreadStreamItem,
} from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Predicate from 'effect/Predicate'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { projectActivityEvent } from './ActivityPayloadProjection.ts'
import { makeLiveStreamBudget, type RetainedLiveItem } from './LiveStreamBudget.ts'

const COALESCE_WINDOW = Duration.millis(50)
const MAX_PENDING_UPDATES = 512
const MAX_TRACKED_TOOL_STATUSES = 512

export type ThreadLiveInput =
  { readonly kind: 'event'; readonly event: OrchestrationEvent } | { readonly kind: 'synchronized' }

function asRecord(value: unknown): Record<string, unknown> | null
{
  return Predicate.isObject(value) ? value : null
}

function asTrimmedString(value: unknown): string | null
{
  if (!Predicate.isString(value))
  {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stableToolCallIdentity(event: OrchestrationEvent): string | null
{
  if (event.type !== 'thread.activity-appended')
  {
    return null
  }
  const payload = asRecord(event.payload.activity.payload)
  const data = asRecord(payload?.data)
  return asTrimmedString(payload?.toolCallId) ?? asTrimmedString(data?.toolCallId)
}

function stableToolCallKey(event: OrchestrationEvent): string | null
{
  const identity = stableToolCallIdentity(event)
  if (identity === null || event.type !== 'thread.activity-appended')
  {
    return null
  }
  return `${event.payload.activity.turnId ?? ''}\u0000${identity}`
}

function rememberStatus(statuses: Map<string, string>, key: string, status: string): void
{
  statuses.delete(key)
  statuses.set(key, status)
  if (statuses.size > MAX_TRACKED_TOOL_STATUSES)
  {
    const oldestKey = statuses.keys().next().value
    if (oldestKey !== undefined)
    {
      statuses.delete(oldestKey)
    }
  }
}

function normalizeToolStatus(status: string | null): string
{
  return status === null ? 'unknown' : status === 'in_progress' ? 'inProgress' : status
}

function isCoalescibleToolUpdate(
  event: OrchestrationEvent,
  statuses: Map<string, string>,
): boolean
{
  if (event.type !== 'thread.activity-appended')
  {
    return false
  }
  const payload = asRecord(event.payload.activity.payload)
  const data = asRecord(payload?.data)
  const item = asRecord(data?.item)
  const rawStatus =
    asTrimmedString(payload?.status) ??
    asTrimmedString(data?.status) ??
    asTrimmedString(item?.status)
  const status = normalizeToolStatus(rawStatus)
  const key = stableToolCallKey(event)
  const terminal = status === 'completed' || status === 'failed' || status === 'declined'
  const hasError =
    payload?.error !== undefined || data?.error !== undefined || item?.error !== undefined
  const statusChanged = key === null || statuses.get(key) !== status

  if (key !== null)
  {
    if (terminal || hasError || event.payload.activity.kind === 'tool.completed')
    {
      statuses.delete(key)
    }
    else
    {
      rememberStatus(statuses, key, status)
    }
  }

  return event.payload.activity.kind === 'tool.updated' && !terminal && !hasError && !statusChanged
}

function coalescePendingToolUpdates(
  pendingUpdates: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<OrchestrationEvent>
{
  const seen = new Set<string>()
  const latestUpdates: Array<OrchestrationEvent> = []
  for (let index = pendingUpdates.length - 1; index >= 0; index -= 1)
  {
    const event = pendingUpdates[index]!
    const key = stableToolCallKey(event)
    if (key !== null && seen.has(key))
    {
      continue
    }
    if (key !== null)
    {
      seen.add(key)
    }
    latestUpdates.push(event)
  }
  latestUpdates.reverse()
  return latestUpdates
}

// keep only the latest repeated-status update for each stable tool-call id
export function coalesceLiveToolUpdatedEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<OrchestrationEvent>
{
  const survivors: Array<OrchestrationEvent> = []
  const statuses = new Map<string, string>()
  let pendingUpdates: Array<OrchestrationEvent> = []

  const flushUpdates = () =>
  {
    survivors.push(...coalescePendingToolUpdates(pendingUpdates))
    pendingUpdates = []
  }

  for (const event of events)
  {
    if (isCoalescibleToolUpdate(event, statuses))
    {
      pendingUpdates.push(event)
      continue
    }
    flushUpdates()
    survivors.push(event)
  }
  flushUpdates()
  return survivors
}

export const makeThreadLiveEventCoalescer = Effect.fn('makeThreadLiveEventCoalescer')(
  function* (options?: {
    readonly coalesceWindow?: Duration.Input
    readonly maxItems?: number
    readonly maxSerializedBytes?: number
  })
  {
    const coalescerScope = yield* Effect.scope
    const budget = yield* makeLiveStreamBudget(options)
    const cleanupComplete = yield* Deferred.make<void>()
    const input = yield* Queue.unbounded<
      RetainedLiveItem<ThreadLiveInput>,
      OrchestrationGetSnapshotError
    >()
    const output = yield* Queue.unbounded<
      RetainedLiveItem<OrchestrationThreadStreamItem>,
      OrchestrationGetSnapshotError
    >()
    const mutex = yield* Semaphore.make(1)
    const coalesceWindow = options?.coalesceWindow ?? COALESCE_WINDOW
    let pendingUpdates: Array<RetainedLiveItem<ThreadLiveInput>> = []
    const toolStatuses = new Map<string, string>()
    let windowGeneration = 0
    let windowFiber: Fiber.Fiber<void, never> | null = null
    let closed = false

    const cancelWindow = Effect.fn('ThreadLiveEventCoalescer.cancelWindow')(function* ()
    {
      const fiber = windowFiber
      if (fiber === null)
      {
        return
      }
      windowFiber = null
      yield* Fiber.interrupt(fiber)
    })

    const flushPending = Effect.fn('ThreadLiveEventCoalescer.flushPending')(function* ()
    {
      if (pendingUpdates.length === 0)
      {
        return
      }
      const previous = pendingUpdates
      pendingUpdates = []
      const items = yield* budget.replace(
        previous,
        coalescePendingToolUpdates(
          previous.flatMap((item) => (item.value.kind === 'event' ? [item.value.event] : [])),
        ).map((event) => ({
          kind: 'event' as const,
          event: projectActivityEvent(event),
        })),
        (item) => item.event,
      )
      yield* Queue.offerAll(output, items)
    }, Effect.uninterruptible)

    const flushWindow = (generation: number) =>
      Effect.sleep(coalesceWindow).pipe(
        Effect.andThen(
          mutex.withPermits(1)(
            Effect.suspend(() => (generation === windowGeneration ? flushPending() : Effect.void)),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() =>
          {
            if (generation === windowGeneration)
            {
              windowFiber = null
            }
          }),
        ),
        Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
      )

    const processAll = Effect.fn('ThreadLiveEventCoalescer.processAll')(function* (
      inputs: ReadonlyArray<RetainedLiveItem<ThreadLiveInput>>,
    )
    {
      yield* mutex.withPermits(1)(
        Effect.forEach(
          inputs,
          (retainedInput) =>
            Effect.gen(function* ()
            {
              yield* budget.check
              const liveInput = retainedInput.value
              if (
                liveInput.kind === 'event' &&
                isCoalescibleToolUpdate(liveInput.event, toolStatuses)
              )
              {
                pendingUpdates.push(retainedInput)
                if (pendingUpdates.length === 1)
                {
                  const generation = ++windowGeneration
                  windowFiber = yield* Effect.forkIn(flushWindow(generation), coalescerScope)
                }
                if (pendingUpdates.length >= MAX_PENDING_UPDATES)
                {
                  yield* cancelWindow()
                  windowGeneration += 1
                  yield* flushPending()
                }
                return
              }

              yield* cancelWindow()
              windowGeneration += 1
              yield* flushPending()
              if (liveInput.kind === 'synchronized')
              {
                toolStatuses.clear()
              }
              const values: ReadonlyArray<OrchestrationThreadStreamItem> =
                liveInput.kind === 'synchronized'
                  ? [{ kind: 'synchronized' }]
                  : [
                      {
                        kind: 'event',
                        event: projectActivityEvent(liveInput.event),
                      },
                    ]
              const items = yield* budget.replace([retainedInput], values, (item) =>
                item.kind === 'event' ? item.event : item,
              )
              yield* Queue.offerAll(output, items)
            }),
          { discard: true },
        ),
      )
    })

    const close = (error?: OrchestrationGetSnapshotError) =>
      mutex.withPermits(1)(
        Effect.gen(function* ()
        {
          if (closed)
          {
            return
          }
          closed = true
          windowGeneration += 1
          yield* cancelWindow()
          budget.release(pendingUpdates)
          pendingUpdates = []
          budget.release(yield* Queue.clear(input).pipe(Effect.orDie))
          budget.release(yield* Queue.clear(output).pipe(Effect.orDie))
          if (error !== undefined)
          {
            yield* Queue.fail(input, error)
            yield* Queue.fail(output, error)
          }
          yield* Queue.shutdown(input)
          yield* Queue.shutdown(output)
          yield* Deferred.succeed(cleanupComplete, undefined)
        }),
      )

    const admit = (liveInput: ThreadLiveInput): boolean =>
    {
      if (closed)
      {
        return false
      }
      const payload = liveInput.kind === 'event' ? liveInput.event : liveInput
      const retained = budget.retainUnsafe(liveInput, payload)
      if (Result.isFailure(retained))
      {
        return false
      }
      if (Queue.offerUnsafe(input, retained.success))
      {
        return true
      }
      budget.release([retained.success])
      budget.failUnsafe(
        new OrchestrationGetSnapshotError({
          message: 'The live event buffer closed before delivery.',
        }),
      )
      return false
    }

    const offer = (liveInput: ThreadLiveInput) =>
      Effect.suspend(() => (admit(liveInput) ? Effect.void : budget.check))

    yield* Effect.addFinalizer(() => close())
    yield* budget.failed.pipe(
      Effect.catchTags({ OrchestrationGetSnapshotError: close }),
      Effect.forkScoped,
    )
    yield* Stream.fromQueue(input).pipe(
      Stream.runForEachArray(processAll),
      Effect.raceFirst(budget.failed),
      Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
      Effect.forkScoped,
    )

    return {
      admit,
      offer,
      offerAll: (inputs: ReadonlyArray<ThreadLiveInput>) =>
        Effect.forEach(inputs, offer, { discard: true }),
      stream: budget.deliver(Stream.fromQueue(output)),
      failed: budget.failed,
      closed: Deferred.await(cleanupComplete),
      usage: budget.usage,
    } as const
  },
)
