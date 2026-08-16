// tests/scripts/build-desktop-artifact.test.ts
// verify build desktop artifact behavior

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { ChildProcessSpawner } from 'effect/unstable/process'

import {
  BuildCommandFailedError,
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  createBuildConfig,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_ASAR_UNPACK,
  hashFileSha256,
  InvalidMockUpdateServerPortError,
  LinuxIconResizeError,
  resolveDesktopRuntimeDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  packWindowsServerAsar,
  validateWindowsPackagedPayload,
  validateWindowsServerSidecar,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_PAYLOAD_DIGEST_RESOURCE,
  WINDOWS_SERVER_REQUIRED_ENTRIES,
} from '../../scripts/build-desktop-artifact.ts'
import { BRAND_ASSET_PATHS } from '../../scripts/lib/brand-assets.ts'
import { HostProcessArchitecture, HostProcessPlatform } from '@t3tools/shared/hostProcess'

function mockProcess(exitCode: number)
{
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  })
}

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
)
{
  let commandIndex = 0
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
    {
      const childProcess = command as unknown as {
        readonly command: string
        readonly args: ReadonlyArray<string>
      }
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      })
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0))
    }),
  )
}

const stageWindowsServerFixture = Effect.fn('test.stageWindowsServerFixture')(function* (
  sourceDir: string,
)
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  for (const entry of WINDOWS_SERVER_REQUIRED_ENTRIES)
  {
    const entryPath = path.join(sourceDir, ...entry.split('/'))
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true })
    yield* fs.writeFileString(
      entryPath,
      entry.endsWith('bin.mjs') ? "console.log('fixture-version')\n" : '{}\n',
    )
  }
  const nativePath = path.join(sourceDir, 'node_modules/node-pty/build/Release/pty.node')
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true })
  yield* fs.writeFileString(nativePath, 'native-fixture')
  yield* fs.makeDirectory(path.join(sourceDir, 'node_modules/.bin'), { recursive: true })
  yield* fs.writeFileString(path.join(sourceDir, 'node_modules/.bin/unused'), 'ignored')
  return nativePath
})

