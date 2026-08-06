// packages/shared/src/DrainableWorker.ts
// define drainable worker

// wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
// a signal that resolves when the queue is empty **and** the current item
// has finished processing. This lets tests replace timing-sensitive
// `Effect.sleep` calls with deterministic `drain()`.
//
// @module DrainableWorker
import * as Scope from 'effect/Scope'
import * as Effect from 'effect/Effect'
import * as TxQueue from 'effect/TxQueue'
import * as TxRef from 'effect/TxRef'

export interface DrainableWorker<A>
{
  // enqueue a work item and track it for `drain()`.
  //
  // this wraps `Queue.offer` so drain state is updated atomically with the
  // enqueue path instead of inferring it from queue internals.
  readonly enqueue: (item: A) => Effect.Effect<void>

  // resolves when the queue is empty and the worker is idle (not processing).
  readonly drain: Effect.Effect<void>
}

// create a drainable worker that processes items from an unbounded queue.
//
// the worker is forked into the current scope and will be interrupted when
// the scope closes. A finalizer shuts down the queue.
//
// @param process - The effect to run for each queued item.
// @returns A `DrainableWorker` with `queue` and `drain`.
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* ()
  {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown)
    const outstanding = yield* TxRef.make(0)

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((a) =>
        process(a).pipe(
          Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)),
          Effect.ignoreCause,
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )

    const drain: DrainableWorker<A>['drain'] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    )

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      )

    return { enqueue, drain } satisfies DrainableWorker<A>
  })
