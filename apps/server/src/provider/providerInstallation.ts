// apps/server/src/provider/providerInstallation.ts
// routes provider installation commands to the environment managed runtime

import {
  AntigravitySettings,
  ProviderDriverKind,
  type ProviderInstallCancelInput,
  type ProviderInstanceId,
  ProviderSetupError,
  type ProviderSetupInput,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { ServerSettingsService } from '../serverSettings.ts'
import {
  AntigravityInstallation,
  type AntigravityInstallationError,
} from './AntigravityInstallation.ts'
import { deriveProviderInstanceConfigMap } from './Layers/ProviderInstanceRegistryHydration.ts'
import { ProviderInstanceRegistry } from './Services/ProviderInstanceRegistry.ts'
import { ProviderRegistry } from './Services/ProviderRegistry.ts'

const ANTIGRAVITY = ProviderDriverKind.make('antigravity')
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings)

// route instance setup to the environment-owned installer without owning the download.
export const makeProviderInstallation = Effect.fn('makeProviderInstallation')(function* ()
{
  const installation = yield* AntigravityInstallation
  const instances = yield* ProviderInstanceRegistry
  const providers = yield* ProviderRegistry
  const settings = yield* ServerSettingsService

  const readEntries = Effect.fn('ProviderInstallation.readEntries')(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  )
  {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: 'Could not read provider installation settings.',
          }),
      ),
    )
    return deriveProviderInstanceConfigMap(current)
  })

  const requireInstance = Effect.fn('ProviderInstallation.requireInstance')(function* (
    instanceId: ProviderInstanceId,
    operation: string,
    managedOnly = false,
  )
  {
    const instance = yield* instances.getInstance(instanceId)
    if (instance?.driverKind !== ANTIGRAVITY)
    {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: 'Managed installation is not available for this provider instance.',
      })
    }
    if (!managedOnly) return
    const entries = yield* readEntries(instanceId, operation)
    const config = yield* decodeAntigravitySettings(entries[instanceId]?.config ?? {}).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: 'The Antigravity instance configuration is invalid.',
          }),
      ),
    )
    if (config.officialRuntime?.mode === 'custom')
    {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail:
          'This instance uses a custom executable. Select the managed runtime to manage installation in T3 Code.',
      })
    }
  })

  const failure = (instanceId: ProviderInstanceId) => (error: AntigravityInstallationError) =>
    new ProviderSetupError({ instanceId, operation: error.operation, detail: error.detail })

  const start = Effect.fn('ProviderInstallation.start')(function* (input: ProviderSetupInput)
  {
    yield* requireInstance(input.instanceId, 'install', true)
    return yield* installation.start.pipe(Effect.mapError(failure(input.instanceId)))
  })

  const cancel = Effect.fn('ProviderInstallation.cancel')(function* (
    input: ProviderInstallCancelInput,
  )
  {
    yield* requireInstance(input.instanceId, 'cancel-install')
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId)))
  })

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      requireInstance(input.instanceId, 'observe-install').pipe(Effect.as(installation.changes)),
    )

  const remove = Effect.fn('ProviderInstallation.remove')(function* (input: ProviderSetupInput)
  {
    yield* requireInstance(input.instanceId, 'remove-install', true)
    yield* installation.remove().pipe(Effect.mapError(failure(input.instanceId)))
    const allInstances = yield* instances.listInstances
    yield* Effect.forEach(
      allInstances.filter((instance) => instance.driverKind === ANTIGRAVITY),
      (instance) => providers.refreshInstance(instance.instanceId),
      { discard: true },
    )
    return yield* installation.state
  })

  return { start, cancel, subscribe, remove }
})
