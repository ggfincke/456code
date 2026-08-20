// tests/apps/server/sourceControl/SourceControlRateLimit.test.ts
// verifies provider rate-limit pauses and concurrency leases

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import * as SourceControlRateLimit from '../../../../apps/server/src/sourceControl/SourceControlRateLimit.ts'

const github = { provider: 'github' as const, host: 'github.com' }

it('parses Retry-After seconds and HTTP dates', () =>
{
  assert.equal(SourceControlRateLimit.retryAtFromHeader('120', 1_000), 121_000)
  assert.equal(
    SourceControlRateLimit.retryAtFromHeader('Thu, 01 Jan 1970 00:02:01 GMT', 1_000),
    121_000,
  )
  assert.isUndefined(SourceControlRateLimit.retryAtFromHeader('later', 1_000))
})

it.effect('backs off repeated rate limits and resets after a later success', () =>
  Effect.gen(function* ()
  {
    yield* TestClock.setTime(0)
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit

    const firstLease = yield* limits.check(github)
    yield* limits.recordRateLimit({ ...github, lease: firstLease })
    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 30_000)

    yield* TestClock.adjust('30 seconds')
    const secondLease = yield* limits.check(github)
    yield* limits.recordRateLimit({ ...github, lease: secondLease })
    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 90_000)

    yield* TestClock.adjust('60 seconds')
    const successLease = yield* limits.check(github)
    yield* limits.recordSuccess({ ...github, lease: successLease })
    const resetLease = yield* limits.check(github)
    yield* limits.recordRateLimit({ ...github, lease: resetLease })
    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 120_000)
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
)

it.effect('allows interactive work without clearing or shortening an active pause', () =>
  Effect.gen(function* ()
  {
    yield* TestClock.setTime(1_000)
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit
    const lease = yield* limits.check(github)
    yield* limits.recordRateLimit({ ...github, lease, retryAt: 121_000 })

    const interactiveLease = yield* limits.check(github, { allowPaused: true })
    yield* limits.recordSuccess({ ...github, lease: interactiveLease })
    yield* limits.recordRateLimit({ ...github, lease: interactiveLease, retryAt: 61_000 })

    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 121_000)
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
)

it.effect('isolates providers and rejects an older success clearing a concurrent pause', () =>
  Effect.gen(function* ()
  {
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit
    const firstLease = yield* limits.check(github)
    const concurrentLease = yield* limits.check(github)
    yield* limits.recordRateLimit({ ...github, lease: firstLease })
    yield* limits.recordSuccess({ ...github, lease: concurrentLease })

    assert.equal((yield* Effect.flip(limits.check(github))).retryAt, 30_000)
    assert.equal(yield* limits.check({ provider: 'gitlab', host: 'github.com' }), 0)
    assert.equal(yield* limits.check({ provider: 'github', host: 'github.example.com' }), 0)
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
)
