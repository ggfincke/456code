// apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts
// from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it

//
// the server still reads two shapes:
//
//   1. `settings.providerInstances` — the new driver-agnostic map the
//      registry expects. Keyed by `ProviderInstanceId`, values are
//      `ProviderInstanceConfig` envelopes.
//   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
//      fields (`providers.codex`, `providers.claudeAgent`, …). These are
//      the source of truth for every deployment that hasn't been migrated
//      yet to an explicit `providerInstances` entry.
//
// this module bridges (2) into (1) and wires the resulting map into a
// mutable registry. For every built-in driver whose id is not already
// present in `providerInstances` (keyed on
// `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
// routing slug), we synthesize an envelope from the legacy field. The
// registry decodes both flavours through the same `configSchema` and ends
// up with one uniform `ProviderInstance` per entry.
//
// explicit `providerInstances` entries always win — users can already
// override the legacy `providers.<kind>` blob by authoring a
// `providerInstances.codex` entry with a matching driver, and we don't
// want the synthesized envelope to silently stomp their config.
//
// hot-reload
// on layer build we:
//   1. Read the current `ServerSettings` once and use it to seed the
//      registry's initial state via `ProviderInstanceRegistryMutableLayer`.
//   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
//      subscribes to `ServerSettingsService.streamChanges` and calls
//      `ProviderInstanceRegistryMutator.reconcile` on every emission.
//
// failures inside the watcher are logged and swallowed so a failed
// lifecycle retirement cannot kill the watcher. The last live route stays
// authoritative when ProviderService cannot durably close it. Unknown
// drivers and invalid configs still round-trip through the registry's
// "unavailable" shadow bucket.
//
// @module provider/Layers/ProviderInstanceRegistryHydration
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import { ServerSettingsService } from '../../serverSettings.ts'
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from '../catalog/builtInDrivers.ts'
import { ProviderInstanceRegistry } from '../Services/ProviderInstanceRegistry.ts'
import { ProviderInstanceRegistryMutator } from '../Services/ProviderInstanceRegistryMutator.ts'
import { ProviderInstanceRegistryMutableLayer } from './ProviderInstanceRegistryLive.ts'

// synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
//
// strategy:
//   1. Copy all explicit `settings.providerInstances` entries verbatim.
//   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
//      is *not* already in the explicit map, synthesize an entry from the
//      matching legacy `settings.providers.<kind>` blob.
//
// the returned map is the input the registry consumes; pure & exported
// separately so the hydration logic can be exercised by unit tests
// without layering.
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap =>
{
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances }

  for (const driver of BUILT_IN_DRIVERS)
  {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind)
    if (instanceId in merged)
    {
      // explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue
    }

    // only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings['providers']
    const legacyConfig = settings.providers[legacyKey]
    if (legacyConfig === undefined)
    {
      continue
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    }
  }

  return merged as ProviderInstanceConfigMap
}

// layer that consumes `ProviderInstanceRegistryMutator` and forks a
// settings-watcher fiber. The fiber's lifetime is tied to the enclosing
// layer scope (process lifetime in production), so it is interrupted on
// shutdown without leaking.
//
// errors inside the watcher are logged and swallowed. A failed retirement
// leaves the prior live route intact; a later full settings snapshot can
// retry it after the lifecycle problem is resolved.
const SettingsWatcherLive = Layer.effectDiscard(
  Effect.gen(function* ()
  {
    const mutator = yield* ProviderInstanceRegistryMutator
    const serverSettings = yield* ServerSettingsService
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((next) =>
        mutator
          .reconcile(deriveProviderInstanceConfigMap(next))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError('ProviderInstanceRegistry reconcile failed', cause),
            ),
          ),
      ),
      Effect.forkScoped,
    )
  }),
)

// hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
// sync with subsequent `streamChanges` emissions.
//
// the Layer's two halves:
//   - `ProviderInstanceRegistryMutableLayer` produces the registry +
//     mutator from the initial config map. Its scope owns every
//     per-instance child scope created during reconcile.
//   - `SettingsWatcherLive` consumes the mutator and runs a daemon fiber
//     in the same scope.
//
// composing via `Layer.provideMerge` makes the watcher's deps available
// from the mutable layer while still surfacing the registry as an output.
// the mutator tag is technically also exposed; only this module imports
// it, so the visibility leak is harmless in practice.
export const makeProviderInstanceRegistryHydrationLayer = (options?: {
  readonly requireLifecycleOwnerForRetirement?: boolean
}): Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceRegistryMutator,
  never,
  BuiltInDriversEnv | ServerSettingsService
> =>
  Layer.unwrap(
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsService
      const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const initialConfigMap =
        initialSettings === undefined
          ? ({} as ProviderInstanceConfigMap)
          : deriveProviderInstanceConfigMap(initialSettings)

      const mutableLayer = ProviderInstanceRegistryMutableLayer({
        drivers: BUILT_IN_DRIVERS,
        configMap: initialConfigMap,
        requireLifecycleOwnerForRetirement: options?.requireLifecycleOwnerForRetirement ?? true,
      })

      return SettingsWatcherLive.pipe(Layer.provideMerge(mutableLayer))
    }),
  ) as Layer.Layer<
    ProviderInstanceRegistry | ProviderInstanceRegistryMutator,
    never,
    BuiltInDriversEnv | ServerSettingsService
  >

export const ProviderInstanceRegistryHydrationLive = makeProviderInstanceRegistryHydrationLayer()
