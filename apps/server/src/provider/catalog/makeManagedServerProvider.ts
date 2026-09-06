// apps/server/src/provider/catalog/makeManagedServerProvider.ts
// provide make managed server integration

import type { ServerProvider } from '@t3tools/contracts'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Equal from 'effect/Equal'
import * as Fiber from 'effect/Fiber'
import * as PubSub from 'effect/PubSub'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as Semaphore from 'effect/Semaphore'

import type { ServerProviderShape } from '../Services/ServerProvider.ts'
import { ServerSettingsError } from '@t3tools/contracts'
import {
  applyUsageLimitsUpdate,
  providerUsageAccountIdentity,
  resolveAccountUsageAfterProbe,
} from '../providerUsageLimits.ts'

interface ProviderSnapshotState
{
  readonly snapshot: ServerProvider
  readonly enrichmentGeneration: number
}

function withAccountUsage(
  snapshot: ServerProvider,
  accountUsage: ServerProvider['accountUsage'],
): ServerProvider
{
  if (snapshot.accountUsage === accountUsage) return snapshot
  const { accountUsage: _previous, ...rest } = snapshot
  return accountUsage ? { ...rest, accountUsage } : rest
}

export const makeManagedServerProvider = Effect.fn('makeManagedServerProvider')(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ServerProviderShape['resolveMaintenance']
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>
  readonly streamSettings: Stream.Stream<Settings>
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings
    readonly snapshot: ServerProvider
    readonly getSnapshot: Effect.Effect<ServerProvider>
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>
  }) => Effect.Effect<void>
  readonly refreshInterval?: Duration.Input
  readonly refreshOnInterval?: boolean
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope>
{
  const refreshSemaphore = yield* Semaphore.make(1)
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  )
  const initialSettings = yield* input.getSettings
  const initialSnapshot = yield* input.initialSnapshot(initialSettings)
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  })
  const settingsRef = yield* Ref.make(initialSettings)
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null)
  const scope = yield* Effect.scope

  const publishEnrichedSnapshot = Effect.fn('publishEnrichedSnapshot')(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  )
  {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) =>
    {
      if (state.enrichmentGeneration !== generation)
      {
        return [null, state] as const
      }
      // preserve runtime usage updates that arrived after enrichment started
      const merged = withAccountUsage(nextSnapshot, state.snapshot.accountUsage)
      if (Equal.equals(state.snapshot, merged)) return [null, state] as const
      return [
        merged,
        {
          ...state,
          snapshot: merged,
        },
      ] as const
    })
    if (snapshotToPublish === null)
    {
      return
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish)
  })

  const restartSnapshotEnrichment = Effect.fn('restartSnapshotEnrichment')(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  )
  {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null)
    if (previousFiber)
    {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore)
    }

    if (!input.enrichSnapshot)
    {
      return
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope))

    yield* Ref.set(enrichmentFiberRef, fiber)
  })

  const applySnapshotBase = Effect.fn('applySnapshot')(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  )
  {
    const forceRefresh = options?.forceRefresh === true
    const previousSettings = yield* Ref.get(settingsRef)
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings))
    {
      yield* Ref.set(settingsRef, nextSettings)
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot))
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    )
    {
      const state = yield* Ref.updateAndGet(snapshotStateRef, (state) => ({
        ...state,
        enrichmentGeneration: state.enrichmentGeneration + 1,
      }))
      yield* Ref.set(settingsRef, nextSettings)
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, state.enrichmentGeneration)
      return state.snapshot
    }

    const probedSnapshot = yield* input.checkProvider
    const { snapshot: nextSnapshot, generation: nextGeneration } = yield* Ref.modify(
      snapshotStateRef,
      (state) =>
      {
        const generation = input.enrichSnapshot
          ? state.enrichmentGeneration + 1
          : state.enrichmentGeneration
        const snapshot = withAccountUsage(
          probedSnapshot,
          resolveAccountUsageAfterProbe({
            published: state.snapshot.accountUsage,
            probed: probedSnapshot.accountUsage,
            sameAccount:
              providerUsageAccountIdentity(state.snapshot) !== undefined &&
              providerUsageAccountIdentity(state.snapshot) ===
                providerUsageAccountIdentity(probedSnapshot),
          }),
        )
        return [
          { snapshot, generation },
          {
            snapshot,
            enrichmentGeneration: generation,
          },
        ] as const
      },
    )
    yield* Ref.set(settingsRef, nextSettings)
    yield* PubSub.publish(changesPubSub, nextSnapshot)
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration)
    return nextSnapshot
  })
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options))

  const refreshSnapshot = Effect.fn('refreshSnapshot')(function* ()
  {
    const nextSettings = yield* input.getSettings
    return yield* applySnapshot(nextSettings, { forceRefresh: true })
  })

  const applyUsageLimits: ServerProviderShape['applyUsageLimits'] = (update) =>
    Effect.gen(function* ()
    {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) =>
      {
        if (
          state.snapshot.accountUsage?.status !== 'available' ||
          providerUsageAccountIdentity(state.snapshot) !== update.accountIdentity
        )
        {
          return [null, state] as const
        }
        const accountUsage = applyUsageLimitsUpdate({
          previous: state.snapshot.accountUsage,
          update,
        })
        if (accountUsage === state.snapshot.accountUsage) return [null, state] as const
        const snapshot = withAccountUsage(state.snapshot, accountUsage)
        return [snapshot, { ...state, snapshot }] as const
      })
      if (snapshotToPublish !== null)
      {
        yield* PubSub.publish(changesPubSub, snapshotToPublish)
      }
    })

  const invalidateUsageLimits: ServerProviderShape['invalidateUsageLimits'] = (observedAt) =>
    Effect.gen(function* ()
    {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) =>
      {
        if (state.snapshot.accountUsage === undefined) return [null, state] as const
        const snapshot = withAccountUsage(state.snapshot, {
          status: 'unavailable',
          observedAt,
          message: 'Refreshing account usage after authentication changed.',
        })
        return [snapshot, { ...state, snapshot }] as const
      })
      if (snapshotToPublish !== null)
      {
        yield* PubSub.publish(changesPubSub, snapshotToPublish)
      }
    })

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped)

  if (input.refreshOnInterval !== false)
  {
    yield* Effect.forever(
      Effect.sleep(input.refreshInterval ?? '60 seconds').pipe(
        Effect.flatMap(() => refreshSnapshot()),
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped)
  }

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  )

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    applyUsageLimits,
    invalidateUsageLimits,
    get streamChanges()
    {
      return Stream.fromPubSub(changesPubSub)
    },
  } satisfies ServerProviderShape
})
