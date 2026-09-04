// apps/server/src/orchestration/LiveStreamBudget.ts
// bounds retained live stream data through client acknowledgement

import { OrchestrationGetSnapshotError } from '@t3tools/contracts'
import * as Arr from 'effect/Array'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Result from 'effect/Result'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

export const LIVE_STREAM_MAX_ITEMS = 1_000
export const LIVE_STREAM_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024

export interface RetainedLiveItem<A>
{
  readonly value: A
  readonly serializedBytes: number
}

// published events are immutable and shared across subscriptions
const serializedSizes = new WeakMap<object, number>()

function serializedSize(value: object): number
{
  const cached = serializedSizes.get(value)
  if (cached !== undefined)
  {
    return cached
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined)
  {
    throw new TypeError('Live stream payload is not JSON serializable.')
  }
  const bytes = Buffer.byteLength(serialized)
  serializedSizes.set(value, bytes)
  return bytes
}

// one budget owns all retained live data for one RPC subscription
export const makeLiveStreamBudget = Effect.fn('makeLiveStreamBudget')(function* (limits?: {
  readonly maxItems?: number
  readonly maxSerializedBytes?: number
})
{
  const budgetScope = yield* Effect.scope
  const maxItems = limits?.maxItems ?? LIVE_STREAM_MAX_ITEMS
  const maxSerializedBytes = limits?.maxSerializedBytes ?? LIVE_STREAM_MAX_SERIALIZED_BYTES
  const failed = yield* Deferred.make<never, OrchestrationGetSnapshotError>()
  const cleanupComplete = yield* Deferred.make<void>()
  let failure: OrchestrationGetSnapshotError | undefined
  let overflowUsage:
    | {
        readonly nextItems: number
        readonly nextSerializedBytes: number
      }
    | undefined
  const retained = new Set<RetainedLiveItem<unknown>>()
  const acknowledgementInFlight = new Set<RetainedLiveItem<unknown>>()
  let retainedSerializedBytes = 0

  const release = (items: Iterable<RetainedLiveItem<unknown>>) =>
  {
    for (const item of items)
    {
      if (!retained.delete(item))
      {
        continue
      }
      retainedSerializedBytes -= item.serializedBytes
    }
  }

  const failUnsafe = (error: OrchestrationGetSnapshotError): OrchestrationGetSnapshotError =>
  {
    if (failure === undefined)
    {
      failure = error
      Deferred.doneUnsafe(failed, Effect.fail(error))
    }
    return failure
  }

  const overflowUnsafe = (
    nextItems: number,
    nextSerializedBytes: number,
  ): OrchestrationGetSnapshotError =>
  {
    overflowUsage ??= { nextItems, nextSerializedBytes }
    return failUnsafe(
      new OrchestrationGetSnapshotError({
        message: 'The live event buffer is full. Resume from the last received sequence.',
      }),
    )
  }

  const measure = (payload: object): Result.Result<number, OrchestrationGetSnapshotError> =>
  {
    try
    {
      return Result.succeed(serializedSize(payload))
    }
    catch (cause)
    {
      return Result.fail(
        failUnsafe(
          new OrchestrationGetSnapshotError({
            message: 'Failed to measure a live event payload.',
            cause,
          }),
        ),
      )
    }
  }

  const retainUnsafe = <A extends object>(
    value: A,
    payload: object = value,
  ): Result.Result<RetainedLiveItem<A>, OrchestrationGetSnapshotError> =>
  {
    if (failure !== undefined)
    {
      return Result.fail(failure)
    }
    const measured = measure(payload)
    if (Result.isFailure(measured))
    {
      return Result.fail(measured.failure)
    }
    const nextItems = retained.size + 1
    const nextSerializedBytes = retainedSerializedBytes + measured.success
    if (nextItems > maxItems || nextSerializedBytes > maxSerializedBytes)
    {
      return Result.fail(overflowUnsafe(nextItems, nextSerializedBytes))
    }
    const item = { value, serializedBytes: measured.success }
    retained.add(item)
    retainedSerializedBytes = nextSerializedBytes
    return Result.succeed(item)
  }

  const retain = <A extends object>(value: A, payload: object = value) =>
    Effect.suspend(() =>
      Result.match(retainUnsafe(value, payload), {
        onFailure: Effect.fail,
        onSuccess: Effect.succeed,
      }),
    )

  // raw and projected values share one counter across coalescing
  const replace = <A extends object>(
    previous: ReadonlyArray<RetainedLiveItem<unknown>>,
    values: ReadonlyArray<A>,
    payload: (value: A) => object = (value) => value,
  ) =>
    Effect.suspend(() =>
    {
      if (failure !== undefined)
      {
        return Effect.fail(failure)
      }
      const next: Array<RetainedLiveItem<A>> = []
      for (const value of values)
      {
        const measured = measure(payload(value))
        if (Result.isFailure(measured))
        {
          return Effect.fail(measured.failure)
        }
        next.push({ value, serializedBytes: measured.success })
      }
      let nextItems = retained.size + next.length
      let nextSerializedBytes =
        retainedSerializedBytes + next.reduce((sum, item) => sum + item.serializedBytes, 0)
      for (const item of previous)
      {
        if (retained.has(item))
        {
          nextItems -= 1
          nextSerializedBytes -= item.serializedBytes
        }
      }
      if (nextItems > maxItems || nextSerializedBytes > maxSerializedBytes)
      {
        return Effect.fail(overflowUnsafe(nextItems, nextSerializedBytes))
      }
      release(previous)
      for (const item of next)
      {
        retained.add(item)
      }
      retainedSerializedBytes = nextSerializedBytes
      return Effect.succeed(next)
    })

  const check = Effect.suspend(() => (failure === undefined ? Effect.void : Effect.fail(failure)))

  const deliver = <A, E, R>(stream: Stream.Stream<RetainedLiveItem<A>, E, R>) =>
    Stream.fromPull(
      Effect.gen(function* ()
      {
        yield* check
        const sourceScope = yield* Scope.fork(budgetScope)
        const source = {
          pull: yield* Stream.toPull(stream).pipe(Scope.provide(sourceScope)),
        }
        let inFlight: ReadonlyArray<RetainedLiveItem<A>> = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
          {
            release(inFlight)
            for (const item of inFlight)
            {
              acknowledgementInFlight.delete(item)
            }
            inFlight = []
            source.pull = Effect.interrupt
          }),
        )
        yield* Deferred.await(failed).pipe(
          Effect.catchTags({
            OrchestrationGetSnapshotError: (error) =>
              Effect.sync(() =>
              {
                source.pull = Effect.interrupt
              }).pipe(Effect.andThen(Scope.close(sourceScope, Exit.fail(error)))),
          }),
          Effect.forkScoped,
        )
        // @effect-diagnostics-next-line returnEffectInGen:off - Stream.fromPull needs the pull effect as its result.
        return Effect.gen(function* ()
        {
          // the RPC server asks for the next pull only after acknowledging this one
          release(inFlight)
          for (const item of inFlight)
          {
            acknowledgementInFlight.delete(item)
          }
          inFlight = []
          yield* check
          const items = yield* Effect.raceFirst(source.pull, Deferred.await(failed))
          yield* check
          inFlight = items
          for (const item of items)
          {
            acknowledgementInFlight.add(item)
          }
          return Arr.map(items, (item) => item.value)
        })
      }),
    ).pipe(Stream.scoped)

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => release(retained)).pipe(
      Effect.andThen(Deferred.succeed(cleanupComplete, undefined)),
    ),
  )
  yield* Deferred.await(failed).pipe(
    Effect.catchTags({
      OrchestrationGetSnapshotError: (error) =>
        Effect.logWarning('orchestration live event buffer failed', {
          error,
          retainedItems: retained.size,
          retainedSerializedBytes,
          maxItems,
          maxSerializedBytes,
          ...overflowUsage,
        }).pipe(
          Effect.andThen(
            Effect.sync(() =>
            {
              for (const item of retained)
              {
                if (!acknowledgementInFlight.has(item))
                {
                  release([item])
                }
              }
            }),
          ),
          Effect.andThen(Deferred.succeed(cleanupComplete, undefined)),
        ),
    }),
    Effect.forkScoped,
  )

  return {
    retain,
    retainUnsafe,
    replace,
    release,
    failUnsafe,
    deliver,
    check,
    failed: Deferred.await(failed),
    closed: Deferred.await(cleanupComplete),
    usage: Effect.sync(() => ({ retainedItems: retained.size, retainedSerializedBytes })),
  } as const
})
