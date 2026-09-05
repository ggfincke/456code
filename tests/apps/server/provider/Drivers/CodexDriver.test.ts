// tests/apps/server/provider/Drivers/CodexDriver.test.ts
// verify Codex driver maintenance ownership behavior

// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from '@effect/vitest'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { ProviderInstanceId } from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { HttpClient } from 'effect/unstable/http'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { ServerSettingsService } from '../../../../../apps/server/src/serverSettings.ts'
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from '../../../../../apps/server/src/provider/Layers/ProviderEventLoggers.ts'
import { CodexDriver } from '../../../../../apps/server/src/provider/Drivers/CodexDriver.ts'

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: '456code-codex-driver-maintenance-',
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die('Disabled Codex must not make an HTTP request')),
    ),
  ),
)

const windowsHost = HostProcessPlatform.defaultValue() === 'win32'
const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die('Disabled Codex must not spawn a process'),
)

it.layer(testLayer)('CodexDriver', (it) =>
{
  it.effect.skipIf(windowsHost)(
    'uses the resolved standalone executable and the shared Codex home',
    () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: '456code-codex-driver-',
        })
        const sharedHome = NodePath.join(tempDir, 'codex-home')
        const shadowHome = NodePath.join(tempDir, 'codex-shadow')
        const binaryPath = NodePath.join(sharedHome, 'packages', 'standalone', 'bin', 'codex')
        yield* fileSystem.makeDirectory(NodePath.dirname(binaryPath), { recursive: true })
        yield* fileSystem.writeFileString(binaryPath, '#!/bin/sh\n')
        yield* fileSystem.chmod(binaryPath, 0o755)

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make('codex-shadow'),
          displayName: 'Codex test',
          enabled: false,
          environment: [{ name: 'PROVIDER_SCOPE', value: 'work', sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          },
        })

        expect((yield* instance.snapshot.resolveMaintenance()).update).toMatchObject({
          executable: binaryPath,
          args: ['update'],
          lockKey: 'codex-native',
          env: { CODEX_HOME: sharedHome, PROVIDER_SCOPE: 'work' },
        })
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  )

  it.effect('stays manual-only when the configured executable does not exist', () =>
    Effect.gen(function* ()
    {
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make('codex-missing'),
        displayName: 'Codex test',
        enabled: false,
        environment: [],
        config: {
          ...CodexDriver.defaultConfig(),
          binaryPath: NodePath.join(NodeOS.tmpdir(), '456code-codex-missing', 'codex'),
        },
      })
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull()
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  )
})
