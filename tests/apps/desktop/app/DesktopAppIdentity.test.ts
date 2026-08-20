// tests/apps/desktop/app/DesktopAppIdentity.test.ts
// verify desktop app identity behavior

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import type * as Electron from 'electron'

import * as ElectronApp from '../../../../apps/desktop/src/electron/ElectronApp.ts'
import * as DesktopAppIdentity from '../../../../apps/desktop/src/app/DesktopAppIdentity.ts'
import * as DesktopAssets from '../../../../apps/desktop/src/app/DesktopAssets.ts'
import * as DesktopConfig from '../../../../apps/desktop/src/app/DesktopConfig.ts'
import * as DesktopEnvironment from '../../../../apps/desktop/src/app/DesktopEnvironment.ts'

const defaultEnvironmentInput = {
  dirname: '/repo/apps/desktop/dist-electron',
  homeDirectory: '/Users/alice',
  platform: 'darwin',
  processArch: 'arm64',
  appVersion: '1.2.3',
  appPath: '/Applications/456code.app/Contents/Resources/app.asar',
  isPackaged: true,
  resourcesPath: '/Applications/456code.app/Contents/Resources',
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>
}

interface ElectronAppCalls
{
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>
  readonly setDockIcon: string[]
  readonly setName: string[]
}

const makeElectronAppLayer = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die('unexpected metadata read'),
    name: Effect.succeed('456code'),
    systemLocale: Effect.die('unexpected system locale read'),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: (name) =>
      Effect.sync(() =>
      {
        calls.setName.push(name)
      }),
    setAboutPanelOptions: (options) =>
      Effect.sync(() =>
      {
        calls.setAboutPanelOptions.push(options)
      }),
    setAppUserModelId: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() =>
      {
        calls.setDockIcon.push(iconPath)
      }),
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp['Service'])

const makeAssetsLayer = (png: Option.Option<string>) =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png,
    }),
    resolveResourcePath: () => Effect.succeed(Option.none()),
  } satisfies DesktopAssets.DesktopAssets['Service'])

const makeEnvironmentLayer = (overrides: TestEnvironmentInput = {}) =>
{
  const { env, ...environmentOverrides } = overrides
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  )
}

const withIdentity = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppIdentity.DesktopAppIdentity
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  input: {
    readonly calls?: ElectronAppCalls
    readonly environment?: TestEnvironmentInput
    readonly packageJson?: string
    readonly pngIconPath?: Option.Option<string>
  } = {},
) =>
{
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setDockIcon: [],
    setName: [],
  }

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provideMerge(
          FileSystem.layerNoop({
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"code456CommitHash":"abcdef1234567890"}'),
          }),
        ),
        Layer.provideMerge(makeAssetsLayer(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(makeElectronAppLayer(calls)),
        Layer.provideMerge(makeEnvironmentLayer(input.environment)),
      ),
    ),
  )
}

describe('DesktopAppIdentity', () =>
{
  it.effect('resolves the userData path from the app data directory', () =>
    withIdentity(
      Effect.gen(function* ()
      {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity
        const userDataPath = yield* identity.resolveUserDataPath

        assert.equal(userDataPath, '/Users/alice/Library/Application Support/456code')
      }),
    ),
  )

  it.effect('configures app identity from the environment commit override', () =>
  {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    }

    return withIdentity(
      Effect.gen(function* ()
      {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity
        yield* identity.configure

        assert.deepEqual(calls.setName, ['456code (Alpha)'])
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, '456code (Alpha)')
        assert.equal(calls.setAboutPanelOptions[0]?.applicationVersion, '1.2.3')
        assert.equal(calls.setAboutPanelOptions[0]?.version, '0123456789ab')
        assert.deepEqual(calls.setDockIcon, [])
      }),
      {
        calls,
        environment: {
          env: {
            T3CODE_COMMIT_HASH: '0123456789abcdef',
          },
        },
        pngIconPath: Option.some('/icon.png'),
      },
    )
  })

  it.effect('sets the dock icon only when running unpackaged', () =>
  {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    }

    return withIdentity(
      Effect.gen(function* ()
      {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity
        yield* identity.configure

        assert.deepEqual(calls.setDockIcon, ['/icon.png'])
      }),
      {
        calls,
        environment: { isPackaged: false },
        pngIconPath: Option.some('/icon.png'),
      },
    )
  })
})
