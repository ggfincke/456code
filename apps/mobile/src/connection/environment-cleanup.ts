// apps/mobile/src/connection/environment-cleanup.ts
// retries durable environment-owned data cleanup without restoring catalog state

import type {
  EnvironmentOwnedDataCleanupLease,
  EnvironmentOwnedDataResource,
} from '@t3tools/client-runtime/platform'
import type { EnvironmentId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'

import type {
  MobileDatabase,
  MobileDatabaseError,
  StoredEnvironmentCleanupIntent,
} from '../persistence/mobile-database'
import type { ThreadOutboxEnvironmentCleanupResult } from '../state/thread-outbox-manager'

const MAX_RECORDS_PER_TRIGGER = 8
const RETRY_CONCURRENCY = 2
const MANUAL_STATE_ATTEMPTS = 8
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000] as const

export interface EnvironmentCleanupResources
{
  readonly cache: (environmentId: EnvironmentId) => Effect.Effect<void, unknown>
  readonly outbox: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<ThreadOutboxEnvironmentCleanupResult, unknown>
  readonly drafts: (environmentId: EnvironmentId) => Effect.Effect<void, unknown>
}

export interface EnvironmentCleanupAttemptReport
{
  readonly environmentId: EnvironmentId
  readonly attemptedResources: ReadonlyArray<EnvironmentOwnedDataResource>
  readonly complete: boolean
  readonly manual: boolean
  readonly errors: ReadonlyArray<string>
}

export interface EnvironmentCleanupOptions
{
  readonly now?: () => number
  readonly reportManualState?: (intent: StoredEnvironmentCleanupIntent) => Effect.Effect<void>
}

function resourceState(
  intent: StoredEnvironmentCleanupIntent,
  resource: EnvironmentOwnedDataResource,
): 'pending' | 'complete'
{
  switch (resource)
  {
    case 'cache':
      return intent.cacheState
    case 'outbox':
      return intent.outboxState
    case 'drafts':
      return intent.draftsState
  }
}

function errorMessage(cause: unknown): string
{
  return cause instanceof Error ? cause.message : String(cause)
}

export function environmentCleanupRetryDelayMs(attempts: number): number
{
  const index = Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1
  return RETRY_DELAYS_MS[index]
}

