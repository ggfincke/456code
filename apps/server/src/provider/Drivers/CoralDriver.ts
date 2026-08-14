// apps/server/src/provider/Drivers/CoralDriver.ts
// create isolated Coral ACP instances bound to one executable, home, and host

import {
  CoralSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import { ServerConfig } from '../../config.ts'
import { ServerSettingsService } from '../../serverSettings.ts'
import { makeCoralTextGeneration } from '../../textGeneration/CoralTextGeneration.ts'
import { buildCoralAcpEnvironment, buildCoralAcpSpawnInput } from '../acp/CoralAcpSupport.ts'
import {
  acpContinuationEnvironment,
  acpContinuationRouteIssue,
  normalizeAcpRuntimeEnvironment,
  resolveAcpContinuationIdentity,
} from '../continuationIdentity.ts'
import { ProviderDriverError } from '../Errors.ts'
import { makeCoralAdapter } from '../Layers/CoralAdapter.ts'
import {
  buildInitialCoralProviderSnapshot,
  checkCoralProviderStatus,
  coralProviderModelsFromSessionSetup,
  enrichCoralSnapshot,
  overlayCoralSessionModels,
} from '../Layers/CoralProvider.ts'
import { mergeProviderInstanceEnvironment } from '../catalog/ProviderInstanceEnvironment.ts'
import { makeManagedServerProvider } from '../catalog/makeManagedServerProvider.ts'
import type { ProviderDriver, ProviderInstance } from '../catalog/ProviderDriver.ts'
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
import type { ServerProviderDraft } from '../providerSnapshot.ts'

const decodeCoralSettings = Schema.decodeSync(CoralSettings)
const DRIVER_KIND = ProviderDriverKind.make('coral')
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5)
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
)

export type CoralDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance['instanceId']
    readonly displayName: string | undefined
    readonly accentColor: string | undefined
    readonly continuationGroupKey: string | null
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.continuationGroupKey === null
      ? {}
      : { continuation: { groupKey: input.continuationGroupKey } }),
  })

export const CoralDriver: ProviderDriver<CoralSettings, CoralDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: 'Coral',
    supportsMultipleInstances: true,
  },
  configSchema: CoralSettings,
  defaultConfig: (): CoralSettings => decodeCoralSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* ()
    {
      const crypto = yield* Crypto.Crypto
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const httpClient = yield* HttpClient.HttpClient
      const { cwd } = yield* ServerConfig
      const serverSettings = yield* ServerSettingsService
      const effectiveConfig = { ...config, enabled } satisfies CoralSettings
      const processEnv = normalizeAcpRuntimeEnvironment(
        buildCoralAcpEnvironment(effectiveConfig, mergeProviderInstanceEnvironment(environment)),
        cwd,
      )
      const spawnRoute = buildCoralAcpSpawnInput(effectiveConfig, cwd, processEnv)
      const continuationRoute = {
        command: spawnRoute.command,
        args: spawnRoute.args,
        env: normalizeAcpRuntimeEnvironment(
          acpContinuationEnvironment(DRIVER_KIND, spawnRoute.env ?? {}, environment),
          cwd,
        ),
      } as const
      const continuationUnavailableReason = acpContinuationRouteIssue(continuationRoute)
      const resolveContinuationIdentity = resolveAcpContinuationIdentity(
        DRIVER_KIND,
        continuationRoute,
      )
      const continuationIdentity = yield* resolveContinuationIdentity
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey:
          continuationUnavailableReason === null ? continuationIdentity.continuationKey : null,
      })
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      })
      // status probes stay on `coral --version`; bound sessions own the Ollama inventory
      const sessionModelsRef = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([])
      const snapshotPublisherRef = yield* Ref.make<{
        readonly getSnapshot: Effect.Effect<ServerProvider>
        readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>
      } | null>(null)
      const adapter = yield* makeCoralAdapter(effectiveConfig, {
        environment: processEnv,
        enableAbnormalTermination: true,
        instanceId,
        onSessionSetup: (sessionSetupResult) =>
          Effect.gen(function* ()
          {
            const sessionModels = coralProviderModelsFromSessionSetup(sessionSetupResult)
            if (sessionModels.length === 0) return
            yield* Ref.set(sessionModelsRef, sessionModels)
            const publisher = yield* Ref.get(snapshotPublisherRef)
            if (publisher === null) return
            const currentSnapshot = yield* publisher.getSnapshot
            yield* publisher.publishSnapshot(currentSnapshot)
          }),
      })
      const textGeneration = yield* makeCoralTextGeneration(effectiveConfig, processEnv)
      const checkProvider = checkCoralProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((draft) =>
          Ref.get(sessionModelsRef).pipe(
            Effect.map((sessionModels) =>
              stampIdentity(overlayCoralSessionModels(draft, sessionModels)),
            ),
          ),
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings)
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CoralSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCoralProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, getSnapshot, publishSnapshot }) =>
        {
          const publishWithSessionModels = (nextSnapshot: ServerProvider) =>
            Ref.get(sessionModelsRef).pipe(
              Effect.flatMap((sessionModels) =>
                publishSnapshot(overlayCoralSessionModels(nextSnapshot, sessionModels)),
              ),
            )
          return Ref.set(snapshotPublisherRef, {
            getSnapshot,
            publishSnapshot: publishWithSessionModels,
          }).pipe(
            Effect.andThen(
              enrichCoralSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot: publishWithSessionModels,
                httpClient,
              }),
            ),
          )
        },
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Coral snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      )

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        resolveContinuationIdentity,
        ...(continuationUnavailableReason === null ? {} : { continuationUnavailableReason }),
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance
    }),
}
