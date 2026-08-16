// tests/apps/desktop/ipc/methods/window.test.ts
// verify desktop window ipc behavior

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import type * as Electron from 'electron'

import * as DesktopBackendManager from '../../../../../apps/desktop/src/backend/DesktopBackendManager.ts'
import * as DesktopBackendPool from '../../../../../apps/desktop/src/backend/DesktopBackendPool.ts'
import * as ElectronApp from '../../../../../apps/desktop/src/electron/ElectronApp.ts'
import * as ElectronWindow from '../../../../../apps/desktop/src/electron/ElectronWindow.ts'
import {
  getLocalEnvironmentBootstraps,
  getSystemLocale,
  getWindowFullscreenState,
} from '../../../../../apps/desktop/src/ipc/methods/window.ts'

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: 'wsl.exe',
  args: ['-d', 'Ubuntu', '--', 'node', '/app/bin.mjs'],
  entryPath: '/app/bin.mjs',
  cwd: '/app',
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: 'desktop',
    noBrowser: true,
    port: 3774,
    host: '0.0.0.0',
    desktopBootstrapToken: 'bootstrap-token',
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: 'stdin',
  httpBaseUrl: new URL('http://127.0.0.1:3774'),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: 'Ubuntu',
}

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId('wsl:default'),
  label: Effect.succeed('WSL (default distro)'),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    preflightFailure: Option.none(),
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
}

describe('getLocalEnvironmentBootstraps', () =>
{
  it.effect('publishes the concrete running distro without replacing the stable instance id', () =>
    Effect.gen(function* ()
    {
      const result = yield* getLocalEnvironmentBootstraps.handler()

      assert.deepEqual(result, [
        {
          id: 'wsl:default',
          label: 'WSL (Ubuntu)',
          runningDistro: 'Ubuntu',
          httpBaseUrl: 'http://127.0.0.1:3774/',
          wsBaseUrl: 'ws://127.0.0.1:3774/',
          bootstrapToken: 'bootstrap-token',
        },
      ])
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  )

  it.effect('publishes a pending bootstrap only while a transient retry is scheduled', () =>
  {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: 'WSL probe timed out',
        fatal: false,
        retryLimit: 12,
      }),
    }
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        // preflight state is reported on the snapshot now (megacore U-133)
        preflightFailure: retryingConfig.preflightFailure,
        restartScheduled: true,
      }),
    }

    return Effect.gen(function* ()
    {
      const result = yield* getLocalEnvironmentBootstraps.handler()
      assert.deepEqual(result, [
        {
          id: 'wsl:default',
          label: 'WSL (default distro)',
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ])
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])))
  })

  it.effect('omits a bounded transient bootstrap after retries stop', () =>
  {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: 'WSL probe timed out',
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        preflightFailure: Option.some({
          reason: 'WSL probe timed out',
          fatal: false,
          retryLimit: 12,
        }),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    }

    return Effect.gen(function* ()
    {
      const result = yield* getLocalEnvironmentBootstraps.handler()
      assert.deepEqual(result, [])
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])))
  })
})

describe('getWindowFullscreenState', () =>
{
  it.effect('reads the current native window state', () =>
  {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow

    return Effect.gen(function* ()
    {
      assert.isTrue(yield* getWindowFullscreenState.handler())
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      ),
    )
  })
})

describe('getSystemLocale', () =>
{
  it.effect('returns the normalized OS locale from the Electron app service', () =>
    Effect.gen(function* ()
    {
      assert.strictEqual(yield* getSystemLocale.handler(), 'en-GB')
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronApp.ElectronApp)({
          systemLocale: Effect.succeed('en-GB'),
        }),
      ),
    ),
  )
})
