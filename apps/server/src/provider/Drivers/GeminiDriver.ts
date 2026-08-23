// apps/server/src/provider/Drivers/GeminiDriver.ts
// create isolated Gemini ACP instances bound to one executable and API key

import {
  GeminiSettings,
  ProviderDriverKind,
  type ProviderRuntimeCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Ref from 'effect/Ref'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import { ServerConfig } from '../../config.ts'
import { ServerSettingsService } from '../../serverSettings.ts'
import { makeGeminiTextGeneration } from '../../textGeneration/GeminiTextGeneration.ts'
import {
  buildGeminiAcpEnvironment,
  buildGeminiAcpSpawnInput,
  GEMINI_API_KEY_ENV,
  geminiCapabilitiesFromSessionSetup,
  GOOGLE_API_KEY_ENV,
} from '../acp/GeminiAcpSupport.ts'
import {
  acpContinuationEnvironment,
  acpContinuationRouteIssue,
  normalizeAcpRuntimeEnvironment,
  resolveAcpContinuationIdentity,
} from '../continuationIdentity.ts'
import { ProviderDriverError } from '../Errors.ts'
import { makeGeminiAdapter } from '../Layers/GeminiAdapter.ts'
import {
  buildInitialGeminiProviderSnapshot,
  checkGeminiProviderStatus,
  enrichGeminiSnapshot,
  geminiProviderModelsFromSessionSetup,
  overlayGeminiSessionModels,
} from '../Layers/GeminiProvider.ts'
import { mergeProviderInstanceEnvironment } from '../catalog/ProviderInstanceEnvironment.ts'
import { GEMINI_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'
import { makeManagedServerProvider } from '../catalog/makeManagedServerProvider.ts'
import type { ProviderDriver, ProviderInstance } from '../catalog/ProviderDriver.ts'
import {
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from '../maintenance/providerMaintenance.ts'
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from '../maintenance/providerUpdateSettings.ts'
import type { ServerProviderDraft } from '../providerSnapshot.ts'

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings)
const DRIVER_KIND = ProviderDriverKind.make('gemini')
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5)
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: '@google/gemini-cli',
  homebrewFormula: 'gemini-cli',
  nativeUpdate: null,
})

export type GeminiDriverEnv =
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

export const GeminiDriver: ProviderDriver<GeminiSettings, GeminiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: 'Gemini',
    supportsMultipleInstances: true,
  },
  configSchema: GeminiSettings,
  defaultConfig: (): GeminiSettings => decodeGeminiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* ()
    {
      const crypto = yield* Crypto.Crypto
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const httpClient = yield* HttpClient.HttpClient
      const path = yield* Path.Path
      const { cwd, stateDir, attachmentsDir } = yield* ServerConfig
      const serverSettings = yield* ServerSettingsService
      const effectiveConfig = { ...config, enabled } satisfies GeminiSettings
      const mergedEnvironment = mergeProviderInstanceEnvironment(environment)
      const apiKeyConfigured = environment.some(
        (variable) => variable.name === 'GEMINI_API_KEY' && variable.value.trim().length > 0,
      )
      const explicitlyConfiguredApiKeyNames = new Set<
        typeof GEMINI_API_KEY_ENV | typeof GOOGLE_API_KEY_ENV
      >(
        environment.flatMap((variable) =>
          variable.value.trim().length > 0 &&
          (variable.name === GEMINI_API_KEY_ENV || variable.name === GOOGLE_API_KEY_ENV)
            ? [variable.name]
            : [],
        ),
      )
      const cliHome = apiKeyConfigured
        ? path.join(stateDir, 'providers', 'gemini', String(instanceId))
        : undefined
      const processEnv = normalizeAcpRuntimeEnvironment(
        buildGeminiAcpEnvironment(mergedEnvironment, {
          apiKeyConfigured,
          explicitlyConfiguredApiKeyNames,
          ...(cliHome ? { cliHome } : {}),
        }),
        cwd,
      )
      const spawnRoute = buildGeminiAcpSpawnInput(effectiveConfig, cwd, processEnv)
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
      const sessionModelsRef = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([])
      const sessionCapabilitiesRef = yield* Ref.make<ProviderRuntimeCapabilities>(
        GEMINI_PROVIDER_CAPABILITIES,
      )
      const snapshotPublisherRef = yield* Ref.make<{
        readonly getSnapshot: Effect.Effect<ServerProvider>
        readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>
      } | null>(null)
      // status probes stay on `gemini --version`; ACP starts on real turns only
      const adapter = yield* makeGeminiAdapter(effectiveConfig, {
        environment: processEnv,
        attachmentsDir,
        enableAbnormalTermination: true,
        instanceId,
        onSessionSetup: (sessionSetupResult) =>
          Effect.gen(function* ()
          {
            const sessionModels = geminiProviderModelsFromSessionSetup(sessionSetupResult)
            if (sessionModels.length > 0) yield* Ref.set(sessionModelsRef, sessionModels)
            yield* Ref.update(sessionCapabilitiesRef, (current) =>
              geminiCapabilitiesFromSessionSetup(current, sessionSetupResult),
            )
            const publisher = yield* Ref.get(snapshotPublisherRef)
            if (publisher === null) return
            const currentSnapshot = yield* publisher.getSnapshot
            yield* publisher.publishSnapshot(currentSnapshot)
          }),
        onSessionModelSwitchSupported: () =>
          Effect.gen(function* ()
          {
            yield* Ref.update(sessionCapabilitiesRef, (current) => ({
              ...current,
              sessionModelSwitch: 'in-session' as const,
            }))
            const publisher = yield* Ref.get(snapshotPublisherRef)
            if (publisher === null) return
            const currentSnapshot = yield* publisher.getSnapshot
            yield* publisher.publishSnapshot(currentSnapshot)
          }),
      })
      const textGeneration = yield* makeGeminiTextGeneration(effectiveConfig, processEnv, {
        apiKeyConfigured,
        explicitlyConfiguredApiKeyNames,
      })
      const checkProvider = checkGeminiProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((draft) =>
          Effect.all({
            sessionModels: Ref.get(sessionModelsRef),
            sessionCapabilities: Ref.get(sessionCapabilitiesRef),
          }).pipe(
            Effect.map(({ sessionModels, sessionCapabilities }) => ({
              ...stampIdentity(overlayGeminiSessionModels(draft, sessionModels)),
              capabilities: sessionCapabilities,
            })),
          ),
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings)
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GeminiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialGeminiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, getSnapshot, publishSnapshot }) =>
        {
          const publishWithSessionState = (nextSnapshot: ServerProvider) =>
            Effect.all({
              sessionModels: Ref.get(sessionModelsRef),
              sessionCapabilities: Ref.get(sessionCapabilitiesRef),
            }).pipe(
              Effect.flatMap(({ sessionModels, sessionCapabilities }) =>
                publishSnapshot({
                  ...overlayGeminiSessionModels(nextSnapshot, sessionModels),
                  capabilities: sessionCapabilities,
                }),
              ),
            )
          return Ref.set(snapshotPublisherRef, {
            getSnapshot,
            publishSnapshot: publishWithSessionState,
          }).pipe(
            Effect.andThen(
              enrichGeminiSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot: publishWithSessionState,
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
              detail: `Failed to build Gemini snapshot: ${cause.message ?? String(cause)}`,
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
