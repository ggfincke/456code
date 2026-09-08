// apps/server/src/provider/Drivers/OpenCodeDriver.ts
// creates isolated OpenCode instances bound to local storage or external servers

import { OpenCodeSettings, ProviderDriverKind, type ServerProvider } from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import { makeOpenCodeTextGeneration } from '../../textGeneration/OpenCodeTextGeneration.ts'
import { ServerConfig } from '../../config.ts'
import { ServerSettingsService } from '../../serverSettings.ts'
import {
  normalizeOpenCodeRuntimeEnvironment,
  resolveOpenCodeContinuationIdentity,
} from '../continuationIdentity.ts'
import { ProviderDriverError } from '../Errors.ts'
import { makeOpenCodeAdapter } from '../Layers/OpenCodeAdapter.ts'
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
  openCodeSkillsToServerProviderSkills,
} from '../Layers/OpenCodeProvider.ts'
import { ProviderEventLoggers } from '../Layers/ProviderEventLoggers.ts'
import { makeManagedServerProvider } from '../catalog/makeManagedServerProvider.ts'
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from '../opencodeRuntime.ts'
import * as OpenCodeServerOwner from '../OpenCodeServerOwner.ts'
import { type ProviderDriver, type ProviderInstance } from '../catalog/ProviderDriver.ts'
import type { ServerProviderDraft } from '../providerSnapshot.ts'
import { mergeProviderInstanceEnvironment } from '../catalog/ProviderInstanceEnvironment.ts'
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from '../maintenance/providerMaintenance.ts'
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from '../maintenance/providerUpdateSettings.ts'
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings)

const DRIVER_KIND = ProviderDriverKind.make('opencode')

function isOpenCodeNativeCommandPath(commandPath: string): boolean
{
  const normalized = normalizeCommandPath(commandPath)
  return (
    normalized.endsWith('/.opencode/bin/opencode') ||
    normalized.endsWith('/.opencode/bin/opencode.exe')
  )
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: 'opencode-ai',
  nativeUpdate: {
    args: ['upgrade'],
    isCommandPath: isOpenCodeNativeCommandPath,
  },
})

export const makeOpenCodeWorkspaceSkillsLoader =
  (input: {
    readonly settings: Pick<OpenCodeSettings, 'binaryPath' | 'serverPassword' | 'serverUrl'>
    readonly environment: NodeJS.ProcessEnv
    readonly runtime: Pick<
      OpenCodeRuntimeShape,
      'connectToOpenCodeServer' | 'createOpenCodeSdkClient' | 'loadOpenCodeSkills'
    >
    readonly serverOwner: Pick<OpenCodeServerOwner.OpenCodeServerOwner['Service'], 'withServer'>
  }) =>
  (cwd: string) =>
    input.settings.serverUrl.trim().length > 0
      ? Effect.scoped(
          Effect.gen(function* ()
            {
            const server = yield* input.runtime.connectToOpenCodeServer({
              binaryPath: input.settings.binaryPath,
              directory: cwd,
              serverUrl: input.settings.serverUrl,
              ...(input.settings.serverPassword
                ? { serverPassword: input.settings.serverPassword }
                : {}),
              environment: input.environment,
            })
            return yield* input.runtime.loadOpenCodeSkills(
              input.runtime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: cwd,
                ...(input.settings.serverPassword
                  ? { serverPassword: input.settings.serverPassword }
                  : {}),
              }),
            )
          }),
        )
      : input.serverOwner.withServer((server) =>
          input.runtime.loadOpenCodeSkills(
            input.runtime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: cwd,
              ...(server.serverPassword !== undefined
                ? { serverPassword: server.serverPassword }
                : {}),
            }),
          ),
        )

export type OpenCodeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance['instanceId']
    readonly displayName: string | undefined
    readonly accentColor: string | undefined
    readonly continuationGroupKey: string
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  })

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: 'OpenCode',
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* ()
    {
      const openCodeRuntime = yield* OpenCodeRuntime
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const serverConfig = yield* ServerConfig
      const httpClient = yield* HttpClient.HttpClient
      const serverSettings = yield* ServerSettingsService
      const eventLoggers = yield* ProviderEventLoggers
      const processEnv = mergeProviderInstanceEnvironment(environment)
      const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings
      const runtimeEnvironment =
        effectiveConfig.serverUrl.trim().length > 0
          ? processEnv
          : normalizeOpenCodeRuntimeEnvironment(processEnv, {
              cwd: serverConfig.cwd,
            })
      const resolveContinuationIdentity = resolveOpenCodeContinuationIdentity(
        DRIVER_KIND,
        effectiveConfig,
        {
          environment: runtimeEnvironment,
          cwd: serverConfig.cwd,
        },
      ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
      const continuationIdentity = yield* resolveContinuationIdentity
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      })
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      )

      const adapter = yield* makeOpenCodeAdapter(effectiveConfig, {
        instanceId,
        environment: runtimeEnvironment,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      })
      // inventory and generated text share one instance owner; chat servers remain isolated
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: effectiveConfig.binaryPath,
        directory: serverConfig.cwd,
        ...(effectiveConfig.serverPassword
          ? { serverPassword: effectiveConfig.serverPassword }
          : {}),
        environment: runtimeEnvironment,
      })
      const textGeneration = yield* makeOpenCodeTextGeneration(effectiveConfig).pipe(
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      )
      // local workspace catalogs reuse the instance owner so SDK responses are
      // not truncated by CLI stdout pipe limits.
      const loadSkillsForCwd = makeOpenCodeWorkspaceSkillsLoader({
        settings: effectiveConfig,
        environment: processEnv,
        runtime: openCodeRuntime,
        serverOwner,
      })

      const checkProvider = checkOpenCodeProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        runtimeEnvironment,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(OpenCodeRuntime, openCodeRuntime),
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      )

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings)
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>(
        {
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }),
              ),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      )

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        resolveContinuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([snapshot.getSnapshot, loadSkillsForCwd(cwd)]).pipe(
                Effect.map(([machineSnapshot, skills]) => ({
                  ...machineSnapshot,
                  skills: openCodeSkillsToServerProviderSkills(skills),
                })),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to probe OpenCode skills for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
        adapter,
        textGeneration,
      } satisfies ProviderInstance
    }),
}
