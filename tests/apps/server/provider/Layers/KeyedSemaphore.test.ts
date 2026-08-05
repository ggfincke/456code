// tests/apps/server/provider/Layers/KeyedSemaphore.test.ts
// verifies keyed semaphore serialization and idle-entry reclamation

import { assert, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'

import { makeKeyedSemaphore } from '../../../../../apps/server/src/provider/Layers/KeyedSemaphore.ts'

const yieldRepeatedly = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
})

it.effect('reclaims every key after high-cardinality one-shot churn', () =>
  Effect.gen(function* ()
  {
    const keyedSemaphore = yield* makeKeyedSemaphore<string>()

    yield* Effect.forEach(
      Array.from({ length: 1_000 }, (_, index) => `thread-${index}`),
      (key) => keyedSemaphore.withPermit(key, Effect.void),
      { concurrency: 'unbounded', discard: true },
    )

    assert.equal(yield* keyedSemaphore.activeKeyCount, 0)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 0)
  }),
)

it.effect('keeps one semaphore alive across queued handoff and serializes late arrivals', () =>
  Effect.gen(function* ()
  {
    const keyedSemaphore = yield* makeKeyedSemaphore<string>()
    const holderEntered = yield* Deferred.make<void>()
    const releaseHolder = yield* Deferred.make<void>()
    const queuedEntered = yield* Deferred.make<void>()
    const releaseQueued = yield* Deferred.make<void>()
    const lateEntered = yield* Deferred.make<void>()

    const holderFiber = yield* keyedSemaphore
      .withPermit(
        'shared-thread',
        Deferred.succeed(holderEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseHolder)),
        ),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(holderEntered)

    const queuedFiber = yield* keyedSemaphore
      .withPermit(
        'shared-thread',
        Deferred.succeed(queuedEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseQueued)),
        ),
      )
      .pipe(Effect.forkChild)
    yield* yieldRepeatedly

    assert.equal(yield* keyedSemaphore.activeKeyCount, 1)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 2)

    yield* Deferred.succeed(releaseHolder, undefined)
    yield* Deferred.await(queuedEntered)
    yield* Fiber.join(holderFiber)

    assert.equal(yield* keyedSemaphore.activeKeyCount, 1)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 1)

    const lateFiber = yield* keyedSemaphore
      .withPermit('shared-thread', Deferred.succeed(lateEntered, undefined))
      .pipe(Effect.forkChild)
    yield* yieldRepeatedly

    assert.isFalse(yield* Deferred.isDone(lateEntered))
    assert.equal(yield* keyedSemaphore.activeKeyCount, 1)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 2)

    yield* Deferred.succeed(releaseQueued, undefined)
    yield* Fiber.join(queuedFiber)
    yield* Fiber.join(lateFiber)

    assert.isTrue(yield* Deferred.isDone(lateEntered))
    assert.equal(yield* keyedSemaphore.activeKeyCount, 0)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 0)
  }),
)

it.effect('releases an interrupted waiter lease without disturbing the holder', () =>
  Effect.gen(function* ()
  {
    const keyedSemaphore = yield* makeKeyedSemaphore<string>()
    const holderEntered = yield* Deferred.make<void>()
    const releaseHolder = yield* Deferred.make<void>()

    const holderFiber = yield* keyedSemaphore
      .withPermit(
        'interrupted-thread',
        Deferred.succeed(holderEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseHolder)),
        ),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(holderEntered)

    const waitingFiber = yield* keyedSemaphore
      .withPermit('interrupted-thread', Effect.never)
      .pipe(Effect.forkChild)
    yield* yieldRepeatedly
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 2)

    yield* Fiber.interrupt(waitingFiber)
    assert.equal(yield* keyedSemaphore.activeKeyCount, 1)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 1)

    yield* Deferred.succeed(releaseHolder, undefined)
    yield* Fiber.join(holderFiber)
    assert.equal(yield* keyedSemaphore.activeKeyCount, 0)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 0)
  }),
)

it.effect('reclaims keys after failures, defects, and active-holder interruption', () =>
  Effect.gen(function* ()
  {
    const keyedSemaphore = yield* makeKeyedSemaphore<string>()

    yield* keyedSemaphore
      .withPermit('typed-failure', Effect.fail('expected failure'))
      .pipe(Effect.exit)
    yield* keyedSemaphore.withPermit('defect', Effect.die('expected defect')).pipe(Effect.exit)

    const holderEntered = yield* Deferred.make<void>()
    const holderFiber = yield* keyedSemaphore
      .withPermit(
        'interrupted-holder',
        Deferred.succeed(holderEntered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(holderEntered)
    yield* Fiber.interrupt(holderFiber)

    assert.equal(yield* keyedSemaphore.activeKeyCount, 0)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 0)
  }),
)

it.effect('allows unrelated keys to enter concurrently', () =>
  Effect.gen(function* ()
  {
    const keyedSemaphore = yield* makeKeyedSemaphore<string>()
    const firstEntered = yield* Deferred.make<void>()
    const releaseFirst = yield* Deferred.make<void>()
    const secondEntered = yield* Deferred.make<void>()

    const firstFiber = yield* keyedSemaphore
      .withPermit(
        'first-thread',
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(firstEntered)

    yield* keyedSemaphore.withPermit('second-thread', Deferred.succeed(secondEntered, undefined))

    assert.isTrue(yield* Deferred.isDone(secondEntered))
    assert.equal(yield* keyedSemaphore.activeKeyCount, 1)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 1)

    yield* Deferred.succeed(releaseFirst, undefined)
    yield* Fiber.join(firstFiber)
    assert.equal(yield* keyedSemaphore.activeKeyCount, 0)
    assert.equal(yield* keyedSemaphore.activeLeaseCount, 0)
  }),
)