export function createEnvironmentCleanup(
  database: MobileDatabase['Service'],
  resources: EnvironmentCleanupResources,
  options: EnvironmentCleanupOptions = {},
)
{
  const now = options.now ?? Date.now
  const reportManualState =
    options.reportManualState ??
    ((intent: StoredEnvironmentCleanupIntent) =>
      Effect.logWarning('Mobile environment cleanup still requires manual attention.', {
        environmentId: intent.environmentId,
        attempts: intent.attempts,
        lastError: intent.lastError,
      }))

  const loadIntent = (
    environmentId: EnvironmentId,
  ): Effect.Effect<StoredEnvironmentCleanupIntent | undefined, MobileDatabaseError> =>
    database.loadEnvironmentCleanupIntents.pipe(
      Effect.map((intents) =>
        intents.find((candidate) => candidate.environmentId === environmentId),
      ),
    )

  // starts a new removal generation for the environment, whatever the previous
  // one left behind.
  const prepare = (environmentId: EnvironmentId): Effect.Effect<number, MobileDatabaseError> =>
  {
    const requestedAtEpochMs = now()
    return database.prepareEnvironmentCleanup(environmentId, requestedAtEpochMs)
  }

  const markComplete = (
    environmentId: EnvironmentId,
    resource: EnvironmentOwnedDataResource,
    generation: number,
  ): Effect.Effect<void, MobileDatabaseError> =>
    database
      .markEnvironmentCleanupResourceComplete(environmentId, resource, generation)
      .pipe(
        Effect.andThen(database.pruneCompletedEnvironmentCleanupIntent(environmentId, generation)),
      )

  // the caller holds the environment's removal lock but not a generation of its
  // own (the registry marks the cache resource this way), so the generation the
  // row currently carries is the one it just prepared.
  const markCurrentComplete = (
    environmentId: EnvironmentId,
    resource: EnvironmentOwnedDataResource,
  ): Effect.Effect<void, MobileDatabaseError> =>
    loadIntent(environmentId).pipe(
      Effect.flatMap((intent) =>
        intent === undefined
          ? Effect.void
          : markComplete(environmentId, resource, intent.generation),
      ),
    )

  const runResource = (
    environmentId: EnvironmentId,
    generation: number,
    resource: EnvironmentOwnedDataResource,
  ): Effect.Effect<string | null> =>
  {
    const cleanup = (() =>
    {
      switch (resource)
      {
        case 'cache':
          return resources.cache(environmentId)
        case 'outbox':
          return resources
            .outbox(environmentId)
            .pipe(
              Effect.flatMap((result) =>
                result.complete
                  ? Effect.void
                  : Effect.fail(
                      new Error(
                        `outbox cleanup incomplete with ${result.remainingMessageCount} message(s) remaining`,
                      ),
                    ),
              ),
            )
        case 'drafts':
          return resources.drafts(environmentId)
      }
    })()

    return cleanup.pipe(
      Effect.andThen(markComplete(environmentId, resource, generation)),
      Effect.match({
        onFailure: (cause) => errorMessage(cause),
        onSuccess: () => null,
      }),
    )
  }

  const runIntent = Effect.fn('EnvironmentCleanup.runIntent')(function* (
    intent: StoredEnvironmentCleanupIntent,
    allowedResources: ReadonlySet<EnvironmentOwnedDataResource>,
  )
  {
    const attemptedResources = (['cache', 'outbox', 'drafts'] as const).filter(
      (resource) => allowedResources.has(resource) && resourceState(intent, resource) === 'pending',
    )
    const results = yield* Effect.forEach(
      attemptedResources,
      (resource) => runResource(intent.environmentId, intent.generation, resource),
      { concurrency: 'unbounded' },
    )
    const errors = results.filter((result): result is string => result !== null)
    // an all-complete row is only retained until its prune lands, so a prune
    // that failed earlier is re-attempted here instead of leaving a finished
    // record that a later removal would have to re-arm.
    const pruneError = yield* database
      .pruneCompletedEnvironmentCleanupIntent(intent.environmentId, intent.generation)
      .pipe(
        Effect.match({
          onFailure: (cause) => errorMessage(cause),
          onSuccess: () => null,
        }),
      )
    if (pruneError !== null)
    {
      errors.push(pruneError)
    }
    const remaining = yield* loadIntent(intent.environmentId)
    if (remaining === undefined)
    {
      return {
        environmentId: intent.environmentId,
        attemptedResources,
        complete: true,
        manual: false,
        errors,
      } satisfies EnvironmentCleanupAttemptReport
    }

    const attemptedAtEpochMs = now()
    const attempts = remaining.attempts + 1
    const manual = attempts >= MANUAL_STATE_ATTEMPTS
    yield* database.recordEnvironmentCleanupAttempt(
      remaining.environmentId,
      remaining.generation,
      attempts,
      attemptedAtEpochMs,
      attemptedAtEpochMs + environmentCleanupRetryDelayMs(attempts),
      errors.length === 0 ? null : errors.join('; '),
    )
    if (manual)
    {
      yield* reportManualState({
        ...remaining,
        attempts,
        lastAttemptAtEpochMs: attemptedAtEpochMs,
        nextAttemptAtEpochMs: attemptedAtEpochMs + environmentCleanupRetryDelayMs(attempts),
        lastError: errors.length === 0 ? null : errors.join('; '),
      })
    }
    return {
      environmentId: intent.environmentId,
      attemptedResources,
      complete: false,
      manual,
      errors,
    } satisfies EnvironmentCleanupAttemptReport
  })

  const clear = (environmentId: EnvironmentId) =>
    loadIntent(environmentId).pipe(
      Effect.flatMap((intent) =>
        intent === undefined
          ? Effect.succeed<EnvironmentCleanupAttemptReport | null>(null)
          : runIntent(intent, new Set<EnvironmentOwnedDataResource>(['outbox', 'drafts'])),
      ),
    )

  const retry = (
    activeEnvironmentIds: ReadonlySet<EnvironmentId>,
    lease?: EnvironmentOwnedDataCleanupLease,
  ) =>
    database.loadEnvironmentCleanupIntents.pipe(
      Effect.map((intents) =>
        intents
          .filter(
            (intent) =>
              !activeEnvironmentIds.has(intent.environmentId) &&
              intent.nextAttemptAtEpochMs <= now(),
          )
          .slice(0, MAX_RECORDS_PER_TRIGGER),
      ),
      Effect.flatMap((intents) =>
        Effect.forEach(
          intents,
          (intent) =>
          {
            const attempt = runIntent(
              intent,
              new Set<EnvironmentOwnedDataResource>(['cache', 'outbox', 'drafts']),
            ).pipe(Effect.asVoid)
            return lease?.run(intent.environmentId, attempt) ?? attempt
          },
          { concurrency: RETRY_CONCURRENCY },
        ),
      ),
    )

  return { prepare, markComplete, markCurrentComplete, clear, retry }
}
