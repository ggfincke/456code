// tests/apps/mobile/connection/environment-cleanup.test.ts
// verifies durable mobile environment cleanup transitions and retry isolation

import { describe, expect, it } from '@effect/vitest'
import { EnvironmentId } from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'

import {
  createEnvironmentCleanup,
  environmentCleanupRetryDelayMs,
} from '../../../../apps/mobile/src/connection/environment-cleanup'
import {
  MobileDatabase,
  type StoredEnvironmentCleanupIntent,
} from '../../../../apps/mobile/src/persistence/mobile-database'

function makeHarness()
{
  const intents = new Map<string, StoredEnvironmentCleanupIntent>()
  const calls: Array<string> = []
  const failures = new Set<string>()
  const manualReports: Array<StoredEnvironmentCleanupIntent> = []
  let currentTime = 1_000

  const database = MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.succeed(Option.none()),
    savePreferencesJson: () => Effect.void,
    loadEnvironmentCleanupIntents: Effect.sync(() => [...intents.values()]),
    prepareEnvironmentCleanup: (environmentId, requestedAtEpochMs) =>
      Effect.sync(() =>
      {
        const existing = intents.get(environmentId)
        const generation = (existing?.generation ?? 0) + 1
        intents.set(environmentId, {
          environmentId,
          schemaVersion: 2,
          generation,
          requestedAtEpochMs,
          cacheState: 'pending',
          outboxState: 'pending',
          draftsState: 'pending',
          attempts: 0,
          nextAttemptAtEpochMs: requestedAtEpochMs,
          lastAttemptAtEpochMs: null,
          lastError: null,
        })
        return generation
      }),
    markEnvironmentCleanupResourceComplete: (environmentId, resource, generation) =>
      Effect.sync(() =>
      {
        const intent = intents.get(environmentId)
        if (intent === undefined || intent.generation !== generation) return
        intents.set(environmentId, {
          ...intent,
          ...(resource === 'cache' ? { cacheState: 'complete' as const } : {}),
          ...(resource === 'outbox' ? { outboxState: 'complete' as const } : {}),
          ...(resource === 'drafts' ? { draftsState: 'complete' as const } : {}),
        })
      }),
    recordEnvironmentCleanupAttempt: (
      environmentId,
      generation,
      attempts,
      attemptedAtEpochMs,
      nextAttemptAtEpochMs,
      lastError,
    ) =>
      Effect.sync(() =>
      {
        const intent = intents.get(environmentId)
        if (intent === undefined || intent.generation !== generation) return
        intents.set(environmentId, {
          ...intent,
          attempts,
          lastAttemptAtEpochMs: attemptedAtEpochMs,
          nextAttemptAtEpochMs,
          lastError,
        })
      }),
    pruneCompletedEnvironmentCleanupIntent: (environmentId, generation) =>
      Effect.sync(() =>
      {
        const intent = intents.get(environmentId)
        if (
          intent?.generation === generation &&
          intent.cacheState === 'complete' &&
          intent.outboxState === 'complete' &&
          intent.draftsState === 'complete'
        )
        {
          intents.delete(environmentId)
        }
      }),
  })

  const resource = (name: 'cache' | 'drafts') => (environmentId: EnvironmentId) =>
    Effect.sync(() => calls.push(`${name}:${environmentId}`)).pipe(
      Effect.flatMap(() =>
        failures.has(`${name}:${environmentId}`)
          ? Effect.fail(new Error(`${name} failed`))
          : Effect.void,
      ),
    )
  const cleanup = createEnvironmentCleanup(
    database,
    {
      cache: resource('cache'),
      outbox: (environmentId) =>
        Effect.sync(() =>
        {
          calls.push(`outbox:${environmentId}`)
          return failures.has(`outbox:${environmentId}`)
            ? { complete: false as const, remainingMessageCount: 1 }
            : { complete: true as const, remainingMessageCount: 0 as const }
        }),
      drafts: resource('drafts'),
    },
    {
      now: () => currentTime,
      reportManualState: (intent) =>
        Effect.sync(() =>
        {
          manualReports.push(intent)
        }),
    },
  )

  return {
    cleanup,
    intents,
    calls,
    failures,
    manualReports,
    setTime: (value: number) =>
    {
      currentTime = value
    },
  }
}

