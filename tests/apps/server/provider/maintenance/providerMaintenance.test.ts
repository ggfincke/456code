// tests/apps/server/provider/maintenance/providerMaintenance.test.ts
// verify provider maintenance ownership and advisory behavior

// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from '@effect/vitest'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  homebrewOwnershipFromCommandPath,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  ProviderVersionCache,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from '../../../../../apps/server/src/provider/maintenance/providerMaintenance.ts'

const driver = (value: string) => ProviderDriverKind.make(value)
const windowsHost = HostProcessPlatform.defaultValue() === 'win32'
const symlinksSupported = !windowsHost
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.map((id) => NodePath.join(NodeOS.tmpdir(), `${name}-${id}`)),
  )

const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver('packageTool'),
  npmPackageName: '@example/package-tool',
  nativeUpdate: null,
})
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver('nativePackageTool'),
  npmPackageName: '@example/native-package-tool',
  nativeUpdate: {
    args: ['update', '--home', "/Users/O'Connor/Tool Home"],
    isCommandPath: (commandPath) =>
      normalizeCommandPath(commandPath).includes('/.local/bin/native-package-tool'),
    env: { TOOL_HOME: '/provider/home' },
  },
})
const manualPackageTool: ProviderMaintenanceCapabilities = {
  provider: driver('packageTool'),
  packageName: '@example/package-tool',
  update: null,
}
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make('packageTool'),
  driver: driver('packageTool'),
  enabled: true,
  installed: true,
  version: '1.0.0',
  status: 'ready',
  auth: { status: 'authenticated' },
  checkedAt: '2026-04-10T00:00:00.000Z',
  models: [],
  slashCommands: [],
  skills: [],
}

function writeExecutable(path: string)
{
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true })
  NodeFS.writeFileSync(path, '#!/bin/sh\n')
  NodeFS.chmodSync(path, 0o755)
}

// mirror the package entry-point symlinks used by global package managers
function linkIntoPackage(
  tempDir: string,
  name: string,
  packageSegments: ReadonlyArray<string>,
): string
{
  const target = NodePath.join(tempDir, ...packageSegments, 'bin', `${name}.js`)
  writeExecutable(target)
  const link = NodePath.join(tempDir, 'bin', name)
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true })
  NodeFS.symlinkSync(target, link)
  return link
}

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die('maintenance resolution should not spawn a process here'),
)

function stdoutSpawner(onSpawn: (command: string, args: ReadonlyArray<string>) => string)
{
  return ChildProcessSpawner.make((command) =>
  {
    const { command: executable, args } = command as unknown as {
      readonly command: string
      readonly args: ReadonlyArray<string>
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    )
  })
}

