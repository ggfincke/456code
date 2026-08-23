// apps/server/src/provider/Drivers/AntigravityDriver.ts
// create isolated Antigravity headless instances

import { AntigravitySettings, ProviderDriverKind, type ServerProvider } from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import { ChildProcessSpawner } from 'effect/unstable/process'

import { ServerSettingsService } from '../../serverSettings.ts'
import { makeAntigravityTextGeneration } from '../../textGeneration/AntigravityTextGeneration.ts'
import { processContinuationIdentity } from '../continuationIdentity.ts'
import { ProviderDriverError } from '../Errors.ts'
import { makeAntigravityAdapter } from '../Layers/AntigravityAdapter.ts'
import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
  discoverAntigravityAgents,
} from '../Layers/AntigravityProvider.ts'
import { mergeProviderInstanceEnvironment } from '../catalog/ProviderInstanceEnvironment.ts'
import { makeManagedServerProvider } from '../catalog/makeManagedServerProvider.ts'
import type { ProviderDriver, ProviderInstance } from '../catalog/ProviderDriver.ts'
import type { ServerProviderDraft } from '../providerSnapshot.ts'
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from '../maintenance/providerMaintenance.ts'
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from '../maintenance/providerUpdateSettings.ts'

const decodeSettings = Schema.decodeSync(AntigravitySettings)
const DRIVER_KIND = ProviderDriverKind.make('antigravity')
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5)
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
)

export type AntigravityDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerSettingsService

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance['instanceId']
    readonly displayName: string | undefined
    readonly accentColor: string | undefined
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
  })

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: 'Antigravity',
    supportsMultipleInstances: true,
  },
  configSchema: AntigravitySettings,
  defaultConfig: (): AntigravitySettings => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* ()
    {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const serverSettings = yield* ServerSettingsService
      const processEnv = mergeProviderInstanceEnvironment(environment)
      const effectiveConfig = { ...config, enabled } satisfies AntigravitySettings
      const continuationIdentity = processContinuationIdentity(DRIVER_KIND, {
        command: effectiveConfig.binaryPath || 'agy',
        args: [
          ...(effectiveConfig.agent.trim() ? ['--agent', effectiveConfig.agent.trim()] : []),
          ...(effectiveConfig.sandbox ? ['--sandbox'] : []),
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
        ],
      })
      const stampIdentity = withInstanceIdentity({ instanceId, displayName, accentColor })
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      })
      const adapter = yield* makeAntigravityAdapter(effectiveConfig, {
        environment: processEnv,
        instanceId,
        discoverAgents: () =>
          discoverAntigravityAgents(effectiveConfig, processEnv).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      })
      const textGeneration = yield* makeAntigravityTextGeneration(effectiveConfig, processEnv)
      const lastHealthyModels = yield* Ref.make<ServerProvider['models']>([])
      const checkProvider = checkAntigravityProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((snapshot) =>
          Effect.gen(function* ()
          {
            if (snapshot.status === 'ready')
            {
              yield* Ref.set(lastHealthyModels, snapshot.models)
              return snapshot
            }
            if (snapshot.status !== 'warning') return snapshot
            const previous = yield* Ref.get(lastHealthyModels)
            const seen = new Set(snapshot.models.map((model) => model.slug))
            return {
              ...snapshot,
              models: [...snapshot.models, ...previous.filter((model) => !seen.has(model.slug))],
            }
          }),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings)
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<AntigravitySettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialAntigravityProviderSnapshot(settings.provider).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ snapshot: currentSnapshot, publishSnapshot }) =>
          Effect.succeed(currentSnapshot).pipe(Effect.flatMap(publishSnapshot)),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Antigravity snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      )

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        resolveContinuationIdentity: Effect.succeed(continuationIdentity),
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance
    }),
}