describe('mobile environment cleanup', () =>
{
  it.effect('keeps a prepared active environment untouched until catalog removal', () =>
    Effect.gen(function* ()
    {
      const harness = makeHarness()
      const environmentId = EnvironmentId.make('environment-1')

      yield* harness.cleanup.prepare(environmentId)
      yield* harness.cleanup.retry(new Set([environmentId]))
      expect(harness.calls).toEqual([])
      expect(harness.intents.has(environmentId)).toBe(true)

      yield* harness.cleanup.retry(new Set())
      expect(harness.calls).toEqual([
        'cache:environment-1',
        'outbox:environment-1',
        'drafts:environment-1',
      ])
      expect(harness.intents.has(environmentId)).toBe(false)
    }),
  )

  it.effect('rechecks registration through the lease after retry selection', () =>
    Effect.gen(function* ()
    {
      const harness = makeHarness()
      const environmentId = EnvironmentId.make('environment-reregistered')
      const cleanupSelected = yield* Deferred.make<void>()
      const continueCleanup = yield* Deferred.make<void>()
      const registered = yield* Ref.make(false)
      yield* harness.cleanup.prepare(environmentId)

      const retry = yield* Effect.forkChild(
        harness.cleanup.retry(new Set(), {
          run: (_environmentId, cleanup) =>
            Deferred.succeed(cleanupSelected, undefined).pipe(
              Effect.andThen(Deferred.await(continueCleanup)),
              Effect.andThen(Ref.get(registered)),
              Effect.flatMap((isRegistered) => (isRegistered ? Effect.void : cleanup)),
            ),
        }),
        { startImmediately: true },
      )

      yield* Deferred.await(cleanupSelected)
      yield* Ref.set(registered, true)
      yield* Deferred.succeed(continueCleanup, undefined)
      yield* Fiber.join(retry)

      expect(harness.calls).toEqual([])
      expect(harness.intents.has(environmentId)).toBe(true)
    }),
  )

  it.effect('tracks resources independently and retries only pending work', () =>
    Effect.gen(function* ()
    {
      const harness = makeHarness()
      const environmentId = EnvironmentId.make('environment-1')
      harness.failures.add('outbox:environment-1')
      yield* harness.cleanup.prepare(environmentId)
      yield* harness.cleanup.retry(new Set())

      expect(harness.intents.get(environmentId)).toMatchObject({
        cacheState: 'complete',
        outboxState: 'pending',
        draftsState: 'complete',
        attempts: 1,
      })
      harness.failures.clear()
      harness.setTime(harness.intents.get(environmentId)!.nextAttemptAtEpochMs)
      yield* harness.cleanup.retry(new Set())

      expect(harness.calls.filter((call) => call.startsWith('cache:'))).toHaveLength(1)
      expect(harness.calls.filter((call) => call.startsWith('drafts:'))).toHaveLength(1)
      expect(harness.calls.filter((call) => call.startsWith('outbox:'))).toHaveLength(2)
      expect(harness.intents.has(environmentId)).toBe(false)
    }),
  )

  it.effect('keeps each failed resource pending without rolling back completed resources', () =>
    Effect.gen(function* ()
    {
      for (const failedResource of ['cache', 'outbox', 'drafts'] as const)
      {
        const harness = makeHarness()
        const environmentId = EnvironmentId.make(`environment-${failedResource}`)
        harness.failures.add(`${failedResource}:${environmentId}`)

        yield* harness.cleanup.prepare(environmentId)
        yield* harness.cleanup.retry(new Set())

        const intent = harness.intents.get(environmentId)!
        expect(intent.cacheState).toBe(failedResource === 'cache' ? 'pending' : 'complete')
        expect(intent.outboxState).toBe(failedResource === 'outbox' ? 'pending' : 'complete')
        expect(intent.draftsState).toBe(failedResource === 'drafts' ? 'pending' : 'complete')
      }
    }),
  )

  it.effect('uses exact environment ids and never invokes registration behavior', () =>
    Effect.gen(function* ()
    {
      const harness = makeHarness()
      const first = EnvironmentId.make('environment-1')
      const tenth = EnvironmentId.make('environment-10')
      yield* harness.cleanup.prepare(first)
      yield* harness.cleanup.prepare(tenth)
      yield* harness.cleanup.retry(new Set([first]))

      expect(harness.calls.every((call) => call.endsWith('environment-10'))).toBe(true)
      expect(harness.intents.has(first)).toBe(true)
      expect(harness.intents.has(tenth)).toBe(false)
    }),
  )

  it.effect('retains manual-state records and permits later retries', () =>
    Effect.gen(function* ()
    {
      const harness = makeHarness()
      const environmentId = EnvironmentId.make('environment-1')
      harness.failures.add('cache:environment-1')
      yield* harness.cleanup.prepare(environmentId)

      for (let attempt = 1; attempt <= 8; attempt += 1)
      {
        yield* harness.cleanup.retry(new Set())
        const intent = harness.intents.get(environmentId)!
        expect(intent.attempts).toBe(attempt)
        harness.setTime(intent.nextAttemptAtEpochMs)
      }
      expect(harness.manualReports).toHaveLength(1)
      expect(harness.intents.has(environmentId)).toBe(true)

      harness.failures.clear()
      yield* harness.cleanup.retry(new Set())
      expect(harness.intents.has(environmentId)).toBe(false)
    }),
  )

  it.effect('processes at most eight intent records per trigger', () =>
    Effect.gen(function* ()
    {
      const harness = makeHarness()
      for (let index = 0; index < 10; index += 1)
      {
        yield* harness.cleanup.prepare(EnvironmentId.make(`environment-${index}`))
      }

      yield* harness.cleanup.retry(new Set())

      expect(harness.intents.size).toBe(2)
      expect(harness.calls).toHaveLength(24)
    }),
  )

  it('uses the persisted bounded retry schedule', () =>
  {
    expect([1, 2, 3, 4, 5, 8].map(environmentCleanupRetryDelayMs)).toEqual([
      60_000, 300_000, 1_800_000, 21_600_000, 21_600_000, 21_600_000,
    ])
  })
})
