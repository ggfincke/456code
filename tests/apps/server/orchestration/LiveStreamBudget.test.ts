// tests/apps/server/orchestration/LiveStreamBudget.test.ts
// verifies live subscription accounting through acknowledgement

import { it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as Stream from 'effect/Stream'
import { describe, expect } from 'vite-plus/test'

import {
  makeLiveStreamBudget,
  type RetainedLiveItem,
} from '../../../../apps/server/src/orchestration/LiveStreamBudget.ts'

describe('LiveStreamBudget', () =>
{
  it.effect('keeps the unacknowledged batch charged while clearing later live data', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const budget = yield* makeLiveStreamBudget({ maxItems: 3 })
        const queue = yield* Queue.unbounded<RetainedLiveItem<{ text: string }>>()
        const sourceClosed = yield* Deferred.make<void>()
        const first = yield* budget.retain({ text: 'first' })
        const second = yield* budget.retain({ text: 'second' })
        const third = yield* budget.retain({ text: 'third' })
        yield* Queue.offerAll(queue, [first, second, third])

        yield* Effect.scoped(
          Effect.gen(function* ()
          {
            const pull = yield* Stream.toPull(
              budget.deliver(
                Stream.fromQueue(queue).pipe(
                  Stream.rechunk(1),
                  Stream.ensuring(Deferred.succeed(sourceClosed, undefined)),
                ),
              ),
            )
            expect(yield* pull).toEqual([{ text: 'first' }])
            expect(yield* Queue.size(queue)).toBe(0)
            expect((yield* budget.usage).retainedItems).toBe(3)

            const overflow = budget.retainUnsafe({ text: 'fourth' })
            expect(Result.isFailure(overflow)).toBe(true)
            yield* Deferred.await(sourceClosed)
            yield* budget.closed
            expect((yield* budget.usage).retainedItems).toBe(1)
          }),
        )
        expect(yield* budget.usage).toEqual({
          retainedItems: 0,
          retainedSerializedBytes: 0,
        })
      }),
    ),
  )
})