it.layer(NodeServices.layer)('providerMaintenance', (it) =>
{
  it.effect('reads cached npm versions through the injectable cache', () =>
    resolveLatestProviderVersion(manualPackageTool).pipe(
      Effect.provideService(
        ProviderVersionCache,
        new Map([
          ['@example/package-tool', { expiresAt: Number.MAX_SAFE_INTEGER, version: '9.9.9' }],
        ]),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die('cached version should not make an HTTP request')),
      ),
      Effect.map((version) => expect(version).toBe('9.9.9')),
    ),
  )

  it.effect("prefers the installer's latest version over npm", () =>
    resolveLatestProviderVersion({ ...manualPackageTool, latestVersion: '1.2.0' }).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die('installer version should not make an HTTP request')),
      ),
      Effect.map((version) => expect(version).toBe('1.2.0')),
    ),
  )

  it.effect('skips update checks when disabled', () =>
    enrichProviderSnapshotWithVersionAdvisory(installedPackageToolProvider, manualPackageTool, {
      enableProviderUpdateChecks: false,
    }).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die('disabled checks should not make an HTTP request')),
      ),
      Effect.map((provider) =>
      {
        expect(provider.versionAdvisory).toMatchObject({
          status: 'unknown',
          currentVersion: '1.0.0',
          latestVersion: null,
        })
      }),
    ),
  )

  it('keeps the manual hint when an unowned install is behind', () =>
  {
    expect(
      createProviderVersionAdvisory({
        driver: driver('packageTool'),
        currentVersion: '2.1.110',
        latestVersion: '2.1.117',
        maintenanceCapabilities: manualPackageTool,
      }),
    ).toMatchObject({
      status: 'behind_latest',
      updateCommand: null,
      canUpdate: false,
      message: 'Install the update now or review provider settings.',
    })
  })

  it.each([
    {
      name: 'unknown current version',
      currentVersion: null,
      latestVersion: '9.9.9',
      expected: { status: 'unknown', currentVersion: null, latestVersion: '9.9.9' },
    },
    {
      name: 'unknown latest version',
      currentVersion: '1.0.0',
      latestVersion: null,
      expected: {
        status: 'unknown',
        currentVersion: '1.0.0',
        latestVersion: null,
        message: null,
      },
    },
  ])('marks a provider with an $name as unknown', ({ currentVersion, latestVersion, expected }) =>
  {
    expect(
      createProviderVersionAdvisory({
        driver: driver('packageTool'),
        currentVersion,
        latestVersion,
      }),
    ).toMatchObject(expected)
  })

  it.effect('stays manual-only when the binary cannot be located', () =>
    resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
      binaryPath: 'package-tool',
      env: { PATH: '' },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.map((capabilities) => expect(capabilities).toEqual(manualPackageTool)),
    ),
  )

  it.effect.skipIf(!symlinksSupported)(
    'pins npm updates to the owning global prefix and preserves the instance environment',
    () =>
      Effect.gen(function* ()
      {
        const tempDir = yield* makeTempDir('456code-npm-capabilities')
        const link = linkIntoPackage(tempDir, 'package-tool', [
          'lib',
          'node_modules',
          '@example',
          'package-tool',
        ])
        const realTempDir = NodeFS.realpathSync(tempDir)
        const env = { PATH: '', PROVIDER_SCOPE: 'personal' }
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          { binaryPath: link, env },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn))

        expect(capabilities.update).toEqual({
          command: `npm install -g --prefix ${realTempDir} --allow-scripts=@example/package-tool @example/package-tool@latest`,
          executable: 'npm',
          args: [
            'install',
            '-g',
            '--prefix',
            realTempDir,
            '--allow-scripts=@example/package-tool',
            '@example/package-tool@latest',
          ],
          lockKey: `npm-global:${normalizeCommandPath(realTempDir)}`,
          env,
        })
      }),
  )

  it('derives npm ownership only from a matching global package layout', () =>
  {
    expect(
      npmGlobalPrefixFromCommandPath(
        '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
        '@openai/codex',
      ),
    ).toBe('/usr/local')
    expect(
      npmGlobalPrefixFromCommandPath(
        '/usr/local/lib/node_modules/other/node_modules/@openai/codex/bin/codex.js',
        '@openai/codex',
      ),
    ).toBeNull()
    expect(
      npmGlobalPrefixFromCommandPath(
        '/work/app/node_modules/@openai/codex/bin/codex.js',
        '@openai/codex',
      ),
    ).toBeNull()
    expect(
      npmGlobalPrefixFromCommandPath(
        '/usr/local/lib/node_modules/@OPENAI/CODEX/bin/codex.js',
        '@openai/codex',
        'linux',
      ),
    ).toBeNull()
  })

  it.effect('proves Windows npm ownership from the manifest beside the shim', () =>
    Effect.gen(function* ()
    {
      const tempDir = yield* makeTempDir('456code-npm-windows')
      const shim = NodePath.join(tempDir, 'package-tool.cmd')
      NodeFS.mkdirSync(NodePath.join(tempDir, 'node_modules', '@example', 'package-tool'), {
        recursive: true,
      })
      NodeFS.writeFileSync(shim, '@echo off\r\n')
      NodeFS.writeFileSync(
        NodePath.join(tempDir, 'node_modules', '@example', 'package-tool', 'package.json'),
        '{}',
      )

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: shim,
        env: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      }).pipe(
        Effect.provideService(HostProcessPlatform, 'win32'),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      )
      expect(capabilities.update).toMatchObject({
        executable: 'npm',
        args: ['install', '-g', '--prefix', tempDir, expect.any(String), expect.any(String)],
      })
    }),
  )

  it.effect.skipIf(!symlinksSupported)('detects pnpm ownership from the real package path', () =>
    Effect.gen(function* ()
    {
      const tempDir = yield* makeTempDir('456code-pnpm-capabilities')
      const link = linkIntoPackage(tempDir, 'package-tool', [
        '.local',
        'share',
        'pnpm',
        'global',
        '5',
        'node_modules',
        '@example',
        'package-tool',
      ])
      const env = { PATH: '', PROVIDER_SCOPE: 'work' }
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: link,
        env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn))
      expect(capabilities.update).toMatchObject({
        command: 'pnpm add -g @example/package-tool@latest',
        lockKey: 'pnpm-global',
        env,
      })
    }),
  )

  it.effect.skipIf(windowsHost)('detects Bun ownership from its global bin', () =>
    Effect.gen(function* ()
    {
      const tempDir = yield* makeTempDir('456code-bun-capabilities')
      const bunBinDir = NodePath.join(tempDir, '.bun', 'bin')
      writeExecutable(NodePath.join(bunBinDir, 'package-tool'))
      const env = { PATH: bunBinDir }
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: 'package-tool',
        env,
      }).pipe(
        Effect.provideService(HostProcessPlatform, 'darwin'),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      )
      expect(capabilities.update).toMatchObject({
        command: 'bun i -g @example/package-tool@latest',
        lockKey: 'bun-global',
        env,
      })
    }),
  )

  it.effect.skipIf(windowsHost)(
    'uses the resolved native executable and merges instance and updater environments',
    () =>
      Effect.gen(function* ()
      {
        const tempDir = yield* makeTempDir('456code-native-capabilities')
        const nativePath = NodePath.join(tempDir, '.local', 'bin', 'native-package-tool')
        writeExecutable(nativePath)
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          {
            binaryPath: nativePath,
            env: { PATH: '', PROVIDER_SCOPE: 'personal', TOOL_HOME: 'old' },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn))

        expect(capabilities.update).toMatchObject({
          executable: nativePath,
          args: ['update', '--home', "/Users/O'Connor/Tool Home"],
          lockKey: 'nativePackageTool-native',
          env: { PATH: '', PROVIDER_SCOPE: 'personal', TOOL_HOME: '/provider/home' },
        })
        expect(capabilities.update?.command).toBe(
          `${nativePath} update --home '/Users/O'\\''Connor/Tool Home'`,
        )
      }),
  )

  it('quotes copied POSIX and PowerShell words without changing raw argv', () =>
  {
    const posix = makeProviderMaintenanceCapabilities({
      provider: driver('packageTool'),
      packageName: null,
      updateExecutable: "/Users/O'Connor/My Tools/tool",
      updateArgs: ['update', '--path', '/tmp/Tool Home'],
      updateLockKey: 'tool',
      platform: 'darwin',
    })
    expect(posix.update).toMatchObject({
      command: "'/Users/O'\\''Connor/My Tools/tool' update --path '/tmp/Tool Home'",
      executable: "/Users/O'Connor/My Tools/tool",
      args: ['update', '--path', '/tmp/Tool Home'],
    })

    const capabilities = makeProviderMaintenanceCapabilities({
      provider: driver('packageTool'),
      packageName: '@example/package-tool',
      updateExecutable: 'C:\\Program Files\\Tool\\tool.exe',
      updateArgs: ['update', '--prefix', "C:\\Users\\O'Connor\\Tool Home"],
      updateLockKey: 'tool',
      platform: 'win32',
    })
    expect(capabilities.update).toMatchObject({
      command:
        "& 'C:\\Program Files\\Tool\\tool.exe' update --prefix 'C:\\Users\\O''Connor\\Tool Home'",
      args: ['update', '--prefix', "C:\\Users\\O'Connor\\Tool Home"],
    })
  })

  it.effect.skipIf(!symlinksSupported)(
    'prefers npm ownership over the Homebrew Node keg containing the package',
    () =>
      Effect.gen(function* ()
      {
        const tempDir = yield* makeTempDir('456code-homebrew-node')
        const keg = NodePath.join(tempDir, 'Cellar', 'node', '22.1.0')
        const link = linkIntoPackage(tempDir, 'package-tool', [
          'Cellar',
          'node',
          '22.1.0',
          'lib',
          'node_modules',
          '@example',
          'package-tool',
        ])
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          { binaryPath: link, env: { PATH: '' } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn))
        expect(capabilities.update).toMatchObject({
          executable: 'npm',
          args: expect.arrayContaining(['--prefix', NodeFS.realpathSync(keg)]),
          lockKey: `npm-global:${normalizeCommandPath(NodeFS.realpathSync(keg))}`,
        })
      }),
  )

  it('recognizes Homebrew formulae and casks only from owned real paths', () =>
  {
    expect(
      homebrewOwnershipFromCommandPath('/opt/homebrew/Cellar/claude-code@latest/2.1.0/bin/claude'),
    ).toEqual({ kind: 'formula', name: 'claude-code@latest', prefix: '/opt/homebrew' })
    expect(homebrewOwnershipFromCommandPath('/usr/local/Caskroom/codex/0.148.0/codex')).toEqual({
      kind: 'cask',
      name: 'codex',
      prefix: '/usr/local',
    })
    expect(homebrewOwnershipFromCommandPath('/usr/local/bin/codex')).toBeNull()
  })

  it.effect.skipIf(windowsHost)(
    'requires Homebrew metadata to prove the derived package name',
    () =>
      Effect.gen(function* ()
      {
        const tempDir = yield* makeTempDir('456code-homebrew-identity')
        const brewBinDir = NodePath.join(tempDir, 'brew-bin')
        writeExecutable(NodePath.join(brewBinDir, 'brew'))
        const suspiciousBinary = NodePath.join(
          tempDir,
          'Cellar',
          'tool;touch marker',
          '1.0.0',
          'bin',
          'tool',
        )
        writeExecutable(suspiciousBinary)
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          { binaryPath: suspiciousBinary, env: { PATH: brewBinDir } },
        ).pipe(
          Effect.provideService(HostProcessPlatform, 'darwin'),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner((_command, args) =>
              args[0] === '--prefix'
                ? `${tempDir}\n`
                : JSON.stringify({ formulae: [{ name: 'different-tool' }] }),
            ),
          ),
        )
        expect(capabilities).toEqual(manualPackageTool)
      }),
  )

  it.effect.each([
    { directory: 'Caskroom', name: 'package-tool', kind: 'cask' },
    { directory: 'Cellar', name: 'package-tool@latest', kind: 'formula' },
  ] as const)(
    'uses the owning Homebrew $kind and its latest version',
    (fixture) =>
      Effect.gen(function* ()
      {
        const tempDir = yield* makeTempDir('456code-homebrew-capabilities')
        const brewBinDir = NodePath.join(tempDir, 'brew-bin')
        const brewPath = NodePath.join(brewBinDir, 'brew')
        writeExecutable(brewPath)
        const ownedBinary = NodePath.join(
          tempDir,
          fixture.directory,
          fixture.name,
          '0.148.0',
          'package-tool',
        )
        writeExecutable(ownedBinary)
        const link = NodePath.join(tempDir, 'bin', 'custom-package-tool')
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true })
        NodeFS.symlinkSync(ownedBinary, link)
        const spawned: Array<ReadonlyArray<string>> = []
        const env = { PATH: brewBinDir, PROVIDER_SCOPE: 'work' }
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          { binaryPath: link, env },
        ).pipe(
          Effect.provideService(HostProcessPlatform, 'darwin'),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner((command, args) =>
            {
              spawned.push([command, ...args])
              return args[0] === '--prefix'
                ? `${tempDir}\n`
                : JSON.stringify(
                    fixture.kind === 'cask'
                      ? { casks: [{ token: fixture.name, version: '0.148.0,42' }] }
                      : {
                          formulae: [{ name: fixture.name, versions: { stable: '0.148.0' } }],
                        },
                  )
            }),
          ),
        )
        expect(spawned).toEqual([
          [brewPath, '--prefix'],
          [brewPath, 'info', '--json=v2', fixture.name],
        ])
        expect(capabilities).toMatchObject({
          latestVersion: '0.148.0',
          update: {
            command:
              fixture.kind === 'cask'
                ? `brew upgrade --cask ${fixture.name}`
                : `brew upgrade ${fixture.name}`,
            executable: brewPath,
            lockKey: 'homebrew',
            env,
          },
        })
      }),
    { skip: !symlinksSupported },
  )

  it.effect.skipIf(windowsHost)('rejects a Homebrew prefix that differs only by case', () =>
    Effect.gen(function* ()
    {
      const tempDir = yield* makeTempDir('456code-homebrew-foreign-prefix')
      const brewBinDir = NodePath.join(tempDir, 'brew-bin')
      writeExecutable(NodePath.join(brewBinDir, 'brew'))
      const ownedPrefix = NodePath.join(tempDir, 'Brew')
      const kegBinary = NodePath.join(
        ownedPrefix,
        'Cellar',
        'package-tool',
        '1.0.0',
        'bin',
        'package-tool',
      )
      writeExecutable(kegBinary)
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: kegBinary,
        env: { PATH: brewBinDir },
      }).pipe(
        Effect.provideService(HostProcessPlatform, 'darwin'),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner(() => `${NodePath.join(tempDir, 'brew')}\n`),
        ),
      )
      expect(capabilities).toEqual(manualPackageTool)
    }),
  )

  it.effect.skipIf(windowsHost)('keeps an unresolved custom path manual-only', () =>
    Effect.gen(function* ()
    {
      const tempDir = yield* makeTempDir('456code-custom-capabilities')
      const customPath = NodePath.join(tempDir, 'tools', 'package-tool')
      writeExecutable(customPath)
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: customPath,
        env: { PATH: '' },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn))
      expect(capabilities).toEqual(manualPackageTool)
    }),
  )

  it.effect('caches ownership until a fresh read is requested', () =>
    Effect.gen(function* ()
    {
      let resolutions = 0
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.sync(() =>
        {
          resolutions += 1
          return manualPackageTool
        }),
      )
      yield* resolve()
      yield* resolve()
      expect(resolutions).toBe(1)
      yield* resolve({ fresh: true })
      yield* resolve()
      expect(resolutions).toBe(2)
    }),
  )
})