it.layer(NodeServices.layer)('build-desktop-artifact', (it) =>
{
  it('resolves nightly vs latest desktop branding from the version channel', () =>
  {
    const latestVersion = '0.0.17'
    const nightlyVersion = '0.0.17-nightly.20260413.42'

    assert.equal(resolveDesktopUpdateChannel(latestVersion), 'latest')
    assert.equal(resolveDesktopUpdateChannel(nightlyVersion), 'nightly')

    assert.equal(resolveDesktopProductName(latestVersion), '456code (Alpha)')
    assert.equal(resolveDesktopProductName(nightlyVersion), '456code (Nightly)')

    assert.deepStrictEqual(resolveDesktopBuildIconAssets(latestVersion, false), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    })
    assert.deepStrictEqual(resolveDesktopBuildIconAssets(nightlyVersion, false), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    })

    assert.equal(resolveDesktopWebAssetBrand(latestVersion, false), 'production')
    assert.equal(resolveDesktopWebAssetBrand(nightlyVersion, false), 'nightly')
  })

  it.effect('resolves GitHub desktop publish config from Effect config', () =>
    Effect.gen(function* ()
    {
      const latestConfig = yield* resolveGitHubPublishConfig('latest').pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: 'pingdotgg/t3code',
              },
            }),
          ),
        ),
      )
      const nightlyConfig = yield* resolveGitHubPublishConfig('nightly').pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: 'pingdotgg/t3code',
              },
            }),
          ),
        ),
      )

      assert.deepStrictEqual(latestConfig, {
        provider: 'github',
        owner: 'pingdotgg',
        repo: 't3code',
        releaseType: 'release',
      })
      assert.deepStrictEqual(nightlyConfig, {
        provider: 'github',
        owner: 'pingdotgg',
        repo: 't3code',
        releaseType: 'prerelease',
        channel: 'nightly',
      })
    }),
  )

  it('omits bundled workspace packages from staged desktop dependencies', () =>
  {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          '@effect/platform-node': 'catalog:',
          '@t3tools/contracts': 'workspace:*',
          '@t3tools/shared': 'workspace:*',
          '@t3tools/ssh': 'workspace:*',
          '@t3tools/tailscale': 'workspace:*',
          effect: 'catalog:',
          electron: '41.5.0',
        },
        {
          '@effect/platform-node': '4.0.0-beta.59',
          effect: '4.0.0-beta.59',
        },
      ),
      {
        '@effect/platform-node': '4.0.0-beta.59',
        effect: '4.0.0-beta.59',
      },
    )
  })

  it('carries only staged dependency patch metadata into staged desktop installs', () =>
  {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          '@expo/metro-config@56.0.13': 'patches/@expo%2Fmetro-config@56.0.13.patch',
          '@ff-labs/fff-node@0.9.4': 'patches/@ff-labs__fff-node@0.9.4.patch',
          '@pierre/diffs@1.1.20': 'patches/@pierre%2Fdiffs@1.1.20.patch',
          'alchemy@2.0.0-beta.49': 'patches/alchemy@2.0.0-beta.49.patch',
          'effect@4.0.0-beta.73': 'patches/effect@4.0.0-beta.73.patch',
        },
        {
          '@ff-labs/fff-node': '0.9.4',
          '@pierre/diffs': '1.1.20',
          effect: '4.0.0-beta.73',
        },
      ),
      {
        '@ff-labs/fff-node@0.9.4': 'patches/@ff-labs__fff-node@0.9.4.patch',
        '@pierre/diffs@1.1.20': 'patches/@pierre%2Fdiffs@1.1.20.patch',
        'effect@4.0.0-beta.73': 'patches/effect@4.0.0-beta.73.patch',
      },
    )

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          '@expo/metro-config@56.0.13': 'patches/@expo%2Fmetro-config@56.0.13.patch',
        },
        { effect: '4.0.0-beta.73' },
      ),
      {},
    )
  })

  it('installs optional native dependencies for the target desktop architecture', () =>
  {
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: 'mac', arch: 'x64' }), {
      supportedArchitectures: {
        os: ['darwin'],
        cpu: ['x64'],
      },
    })
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: 'linux', arch: 'x64' }), {
      supportedArchitectures: {
        os: ['linux'],
        cpu: ['x64'],
        libc: ['glibc'],
      },
    })
    // the app stage is win32-only; the server sidecar separately opts into a
    // physical dual-platform dependency tree for the primary and WSL backends
    for (const arch of ['x64', 'arm64'] as const)
    {
      assert.deepStrictEqual(createStageWorkspaceConfig({ platform: 'win', arch }), {
        supportedArchitectures: {
          os: ['win32'],
          cpu: [arch],
        },
      })
      assert.deepStrictEqual(
        createStageWorkspaceConfig({ platform: 'win', arch, linuxServerBackend: true }),
        {
          supportedArchitectures: {
            os: ['win32', 'linux'],
            cpu: [arch],
            libc: ['glibc'],
          },
          nodeLinker: 'hoisted',
        },
      )
    }
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: 'mac', arch: 'universal' }), {
      supportedArchitectures: {
        os: ['darwin'],
        cpu: ['arm64', 'x64'],
      },
    })
  })

  it('stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml', () =>
  {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: 'linux',
        arch: 'x64',
        allowBuilds: {
          electron: true,
          'node-pty': true,
          'browser-tabs-lock': false,
        },
        patchedDependencies: {
          'effect@4.0.0-beta.73': 'patches/effect@4.0.0-beta.73.patch',
        },
        overrides: {
          effect: '4.0.0-beta.73',
        },
      }),
      {
        supportedArchitectures: {
          os: ['linux'],
          cpu: ['x64'],
          libc: ['glibc'],
        },
        allowBuilds: {
          electron: true,
          'node-pty': true,
          'browser-tabs-lock': false,
        },
        patchedDependencies: {
          'effect@4.0.0-beta.73': 'patches/effect@4.0.0-beta.73.patch',
        },
        overrides: {
          effect: '4.0.0-beta.73',
        },
      },
    )

    // empty maps must not be written — pnpm would still require reviewed
    // packages if allowBuilds is present but incomplete, and omitting empty
    // patchedDependencies keeps the stage yaml minimal.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: 'mac',
        arch: 'arm64',
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ['darwin'],
          cpu: ['arm64'],
        },
      },
    )
  })

  it('unpacks the fff shared library for filesystem and FFI access', () =>
  {
    assert.deepStrictEqual(DESKTOP_ASAR_UNPACK, ['node_modules/@ff-labs/fff-bin-*/**/*'])
  })

  it.effect('preserves both Linux icon resize failures with structural context', () =>
  {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = []

    return Effect.gen(function* ()
    {
      const error = yield* stageLinuxIconSize('source.png', 'target.png', 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      )

      assert.instanceOf(error, LinuxIconResizeError)
      assert.equal(error.operation, 'resize')
      assert.equal(error.iconSize, 512)
      assert.equal(error.primaryTool, 'magick')
      assert.equal(error.fallbackTool, 'convert')
      assert.include(error.message, '512x512')
      assert.include(error.message, '`magick`')
      assert.include(error.message, '`convert`')
      assert.notInclude(error.message, 'non-zero exit code')

      assert.instanceOf(error.cause, AggregateError)
      const aggregateCause = error.cause as AggregateError
      assert.lengthOf(aggregateCause.errors, 2)
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0])
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError)
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError)
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError
      assert.equal(primaryError.command, 'magick linux icon 512x512')
      assert.equal(primaryError.exitCode, 1)
      assert.include(primaryError.message, 'magick linux icon')
      assert.equal(fallbackError.command, 'convert linux icon 512x512')
      assert.equal(fallbackError.exitCode, 2)
      assert.include(fallbackError.message, 'convert linux icon')
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ['magick', 'convert'],
      )
    })
  })

  it.effect('adds both renderer protocols to signed macOS builds', () =>
    Effect.gen(function* ()
    {
      const config = yield* createBuildConfig('mac', 'dmg', '1.2.3', true, false, undefined)

      const mac = config.mac as Record<string, unknown>
      assert.equal(config.appId, 'com.ggfincke.456code')
      assert.deepStrictEqual(config.files, DESKTOP_FILE_EXCLUSIONS)
      assert.deepStrictEqual(config.asarUnpack, DESKTOP_ASAR_UNPACK)
      assert.notProperty(config, 'extraResources')
      assert.deepStrictEqual(mac.protocols, [
        { name: '456code', schemes: ['code456', 'code456-dev'] },
      ])
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  )

  it.effect('keeps executable resource editing enabled for unsigned Windows builds', () =>
    Effect.gen(function* ()
    {
      const config = yield* createBuildConfig('win', 'nsis', '1.2.3', false, false, undefined)

      const win = config.win as Record<string, unknown>
      assert.equal(win.icon, 'icon.ico')
      assert.equal(win.signAndEditExecutable, true)
      assert.notProperty(win, 'azureSignOptions')
      assert.notProperty(config, 'asarUnpack')
      assert.deepStrictEqual(config.extraResources, WINDOWS_SERVER_EXTRA_RESOURCES)
      assert.deepStrictEqual(config.nsis, { differentialPackage: true })
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  )

  it.effect('keeps the Windows acceptance script portable and bounded', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const acceptanceScript = yield* fs.readFileString(
        path.resolve(import.meta.dirname, '../../scripts/windows-desktop-acceptance.ps1'),
      )
      const updateFeed = yield* fs.readFileString(
        path.resolve(import.meta.dirname, '../../scripts/windows-desktop-update-feed.mjs'),
      )
      const ciWorkflow = yield* fs.readFileString(
        path.resolve(import.meta.dirname, '../../.github/workflows/ci.yml'),
      )
      const numericSeparators =
        acceptanceScript.match(
          /\b(?:0[xX][\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|\d+)_[\dA-Fa-f_]+\b/gu,
        ) ?? []
      const totalBudget = /\$script:AcceptanceTimeoutSeconds = (\d+)/u.exec(acceptanceScript)
      const cimQueries = acceptanceScript.match(/^.*Get-CimInstance Win32_Process.*$/gmu) ?? []

      assert.deepStrictEqual(numericSeparators, [])
      assert.equal(Number(totalBudget?.[1]), 1_500)
      assert.notInclude(acceptanceScript, '[Threading.CancellationToken]::None')
      assert.notMatch(acceptanceScript, /(?:^|\s)-Wait\b/gu)
      assert.isAbove(cimQueries.length, 0)
      assert.isTrue(cimQueries.every((query) => query.includes('-OperationTimeoutSec')))
      assert.include(updateFeed, 'NodeStreamPromises.pipeline(')
      assert.include(updateFeed, 'AbortSignal.timeout(RESPONSE_TIMEOUT_MS)')
      assert.include(updateFeed, 'server.setTimeout(')
      assert.include(updateFeed, 'server.closeAllConnections()')
      assert.match(
        ciWorkflow,
        /- name: Exercise installed package and updater paths\s+shell: pwsh\s+timeout-minutes: 30/u,
      )
    }),
  )

  it.effect('packs a digest-addressed Windows server sidecar with exact native unpacking', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: '456code-windows-sidecar-test-',
        })
        const sourceDir = path.join(tempDir, 'source')
        const asarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE)
        const digestPath = path.join(tempDir, WINDOWS_SERVER_PAYLOAD_DIGEST_RESOURCE)
        yield* stageWindowsServerFixture(sourceDir)

        const packed = yield* packWindowsServerAsar({ sourceDir, asarPath, digestPath })
        assert.match(packed.payloadDigest, /^[0-9a-f]{64}$/u)
        assert.equal((yield* fs.readFileString(digestPath)).trim(), packed.payloadDigest)
        assert.equal(yield* hashFileSha256(asarPath), packed.payloadDigest)
        assert.deepStrictEqual(packed.unpackedFiles, [
          'node_modules/node-pty/build/Release/pty.node',
        ])
        assert.isTrue(
          yield* fs.exists(
            path.join(`${asarPath}.unpacked`, 'node_modules/node-pty/build/Release/pty.node'),
          ),
        )

        yield* fs.writeFileString(digestPath, `${'b'.repeat(64)}\n`)
        const digestError = yield* validateWindowsServerSidecar({ asarPath, digestPath }).pipe(
          Effect.flip,
        )
        assert.include(digestError.message, 'payload digest mismatch')

        yield* fs.writeFileString(digestPath, `${packed.payloadDigest}\n`)
        yield* fs.remove(
          path.join(`${asarPath}.unpacked`, 'node_modules/node-pty/build/Release/pty.node'),
        )
        const nativeError = yield* validateWindowsServerSidecar({ asarPath, digestPath }).pipe(
          Effect.flip,
        )
        assert.include(nativeError.message, 'unpacked native files are missing')
      }),
    ),
  )

  it.effect('rejects links in the Windows server sidecar contract', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: '456code-windows-sidecar-link-test-',
        })
        const sourceDir = path.join(tempDir, 'source')
        yield* stageWindowsServerFixture(sourceDir)
        yield* fs.symlink('zod', path.join(sourceDir, 'node_modules/zod-link'))

        const error = yield* packWindowsServerAsar({
          sourceDir,
          asarPath: path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE),
        }).pipe(Effect.flip)
        assert.include(error.message, 'unsupported link entries')
        assert.include(error.message, 'node_modules/zod-link')
      }),
    ),
  )

  it.effect('rejects a packaged Windows payload above the loose-file budget', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: '456code-windows-payload-limit-test-',
        })
        const packagedAppDir = path.join(tempDir, 'dist/win-unpacked')
        const resourcesDir = path.join(packagedAppDir, 'resources')
        const sourceDir = path.join(tempDir, 'source')
        yield* stageWindowsServerFixture(sourceDir)
        yield* packWindowsServerAsar({
          sourceDir,
          asarPath: path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE),
        })
        yield* fs.writeFileString(path.join(resourcesDir, 'app.asar'), 'fixture')
        yield* fs.writeFileString(path.join(packagedAppDir, '456code.exe'), 'fixture')

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: path.join(tempDir, 'dist'),
          appExecutableName: '456code.exe',
          targetArch: 'x64',
          fileLimit: 1,
        }).pipe(Effect.flip)
        assert.include(error.message, 'loose files')
        assert.include(error.message, '1-file install-speed budget')
        assert.equal(WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT, 256)
      }),
    ),
  )

  it('promotes target fff binaries to direct staged dependencies', () =>
  {
    assert.deepStrictEqual(resolveFffNativeDependencies('mac', 'arm64', '0.9.4'), {
      '@ff-labs/fff-bin-darwin-arm64': '0.9.4',
    })
    assert.deepStrictEqual(resolveFffNativeDependencies('mac', 'universal', '0.9.4'), {
      '@ff-labs/fff-bin-darwin-arm64': '0.9.4',
      '@ff-labs/fff-bin-darwin-x64': '0.9.4',
    })
    assert.deepStrictEqual(resolveFffNativeDependencies('win', 'x64', '0.9.4'), {
      '@ff-labs/fff-bin-win32-x64': '0.9.4',
    })
    assert.deepStrictEqual(resolveFffNativeDependencies('linux', 'x64', '0.9.4'), {
      '@ff-labs/fff-bin-linux-x64-gnu': '0.9.4',
      '@ff-labs/fff-bin-linux-x64-musl': '0.9.4',
    })
    assert.deepStrictEqual(resolveFffNativeDependencies('linux', 'arm64', '0.9.4'), {
      '@ff-labs/fff-bin-linux-arm64-gnu': '0.9.4',
      '@ff-labs/fff-bin-linux-arm64-musl': '0.9.4',
    })
  })

  it('falls back to the default mock update port when the configured port is blank', () =>
  {
    assert.equal(resolveMockUpdateServerUrl(undefined), 'http://localhost:3000')
    assert.equal(resolveMockUpdateServerUrl(4123), 'http://localhost:4123')
  })

  it('derives the electron-builder package manager user agent from packageManager', () =>
  {
    assert.equal(resolvePackageManagerUserAgent('pnpm@11.10.0'), 'pnpm/11.10.0')
    assert.equal(resolvePackageManagerUserAgent(' yarn@4.9.2 '), 'yarn/4.9.2')
    assert.equal(resolvePackageManagerUserAgent('pnpm'), 'pnpm')
  })

  it.effect('normalizes mock update server ports from env-style strings', () =>
    Effect.gen(function* ()
    {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined)
      assert.equal(yield* resolveMockUpdateServerPort(''), undefined)
      assert.equal(yield* resolveMockUpdateServerPort('   '), undefined)
      assert.equal(yield* resolveMockUpdateServerPort('4123'), 4123)
    }),
  )

  it.effect('rejects and classifies invalid mock update ports', () =>
    Effect.gen(function* ()
    {
      const cause = new Error('invalid configured port')
      const rejectedPorts = [
        { port: 'abc', reason: 'not-numeric' as const },
        { port: '12.5', reason: 'not-integer' as const },
        { port: '0', reason: 'out-of-range' as const },
        { port: '65536', reason: 'out-of-range' as const },
      ]

      for (const { port, reason } of rejectedPorts)
      {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port))
        assert.equal(exit._tag, 'Failure')
        assert.equal(InvalidMockUpdateServerPortError.fromConfigValue(port, cause).reason, reason)
      }

      // hex can decode via NumberFromString; classifier still pins not-numeric fallback
      assert.equal(
        InvalidMockUpdateServerPortError.fromConfigValue('0x10', cause).reason,
        'not-numeric',
      )
      assert.strictEqual(
        InvalidMockUpdateServerPortError.fromConfigValue('0x10', cause).cause,
        cause,
      )
    }),
  )

  it.effect('resolves default platform and architecture from host references', () =>
    Effect.gen(function* ()
    {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, 'win32'),
            Layer.succeed(HostProcessArchitecture, 'x64'),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: 'AMD64',
                  PROCESSOR_ARCHITEW6432: 'ARM64',
                },
              }),
            ),
          ),
        ),
      )

      assert.equal(resolved.platform, 'win')
      assert.equal(resolved.target, 'nsis')
      assert.equal(resolved.arch, 'arm64')
    }),
  )

  it.effect('preserves explicit false boolean flags over true env defaults', () =>
    Effect.gen(function* ()
    {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some('mac'),
        target: Option.none(),
        arch: Option.some('arm64'),
        buildVersion: Option.none(),
        outputDir: Option.some('release-test'),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: 'true',
                T3CODE_DESKTOP_KEEP_STAGE: 'true',
                T3CODE_DESKTOP_SIGNED: 'true',
                T3CODE_DESKTOP_VERBOSE: 'true',
                T3CODE_DESKTOP_MOCK_UPDATES: 'true',
              },
            }),
          ),
        ),
      )

      assert.equal(resolved.skipBuild, false)
      assert.equal(resolved.keepStage, false)
      assert.equal(resolved.signed, false)
      assert.equal(resolved.verbose, false)
      assert.equal(resolved.mockUpdates, false)
    }),
  )
})
