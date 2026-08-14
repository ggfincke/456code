// tests/apps/desktop/backend/DesktopBackendPool.test.ts
// verify desktop backend pool behavior

import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Sink from 'effect/Sink'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import * as DesktopObservability from '../../../../apps/desktop/src/app/DesktopObservability.ts'
import * as DesktopAppSettings from '../../../../apps/desktop/src/settings/DesktopAppSettings.ts'
import * as ElectronDialog from '../../../../apps/desktop/src/electron/ElectronDialog.ts'
import * as DesktopWindow from '../../../../apps/desktop/src/window/DesktopWindow.ts'
import * as DesktopBackendConfiguration from '../../../../apps/desktop/src/backend/DesktopBackendConfiguration.ts'
import * as DesktopBackendManager from '../../../../apps/desktop/src/backend/DesktopBackendManager.ts'
import * as DesktopBackendPool from '../../../../apps/desktop/src/backend/DesktopBackendPool.ts'

interface MakePoolLayerOptions
{
  readonly configResolve?: DesktopBackendConfiguration.DesktopBackendConfiguration['Service']['resolvePrimary']
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner['Service']
  readonly httpClient?: HttpClient.HttpClient
  readonly desktopWindow?: DesktopWindow.DesktopWindow['Service']
}

function makePoolLayer(
  labelRef: Ref.Ref<string>,
  options: MakePoolLayerOptions = {},
): Layer.Layer<DesktopBackendPool.DesktopBackendPool>
{
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          options.spawner ??
            ChildProcessSpawner.make(() => Effect.die('unexpected child process spawn')),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          options.httpClient ?? HttpClient.make(() => Effect.die('unexpected HTTP request')),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              writeSessionBoundary: () => Effect.void,
              writeOutputChunk: () => Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory['Service']),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: options.configResolve ?? Effect.die('unexpected primary config resolve'),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die('unexpected WSL config resolve'),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration['Service']),
        DesktopAppSettings.layerTest(),
        ElectronDialog.layer,
        Layer.succeed(
          DesktopWindow.DesktopWindow,
          options.desktopWindow ??
            ({
              createMain: Effect.die('unexpected window create'),
              ensureMain: Effect.die('unexpected window ensure'),
              revealOrCreateMain: Effect.die('unexpected window reveal'),
              activate: Effect.die('unexpected window activate'),
              createMainIfBackendReady: Effect.die('unexpected window create'),
              showConnectingSplash: Effect.void,
              handleBackendReady: () => Effect.void,
              handleBackendNotReady: Effect.void,
              flushMainWindowBounds: Effect.void,
              dispatchMenuAction: () => Effect.die('unexpected menu action'),
              zoomMain: () => Effect.die('unexpected zoom'),
              syncAppearance: Effect.void,
            } satisfies DesktopWindow.DesktopWindow['Service']),
        ),
      ),
    ),
  )
}

const primaryConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: '/electron',
  args: ['/server/bin.mjs', '--bootstrap-fd', '3'],
  entryPath: '/server/bin.mjs',
  cwd: '/server',
  env: { ELECTRON_RUN_AS_NODE: '1' },
  bootstrap: {
    mode: 'desktop',
    noBrowser: true,
    port: 3773,
    t3Home: '/tmp/t3',
    host: '127.0.0.1',
    desktopBootstrapToken: 'token',
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: 'fd3',
  extendEnv: true,
  httpBaseUrl: new URL('http://127.0.0.1:3773'),
  captureOutput: true,
  preflightFailure: Option.none(),
}

function makeRunningProcess(
  processExited: Deferred.Deferred<void>,
): ChildProcessSpawner.ChildProcessHandle
{
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Deferred.await(processExited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
    isRunning: Effect.succeed(true),
    kill: () => Deferred.succeed(processExited, undefined).pipe(Effect.asVoid),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
}

describe('DesktopBackendPool', () =>
{
  it.effect('resolves the primary label lazily after pool layer construction', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const labelRef = yield* Ref.make('Windows')
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(makePoolLayer(labelRef)),
        )
        const primary = yield* pool.primary

        yield* Ref.set(labelRef, 'WSL (Ubuntu)')

        assert.equal(yield* primary.label, 'WSL (Ubuntu)')
      }),
    ),
  )

  it.effect('forwards primary readiness to the desktop window', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const labelRef = yield* Ref.make('Windows')
        const processExited = yield* Deferred.make<void>()
        const backendReady = yield* Deferred.make<void>()
        let backendReadyCount = 0
        let backendNotReadyCount = 0

        const layer = makePoolLayer(labelRef, {
          configResolve: Effect.succeed(primaryConfig),
          spawner: ChildProcessSpawner.make(() =>
            Effect.gen(function* ()
            {
              const scope = yield* Scope.Scope
              yield* Scope.addFinalizer(
                scope,
                Deferred.succeed(processExited, undefined).pipe(Effect.asVoid),
              )
              return makeRunningProcess(processExited)
            }),
          ),
          httpClient: HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
            ),
          ),
          desktopWindow: {
            createMain: Effect.die('unexpected window create'),
            ensureMain: Effect.die('unexpected window ensure'),
            revealOrCreateMain: Effect.die('unexpected window reveal'),
            activate: Effect.die('unexpected window activate'),
            createMainIfBackendReady: Effect.die('unexpected window create'),
            showConnectingSplash: Effect.void,
            handleBackendReady: () =>
              Effect.sync(() =>
              {
                backendReadyCount += 1
              }).pipe(Effect.andThen(Deferred.succeed(backendReady, undefined)), Effect.asVoid),
            handleBackendNotReady: Effect.sync(() =>
            {
              backendNotReadyCount += 1
            }),
            flushMainWindowBounds: Effect.void,
            dispatchMenuAction: () => Effect.die('unexpected menu action'),
            zoomMain: () => Effect.die('unexpected zoom'),
            syncAppearance: Effect.void,
          },
        })

        yield* Effect.gen(function* ()
        {
          const pool = yield* DesktopBackendPool.DesktopBackendPool
          const primary = yield* pool.primary

          yield* primary.start
          yield* Deferred.await(backendReady)

          assert.equal(backendReadyCount, 1)
          assert.isTrue((yield* primary.snapshot).ready)

          yield* primary.stop()
          assert.equal(backendNotReadyCount, 1)
        }).pipe(Effect.provide(layer))
      }),
    ),
  )
})
