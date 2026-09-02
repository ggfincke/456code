// tests/apps/server/service/bootService.test.ts
// verify boot service behavior

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from 'node:os'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from '@t3tools/shared/hostProcess'

import {
  prepareServiceStorageMutation,
  reconcileService,
} from '../../../../apps/server/src/cli/service.ts'
import * as ProcessRunner from '../../../../apps/server/src/process/processRunner.ts'
import {
  SERVER_STORAGE_LEASE_FILE,
  ServerStorageLeaseOwner,
} from '../../../../apps/server/src/serverStorageLease.ts'
import * as BootService from '../../../../apps/server/src/service/bootService.ts'

const isUnsupportedError = Schema.is(BootService.BootServiceUnsupportedError)
const isCommandError = Schema.is(BootService.BootServiceCommandError)
const encodeStorageOwner = Schema.encodeSync(Schema.fromJsonString(ServerStorageLeaseOwner))

interface RecordedCommand
{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly timeout?: Duration.Input
}

const makeRecordingRunnerLayer = (
  commands: Array<RecordedCommand>,
  options?: {
    readonly failCommand?: string
    readonly failWhen?: (command: string, args: ReadonlyArray<string>) => boolean
    readonly afterSuccess?: (
      command: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<void, never>
    readonly afterRun?: (
      command: string,
      args: ReadonlyArray<string>,
      failed: boolean,
    ) => Effect.Effect<void, never>
  },
) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* ()
        {
          assert.isUndefined(input.env)
          commands.push({
            command: input.command,
            args: input.args,
            ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
          })
          const failed =
            input.command === options?.failCommand ||
            options?.failWhen?.(input.command, input.args) === true
          if (!failed && options?.afterSuccess !== undefined)
          {
            yield* options.afterSuccess(input.command, input.args)
          }
          if (options?.afterRun !== undefined)
          {
            yield* options.afterRun(input.command, input.args, failed)
          }
          return {
            stdout: '',
            stderr: failed ? `${input.command} exploded` : '',
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          }
        }),
    }),
  )

const makeHost = (entry: string, awaitStorageOwner = false): BootService.BootServiceHost => ({
  execPath: '/usr/local/bin/node',
  cliEntryPath: entry,
  awaitStorageOwner,
})

const provideHostRefs = (
  home: string,
  platform: NodeJS.Platform = 'linux',
  uid: number | undefined = 501,
  environment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
  },
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(HostProcessPlatform, platform),
      Layer.succeed(HostProcessUserId, uid),
      Layer.succeed(HostProcessEnvironment, environment),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
    ),
  )

const makeTestContext = Effect.fn('test.makeTestContext')(function* ()
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 't3-boot-service-test-' })
  // a real file for the stable-entry cases so status can confirm the entry
  // point exists.
  const stableEntry = path.join(root, 'bin.mjs')
  yield* fs.writeFileString(stableEntry, '#!/usr/bin/env node\n')
  return {
    fs,
    path,
    dirs: {
      home: root,
      baseDir: path.join(root, '.456code'),
      logsDir: path.join(root, '.456code', 'userdata', 'logs'),
      stableEntry,
    },
  }
})

it('renders a systemd unit with absolute paths and append-mode logging', () =>
{
  const unit = BootService.renderBootServiceUnit({
    nodePath: '/usr/local/bin/node',
    t3EntryPath: '/home/theo/.456code/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs',
    environmentPath: '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
    serviceVersion: '0.0.27',
    baseDir: '/home/theo/.456code',
    logPath: '/home/theo/.456code/userdata/logs/boot-service.log',
    unitPath: '/home/theo/.config/systemd/user/456code.service',
  })

  assert.equal(
    unit,
    [
      '[Unit]',
      'Description=456code server',
      'StartLimitIntervalSec=300',
      'StartLimitBurst=5',
      '',
      '[Service]',
      'Type=simple',
      'WorkingDirectory=%h',
      'Environment=T3CODE_HOME=/home/theo/.456code',
      'Environment=CODE456_BOOT_SERVICE_UNIT=456code.service',
      'Environment=CODE456_BOOT_SERVICE_VERSION=0.0.27',
      'Environment=PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
      'ExecStart=/usr/local/bin/node /home/theo/.456code/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs serve',
      'Restart=always',
      'RestartSec=5',
      'StandardOutput=append:/home/theo/.456code/userdata/logs/boot-service.log',
      'StandardError=append:/home/theo/.456code/userdata/logs/boot-service.log',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  )
})

it('quotes systemd values containing spaces and escapes percent specifiers', () =>
{
  assert.equal(BootService.quoteSystemdValue('/plain/path'), '/plain/path')
  assert.equal(BootService.quoteSystemdValue('/home/me/T3 Data'), '"/home/me/T3 Data"')
  assert.equal(BootService.quoteSystemdValue('/opt/100%cpu'), '/opt/100%%cpu')

  const unit = BootService.renderBootServiceUnit({
    nodePath: '/home/me/my tools/node',
    t3EntryPath: '/home/me/T3 Data/bin.mjs',
    environmentPath: '/opt/provider tools/bin:/usr/bin/%fallback',
    serviceVersion: '0.0.27',
    baseDir: '/home/me/T3 Data',
    logPath: '/home/me/100%logs/boot.log',
    unitPath: '/home/me/.config/systemd/user/456code.service',
  })
  assert.include(unit, 'ExecStart="/home/me/my tools/node" "/home/me/T3 Data/bin.mjs" serve')
  assert.include(unit, 'Environment=T3CODE_HOME="/home/me/T3 Data"')
  assert.include(unit, 'Environment="PATH=/opt/provider tools/bin:/usr/bin/%%fallback"')
  // append: paths take the rest of the line literally (spaces are fine,
  // quoting is not), but % still goes through specifier expansion.
  assert.include(unit, 'StandardOutput=append:/home/me/100%%logs/boot.log')
  assert.include(unit, 'StandardError=append:/home/me/100%%logs/boot.log')
})

it('extracts only explicit or legacy pinned-runtime service versions', () =>
{
  assert.equal(
    BootService.extractInstalledServiceVersion(
      'Environment=CODE456_BOOT_SERVICE_VERSION=1.2.3-nightly.4+build.5\n',
    ),
    '1.2.3-nightly.4+build.5',
  )
  assert.equal(
    BootService.extractInstalledServiceVersion(
      '<key>CODE456_BOOT_SERVICE_VERSION</key>\n<string>2.3.4</string>',
    ),
    '2.3.4',
  )
  assert.equal(
    BootService.extractInstalledServiceVersion(
      'ExecStart=/usr/bin/node /home/me/.456code/runtime/versions/3.4.5-nightly.6/node_modules/456code/dist/bin.mjs serve',
    ),
    '3.4.5-nightly.6',
  )
  for (const definition of [
    'Environment=CODE456_BOOT_SERVICE_VERSION=latest\n',
    'ExecStart=/home/me/.456code/runtime/versions/1.2/node_modules/456code/dist/bin.mjs',
    'ExecStart=/home/me/.456code/runtime/versions/1.2.3/node_modules/not-456code/dist/bin.mjs',
    [
      'ExecStart=/home/me/.456code/runtime/versions/1.2.3/node_modules/456code/dist/bin.mjs',
      '# /home/me/.456code/runtime/versions/2.0.0/node_modules/456code/dist/bin.mjs',
    ].join('\n'),
  ])
  {
    assert.isUndefined(BootService.extractInstalledServiceVersion(definition))
  }
})

it('compares only exact semantic versions and ignores build metadata', () =>
{
  const huge = '9'.repeat(100)
  const slightlySmaller = `${'9'.repeat(99)}8`
  assert.isAbove(BootService.compareServiceVersions('2.0.0', '1.99.99') ?? 0, 0)
  assert.isAbove(
    BootService.compareServiceVersions(`${huge}.0.0`, `${slightlySmaller}.999.999`) ?? 0,
    0,
  )
  assert.isBelow(BootService.compareServiceVersions('1.2.3-nightly.1', '1.2.3') ?? 0, 0)
  assert.isAbove(
    BootService.compareServiceVersions(
      `1.2.3-nightly.${huge}`,
      `1.2.3-nightly.${slightlySmaller}`,
    ) ?? 0,
    0,
  )
  assert.equal(BootService.compareServiceVersions('1.2.3+new', '1.2.3+old'), 0)
  assert.isUndefined(BootService.compareServiceVersions('latest', '1.2.3'))
  assert.isUndefined(BootService.compareServiceVersions('1.2', '1.2.3'))
})

it('flags package-manager cache entry points as ephemeral', () =>
{
  assert.isTrue(
    BootService.isEphemeralCacheEntry('/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs'),
  )
  assert.isTrue(
    BootService.isEphemeralCacheEntry('C:\\Users\\theo\\AppData\\npm-cache\\_npx\\abc\\bin.mjs'),
  )
  assert.isTrue(
    BootService.isEphemeralCacheEntry(
      '/home/theo/.cache/pnpm/dlx/abc/node_modules/t3/dist/bin.mjs',
    ),
  )
  assert.isTrue(
    BootService.isEphemeralCacheEntry('/home/theo/.bun/install/cache/456code@0.0.27/dist/bin.mjs'),
  )
  assert.isFalse(BootService.isEphemeralCacheEntry('/usr/local/lib/node_modules/t3/dist/bin.mjs'))
  assert.isFalse(
    BootService.isEphemeralCacheEntry(
      '/home/theo/dev/pnpm/dlx-tools/t3/node_modules/t3/dist/bin.mjs',
    ),
  )
  assert.isFalse(
    BootService.isEphemeralCacheEntry(
      '/home/theo/.456code/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs',
    ),
  )
})

it.layer(NodeServices.layer)('BootService', (it) =>
{
  it.effect('reconciles the standalone service once and is then idempotent', () =>
    Effect.gen(function* ()
    {
      const { dirs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const first = yield* reconcileService().pipe(
        Effect.provideService(BootService.BootService, service),
      )
      assert.isTrue(first.changed)
      if (!first.changed) return
      assert.isFalse(first.previouslyInstalled)

      const commandCount = commands.length
      const second = yield* reconcileService().pipe(
        Effect.provideService(BootService.BootService, service),
      )
      assert.isFalse(second.changed)
      assert.deepEqual(commands.slice(commandCount), [
        {
          command: 'systemctl',
          args: ['--user', 'is-active', '--quiet', BootService.BOOT_SERVICE_UNIT_FILE],
        },
      ])
    }),
  )

  it.effect('stops a stale installed service before storage mutation begins', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      yield* service.install()
      const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
      yield* fs.writeFileString(unitPath, 'stale unit\n')
      commands.length = 0

      const status = yield* prepareServiceStorageMutation().pipe(
        Effect.provideService(BootService.BootService, service),
      )

      assert.isTrue(status.installed)
      assert.isFalse(status.current)
      assert.deepEqual(commands, [
        {
          command: 'systemctl',
          args: ['--user', 'is-active', '--quiet', BootService.BOOT_SERVICE_UNIT_FILE],
        },
        {
          command: 'systemctl',
          args: ['--user', 'stop', BootService.BOOT_SERVICE_UNIT_FILE],
        },
      ])
    }),
  )

  it.effect('refuses a known downgrade before stopping or changing the installed unit', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.28',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const plan = yield* service.install()
      const newerUnit = (yield* fs.readFileString(plan.unitPath)).replace(
        'CODE456_BOOT_SERVICE_VERSION=0.0.28',
        'CODE456_BOOT_SERVICE_VERSION=0.0.29',
      )
      yield* fs.writeFileString(plan.unitPath, newerUnit)
      commands.length = 0

      const error = yield* prepareServiceStorageMutation().pipe(
        Effect.provideService(BootService.BootService, service),
        Effect.flip,
      )

      assert.deepInclude(error, {
        _tag: 'BootServiceDowngradeRefusedError',
        installedVersion: '0.0.29',
        targetVersion: '0.0.28',
      })
      assert.equal(yield* fs.readFileString(plan.unitPath), newerUnit)
      assert.deepEqual(commands, [
        {
          command: 'systemctl',
          args: ['--user', 'is-active', '--quiet', BootService.BOOT_SERVICE_UNIT_FILE],
        },
      ])
    }),
  )

  it.effect('allows an explicit downgrade without bypassing normal activation', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const plan = yield* service.install()
      yield* fs.writeFileString(
        plan.unitPath,
        (yield* fs.readFileString(plan.unitPath)).replace(
          'CODE456_BOOT_SERVICE_VERSION=0.0.27',
          'CODE456_BOOT_SERVICE_VERSION=0.0.28',
        ),
      )
      commands.length = 0

      yield* service.install({ allowDowngrade: true })

      assert.equal((yield* service.status).installedVersion, '0.0.27')
      assert.isTrue(
        commands.some(({ command, args }) => command === 'systemctl' && args.includes('restart')),
      )
    }),
  )

  it.effect('preserves a newer definition that appears between preparation and activation', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const prepared = yield* service.prepareInstall()
      const newerUnit = (yield* fs.readFileString(prepared.plan.unitPath)).replace(
        'CODE456_BOOT_SERVICE_VERSION=0.0.27',
        'CODE456_BOOT_SERVICE_VERSION=0.0.28',
      )
      yield* fs.writeFileString(prepared.plan.unitPath, newerUnit)

      const error = yield* service.activatePrepared(prepared).pipe(Effect.flip)

      assert.equal(error._tag, 'BootServiceDowngradeRefusedError')
      assert.equal(yield* fs.readFileString(prepared.plan.unitPath), newerUnit)
      assert.deepEqual(commands, [])
    }),
  )

  it.effect('preserves a newer definition that appears before prepared-unit replacement', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
      const newerUnit = '[Service]\nEnvironment=CODE456_BOOT_SERVICE_VERSION=0.0.28\n'
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/home/me/.npm/_npx/runtime/node_modules/t3/dist/bin.mjs'),
      }).pipe(
        Effect.provide(
          makeRecordingRunnerLayer(commands, {
            afterSuccess: (command) =>
              command === 'npm'
                ? fs
                    .makeDirectory(path.dirname(unitPath), { recursive: true })
                    .pipe(Effect.andThen(fs.writeFileString(unitPath, newerUnit)), Effect.orDie)
                : Effect.void,
          }),
        ),
        provideHostRefs(dirs.home),
      )

      const error = yield* service.prepareInstall().pipe(Effect.flip)

      assert.equal(error._tag, 'BootServiceDowngradeRefusedError')
      assert.equal(yield* fs.readFileString(unitPath), newerUnit)
      assert.deepEqual(
        commands.map(({ command }) => command),
        ['npm'],
      )
    }),
  )

  it.effect('rolls back an abandoned preparation and permits a retry', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const abandoned = yield* service.prepareInstall()
      yield* service.releasePreparedInstall(abandoned)

      assert.isFalse(yield* fs.exists(abandoned.plan.unitPath))
      assert.deepEqual(commands, [
        {
          command: 'systemctl',
          args: ['--user', 'disable', '--now', BootService.BOOT_SERVICE_UNIT_FILE],
        },
        {
          command: 'systemctl',
          args: ['--user', 'daemon-reload'],
        },
      ])
      yield* service.activatePrepared(yield* service.prepareInstall())
    }),
  )

  it.effect('prepares the unit without activation and activates it explicitly', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const prepared = yield* service.prepareInstall()

      assert.deepEqual(commands, [])
      assert.isTrue(yield* fs.exists(prepared.plan.unitPath))

      const plan = yield* service.activatePrepared(prepared)

      // a stable entry point is reused directly — no npm install.
      assert.equal(plan.t3EntryPath, dirs.stableEntry)
      assert.deepEqual(
        commands.map((entry) => [entry.command, ...entry.args].join(' ')),
        [
          'systemctl --user daemon-reload',
          'systemctl --user enable 456code.service',
          // restart (not enable --now) so repairing a stale unit replaces a
          // running process instead of leaving the old one until reboot.
          'systemctl --user restart 456code.service',
          'loginctl enable-linger',
        ],
      )

      const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
      const unit = yield* fs.readFileString(unitPath)
      assert.include(unit, `ExecStart=/usr/local/bin/node ${dirs.stableEntry} serve`)
      assert.include(unit, `Environment=T3CODE_HOME=${dirs.baseDir}`)

      const status = yield* service.status
      assert.isTrue(status.supported)
      assert.isTrue(status.installed)
      assert.isTrue(status.current)
      assert.equal(status.installedVersion, '0.0.27')

      const removed = yield* service.uninstall
      assert.isTrue(removed)
      assert.isFalse(yield* fs.exists(unitPath))
      const statusAfter = yield* service.status
      assert.isFalse(statusAfter.installed)
      const removedAgain = yield* service.uninstall
      assert.isFalse(removedAgain)
    }),
  )

  it.effect('rejects a prepared unit owned by a different CLI version', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const makeVersionedService = (cliVersion: string) =>
        BootService.make({
          baseDir: dirs.baseDir,
          logsDir: dirs.logsDir,
          cliVersion,
          host: makeHost(dirs.stableEntry),
        }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))
      const olderService = yield* makeVersionedService('0.0.27')
      const newerService = yield* makeVersionedService('0.0.28')
      const prepared = yield* olderService.prepareInstall()

      const error = yield* newerService.activatePrepared(prepared).pipe(Effect.flip)

      assert.equal(error._tag, 'BootServiceInstallError')
      assert.isFalse(yield* fs.exists(prepared.plan.unitPath))
      assert.deepEqual(
        commands.map(({ command }) => command),
        ['systemctl', 'systemctl'],
      )
    }),
  )

  it.effect('rejects same-version prepared plans with different runtime material', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))
      const mismatches: ReadonlyArray<Partial<BootService.BootServicePlan>> = [
        { nodePath: '/different/node' },
        { environmentPath: '/different/bin' },
        { logPath: '/different/boot-service.log' },
      ]

      for (const mismatch of mismatches)
      {
        const prepared = yield* service.prepareInstall()
        const error = yield* service
          .activatePrepared({
            ...prepared,
            plan: { ...prepared.plan, ...mismatch },
          })
          .pipe(Effect.flip)
        assert.equal(error._tag, 'BootServiceInstallError')
      }
      const prepared = yield* service.prepareInstall()
      const definitionError = yield* service
        .activatePrepared({ ...prepared, preparedUnit: `${prepared.preparedUnit}\n` })
        .pipe(Effect.flip)

      assert.equal(definitionError._tag, 'BootServiceInstallError')
      assert.isFalse(yield* fs.exists(prepared.plan.unitPath))
      assert.deepEqual(
        commands.map(({ command }) => command),
        [
          'systemctl',
          'systemctl',
          'systemctl',
          'systemctl',
          'systemctl',
          'systemctl',
          'systemctl',
          'systemctl',
        ],
      )
    }),
  )

  it.effect('serializes concurrent installers with identical definitions', () =>
    Effect.gen(function* ()
    {
      const { dirs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const makeService = () =>
        BootService.make({
          baseDir: dirs.baseDir,
          logsDir: dirs.logsDir,
          cliVersion: '0.0.27',
          host: makeHost(dirs.stableEntry),
        }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))
      const firstService = yield* makeService()
      const secondService = yield* makeService()
      const firstPrepared = yield* firstService.prepareInstall()
      const secondFiber = yield* secondService
        .prepareInstall()
        .pipe(Effect.forkChild({ startImmediately: true }))

      for (let turn = 0; turn < 5; turn += 1) yield* Effect.yieldNow
      assert.isUndefined(secondFiber.pollUnsafe())

      yield* firstService.activatePrepared(firstPrepared)
      yield* TestClock.adjust('50 millis')
      const secondPrepared = yield* Fiber.join(secondFiber)
      assert.equal(secondPrepared.previousUnit, firstPrepared.preparedUnit)
      yield* secondService.activatePrepared(secondPrepared)
    }),
  )

  it.effect('serializes uninstall behind an in-flight installer', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const installCommands: Array<RecordedCommand> = []
      const uninstallCommands: Array<RecordedCommand> = []
      const installer = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(installCommands)), provideHostRefs(dirs.home))
      const uninstaller = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(uninstallCommands)),
        provideHostRefs(dirs.home),
      )
      const prepared = yield* installer.prepareInstall()
      const uninstallFiber = yield* uninstaller.uninstall.pipe(
        Effect.forkChild({ startImmediately: true }),
      )

      for (let turn = 0; turn < 5; turn += 1) yield* Effect.yieldNow
      assert.isUndefined(uninstallFiber.pollUnsafe())
      assert.deepEqual(uninstallCommands, [])

      yield* installer.activatePrepared(prepared)
      yield* TestClock.adjust('50 millis')
      assert.isTrue(yield* Fiber.join(uninstallFiber))
      assert.isFalse(yield* fs.exists(prepared.plan.unitPath))
    }),
  )

  it.effect('rolls back a prepared unit when preparation is interrupted before returning', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
      const unitWritten = yield* Deferred.make<void>()
      const allowWriteReturn = yield* Deferred.make<void>()
      const observedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, data, options) =>
          fs
            .writeFileString(filePath, data, options)
            .pipe(
              Effect.tap(() =>
                filePath === unitPath
                  ? Deferred.succeed(unitWritten, undefined).pipe(
                      Effect.andThen(Deferred.await(allowWriteReturn)),
                    )
                  : Effect.void,
              ),
            ),
      })
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFileSystem),
        Effect.provide(makeRecordingRunnerLayer(commands)),
        provideHostRefs(dirs.home),
      )
      const preparationFiber = yield* service
        .prepareInstall()
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(unitWritten)
      const interruptionFiber = yield* Fiber.interrupt(preparationFiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.succeed(allowWriteReturn, undefined)
      yield* Fiber.join(interruptionFiber)

      assert.isFalse(yield* fs.exists(unitPath))
      assert.isFalse(
        yield* fs.exists(path.join(`${unitPath}.install-lock`, SERVER_STORAGE_LEASE_FILE)),
      )
      assert.deepEqual(
        commands.map(({ command, args }) => [command, ...args].join(' ')),
        ['systemctl --user disable --now 456code.service', 'systemctl --user daemon-reload'],
      )
    }),
  )

  it.effect.each(['interruption', 'defect'] as const)(
    'rolls back and restarts once after activation %s',
    (failureMode) =>
      Effect.gen(function* ()
      {
        const { dirs, fs, path } = yield* makeTestContext()
        const initialService = yield* BootService.make({
          baseDir: dirs.baseDir,
          logsDir: dirs.logsDir,
          cliVersion: '0.0.27',
          host: makeHost(dirs.stableEntry),
        }).pipe(Effect.provide(makeRecordingRunnerLayer([])), provideHostRefs(dirs.home))
        yield* initialService.install()
        const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
        const previousUnit = yield* fs.readFileString(unitPath)

        const activationRestarted = yield* Deferred.make<void>()
        let restartCount = 0
        const commands: Array<RecordedCommand> = []
        const replacementEntry = path.join(dirs.home, 'replacement-bin.mjs')
        yield* fs.writeFileString(replacementEntry, '#!/usr/bin/env node\n')
        const replacementService = yield* BootService.make({
          baseDir: dirs.baseDir,
          logsDir: dirs.logsDir,
          cliVersion: '0.0.28',
          host: makeHost(replacementEntry),
        }).pipe(
          Effect.provide(
            makeRecordingRunnerLayer(commands, {
              afterRun: (command, args) =>
              {
                if (command !== 'systemctl' || !args.includes('restart')) return Effect.void
                restartCount += 1
                if (restartCount !== 1) return Effect.void
                return Deferred.succeed(activationRestarted, undefined).pipe(
                  Effect.andThen(
                    failureMode === 'defect'
                      ? Effect.die(new Error('activation defect'))
                      : Effect.never,
                  ),
                )
              },
            }),
          ),
          provideHostRefs(dirs.home),
        )
        const prepared = yield* replacementService.prepareInstall()
        const activationFiber = yield* replacementService
          .activatePrepared(prepared)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(activationRestarted)
        if (failureMode === 'interruption') yield* Fiber.interrupt(activationFiber)
        const exit = yield* Fiber.await(activationFiber)

        assert.isTrue(Exit.isFailure(exit))
        assert.isFalse(
          yield* fs.exists(path.join(`${unitPath}.install-lock`, SERVER_STORAGE_LEASE_FILE)),
        )
        assert.equal(yield* fs.readFileString(unitPath), previousUnit)
        assert.equal(restartCount, 2)
      }),
  )

  it.effect('blocks stale restart recovery behind a replacement installer', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const initialCommands: Array<RecordedCommand> = []
      const initialService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(initialCommands)), provideHostRefs(dirs.home))
      yield* initialService.install()
      const restartSnapshot = yield* initialService.restartSnapshot
      if (restartSnapshot === null) return assert.fail('expected an installed unit snapshot')
      yield* initialService.stop()
      initialCommands.length = 0

      const replacementEntry = path.join(dirs.home, 'replacement-bin.mjs')
      yield* fs.writeFileString(replacementEntry, '#!/usr/bin/env node\n')
      const replacementService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.28',
        host: makeHost(replacementEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer([])), provideHostRefs(dirs.home))
      const replacement = yield* replacementService.prepareInstall()
      const recoveryFiber = yield* initialService
        .restartIfUnchanged(restartSnapshot)
        .pipe(Effect.forkChild({ startImmediately: true }))

      for (let turn = 0; turn < 5; turn += 1) yield* Effect.yieldNow
      assert.isUndefined(recoveryFiber.pollUnsafe())

      yield* replacementService.activatePrepared(replacement)
      yield* TestClock.adjust('50 millis')
      assert.isFalse(yield* Fiber.join(recoveryFiber))
      assert.deepEqual(initialCommands, [])
    }),
  )

  it.effect('recovers stale installer locks and releases them on failure and success', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
      const lockDirectory = `${unitPath}.install-lock`
      const lockPath = path.join(lockDirectory, SERVER_STORAGE_LEASE_FILE)
      yield* fs.makeDirectory(lockDirectory, { recursive: true })
      const canonicalLockDirectory = yield* fs.realPath(lockDirectory)
      yield* fs.writeFileString(
        lockPath,
        encodeStorageOwner({
          version: 1,
          token: 'crashed-installer',
          pid: 2_147_483_647,
          hostname: NodeOS.hostname(),
          acquiredAt: '2020-01-01T00:00:00.000Z',
          processStartedAt: '2020-01-01T00:00:00.000Z',
          canonicalBaseDir: canonicalLockDirectory,
        }),
      )

      const failedService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/home/me/.npm/_npx/runtime/node_modules/t3/dist/bin.mjs'),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer([], { failCommand: 'npm' })),
        provideHostRefs(dirs.home),
      )
      const error = yield* failedService.prepareInstall().pipe(Effect.flip)
      assert.isTrue(isCommandError(error))
      assert.isFalse(yield* fs.exists(lockPath))

      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer([])), provideHostRefs(dirs.home))
      const abandoned = yield* service.prepareInstall()
      yield* service.releasePreparedInstall(abandoned)
      yield* service.releasePreparedInstall(abandoned)
      assert.isFalse(yield* fs.exists(lockPath))

      yield* service.install()
      assert.isFalse(yield* fs.exists(lockPath))
    }),
  )

  it.effect('installs, reports, and removes a bounded macOS launch agent', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands)),
        provideHostRefs(dirs.home, 'darwin', 501),
      )

      const plan = yield* service.install()
      const plist = yield* fs.readFileString(plan.unitPath)
      assert.isTrue(
        plan.unitPath.endsWith(`Library/LaunchAgents/${BootService.BOOT_SERVICE_PLIST_FILE}`),
      )
      assert.include(plist, `<string>${dirs.stableEntry}</string>\n    <string>serve</string>`)
      assert.include(plist, '<key>CODE456_BOOT_SERVICE_VERSION</key>\n    <string>0.0.27</string>')
      assert.include(plist, '<key>KeepAlive</key>\n  <true/>')
      assert.include(plist, '<key>ExitTimeOut</key>\n  <integer>90</integer>')
      assert.deepEqual(
        commands.slice(0, 3).map(({ command, args }) => [command, ...args].join(' ')),
        [
          `launchctl bootout --wait gui/501/${BootService.BOOT_SERVICE_LAUNCHD_LABEL}`,
          `launchctl enable gui/501/${BootService.BOOT_SERVICE_LAUNCHD_LABEL}`,
          `launchctl bootstrap gui/501 ${plan.unitPath}`,
        ],
      )
      assert.equal(commands[0]?.timeout, '120 seconds')

      const status = yield* service.status
      assert.isTrue(status.supported)
      assert.isTrue(status.installed)
      assert.isTrue(status.current)
      assert.equal(status.installedVersion, '0.0.27')
      assert.isTrue(yield* service.uninstall)
      assert.isFalse(yield* fs.exists(plan.unitPath))
      assert.isFalse(commands.some(({ command }) => command === 'systemctl'))
    }),
  )

  it.effect('keeps launchd PATH safe and ignores only PATH drift when checking currentness', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const makeService = (environmentPath: string) =>
        BootService.make({
          baseDir: dirs.baseDir,
          logsDir: dirs.logsDir,
          cliVersion: '0.0.27',
          host: { ...makeHost(dirs.stableEntry), execPath: '/custom/node/bin/node' },
        }).pipe(
          Effect.provide(makeRecordingRunnerLayer([])),
          provideHostRefs(dirs.home, 'darwin', 501, { PATH: environmentPath }),
        )
      const service = yield* makeService('/tools&more::/bad\u0001path:/tools&more:/space tools')
      const plan = yield* service.install()
      assert.equal(
        plan.environmentPath,
        '/tools&more:/space tools:/custom/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
      )
      const definition = yield* fs.readFileString(plan.unitPath)
      assert.include(definition, '/tools&amp;more:/space tools')
      const otherShell = yield* makeService('/another/shell/bin')
      assert.isTrue((yield* otherShell.status).current)
      yield* fs.writeFileString(
        plan.unitPath,
        definition.replace('/custom/node/bin/node', '/stale/node'),
      )
      assert.isFalse((yield* otherShell.status).current)
      yield* fs.writeFileString(plan.unitPath, definition)
      yield* fs.remove(dirs.stableEntry)
      assert.isFalse((yield* otherShell.status).current)
    }),
  )

  it.effect('persists the installer PATH in both service formats with a safe fallback', () =>
    Effect.gen(function* ()
    {
      const installerPath =
        '/opt/homebrew/bin:/Users/theo/provider tools/bin:/Users/theo/source&control/bin:/usr/bin/%fallback'
      const fallbackPath = '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin'

      for (const { platform, uid } of [
        { platform: 'linux' as const, uid: 501 },
        { platform: 'darwin' as const, uid: 501 },
      ])
      {
        for (const { environment, expectedPath } of [
          { environment: { PATH: installerPath }, expectedPath: installerPath },
          { environment: {}, expectedPath: fallbackPath },
          { environment: { PATH: '   ' }, expectedPath: fallbackPath },
        ])
        {
          const { dirs, fs } = yield* makeTestContext()
          const commands: Array<RecordedCommand> = []
          const service = yield* BootService.make({
            baseDir: dirs.baseDir,
            logsDir: dirs.logsDir,
            cliVersion: '0.0.27',
            host: makeHost(dirs.stableEntry),
          }).pipe(
            Effect.provide(makeRecordingRunnerLayer(commands)),
            provideHostRefs(dirs.home, platform, uid, environment),
          )

          const plan = yield* service.install()
          const definition = yield* fs.readFileString(plan.unitPath)

          const persistedPath =
            platform === 'darwin'
              ? [
                  ...new Set([
                    ...(environment.PATH?.trim() ? environment.PATH.split(':') : []),
                    '/usr/local/bin',
                    '/opt/homebrew/bin',
                    ...fallbackPath.split(':'),
                  ]),
                ].join(':')
              : expectedPath
          assert.equal(plan.environmentPath, persistedPath)
          if (platform === 'linux')
          {
            const escapedPath = expectedPath.replaceAll('%', '%%')
            const renderedPath = expectedPath.includes(' ')
              ? `Environment="PATH=${escapedPath}"`
              : `Environment=PATH=${escapedPath}`
            assert.include(definition, renderedPath)
          }
          else
          {
            assert.include(
              definition,
              `<key>PATH</key>\n    <string>${BootService.escapeXmlText(persistedPath)}</string>`,
            )
          }
          assert.isTrue((yield* service.status).current)
        }
      }
    }),
  )

  it.effect('unloads a failed macOS launch agent before restoring the prior plist', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const unitPath = path.join(
        dirs.home,
        'Library',
        'LaunchAgents',
        BootService.BOOT_SERVICE_PLIST_FILE,
      )
      yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true })
      yield* fs.writeFileString(unitPath, 'previous plist\n')

      const commands: Array<RecordedCommand> = []
      let bootstrapAttempts = 0
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provide(
          makeRecordingRunnerLayer(commands, {
            failWhen: (command, args) =>
            {
              if (command !== 'launchctl' || args[0] !== 'bootstrap') return false
              bootstrapAttempts += 1
              return bootstrapAttempts === 1
            },
          }),
        ),
        provideHostRefs(dirs.home, 'darwin', 501),
      )

      const error = yield* service.install().pipe(Effect.flip)

      assert.isTrue(isCommandError(error))
      assert.equal(yield* fs.readFileString(unitPath), 'previous plist\n')
      assert.deepEqual(
        commands.map(({ command, args }) => [command, ...args].join(' ')),
        [
          `launchctl bootout --wait gui/501/${BootService.BOOT_SERVICE_LAUNCHD_LABEL}`,
          `launchctl enable gui/501/${BootService.BOOT_SERVICE_LAUNCHD_LABEL}`,
          `launchctl bootstrap gui/501 ${unitPath}`,
          `launchctl bootout --wait gui/501/${BootService.BOOT_SERVICE_LAUNCHD_LABEL}`,
          `launchctl bootstrap gui/501 ${unitPath}`,
        ],
      )
      assert.equal(commands[3]?.timeout, '120 seconds')
    }),
  )

  it.effect('reports activation only after a new durable storage owner is visible', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      yield* fs.makeDirectory(dirs.baseDir, { recursive: true })
      const canonicalBaseDir = yield* fs.realPath(dirs.baseDir)
      const ownerPath = path.join(canonicalBaseDir, SERVER_STORAGE_LEASE_FILE)
      yield* fs.writeFileString(
        ownerPath,
        `${encodeStorageOwner({
          version: 1,
          token: 'cli-storage-owner',
          pid: process.pid,
          hostname: 'test-host',
          acquiredAt: '2026-08-09T11:59:00.000Z',
          processStartedAt: '2026-08-09T11:59:00.000Z',
          canonicalBaseDir,
        })}\n`,
      )
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry, true),
      }).pipe(
        Effect.provide(
          makeRecordingRunnerLayer(commands, {
            afterSuccess: (command, args) =>
              command === 'systemctl' && args.includes('restart')
                ? fs
                    .writeFileString(
                      ownerPath,
                      `${encodeStorageOwner({
                        version: 1,
                        token: 'started-server-owner',
                        pid: process.pid + 1,
                        hostname: 'test-host',
                        acquiredAt: '2026-08-09T12:00:00.000Z',
                        processStartedAt: '2026-08-09T12:00:00.000Z',
                        canonicalBaseDir,
                      })}\n`,
                    )
                    .pipe(Effect.orDie)
                : Effect.void,
          }),
        ),
        provideHostRefs(dirs.home),
      )

      const prepared = yield* service.prepareInstall()
      assert.equal(prepared.previousStorageOwnerToken, 'cli-storage-owner')
      assert.isFalse((yield* service.status).current)
      const plan = yield* service.activatePrepared(prepared)

      assert.equal(plan.baseDir, dirs.baseDir)
      assert.deepEqual(commands.at(-1), {
        command: 'systemctl',
        args: ['--user', 'is-active', '--quiet', BootService.BOOT_SERVICE_UNIT_FILE],
      })
      assert.isTrue((yield* service.status).current)
    }),
  )

  it.effect('pins a runtime via npm install when running from the npx cache', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs'),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const plan = yield* service.install()

      const runtimeDir = path.join(dirs.baseDir, 'runtime', 'versions', '0.0.27')
      assert.equal(
        plan.t3EntryPath,
        path.join(runtimeDir, 'node_modules', '456code', 'dist', 'bin.mjs'),
      )
      assert.deepEqual(commands[0]?.command, 'npm')
      assert.deepEqual(commands[0]?.args, [
        'install',
        '--prefix',
        runtimeDir,
        '--no-fund',
        '--no-audit',
        '456code@0.0.27',
      ])
      assert.equal(Duration.toMillis(commands[0]?.timeout ?? 0), Duration.toMillis('10 minutes'))
      // success is recorded via a sentinel so interrupted installs re-run.
      assert.isTrue(yield* fs.exists(path.join(runtimeDir, '.install-complete')))
    }),
  )

  it.effect('reinstalls a pinned runtime when its entry point is missing', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs'),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const plan = yield* service.install()
      yield* fs.makeDirectory(path.dirname(plan.t3EntryPath), { recursive: true })
      yield* fs.writeFileString(plan.t3EntryPath, '#!/usr/bin/env node\n')
      yield* fs.remove(plan.t3EntryPath)
      commands.length = 0

      yield* service.install()

      assert.isTrue(commands.some(({ command }) => command === 'npm'))
    }),
  )

  it.effect('reads executable metadata from host process references', () =>
    Effect.gen(function* ()
    {
      const { dirs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        awaitStorageOwner: false,
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands)),
        provideHostRefs(dirs.home),
        Effect.provideService(HostProcessExecutablePath, '/opt/node/bin/node'),
        Effect.provideService(HostProcessArguments, ['/opt/node/bin/node', dirs.stableEntry]),
      )

      const plan = yield* service.install()
      assert.equal(plan.nodePath, '/opt/node/bin/node')
      assert.equal(plan.t3EntryPath, dirs.stableEntry)
    }),
  )

  it.effect('cleans up and fails when the pinned runtime install fails', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs'),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: 'npm' })),
        provideHostRefs(dirs.home),
      )

      const error = yield* service.install().pipe(Effect.flip)
      assert.isTrue(isCommandError(error))
      const runtimeDir = path.join(dirs.baseDir, 'runtime', 'versions', '0.0.27')
      // the half-installed tree must not be reused by the next attempt.
      assert.isFalse(yield* fs.exists(runtimeDir))
      assert.isFalse(yield* fs.exists(path.join(runtimeDir, '.install-complete')))
    }),
  )

  it.effect('reports an installed-but-stale unit so the lifecycle can offer a repair', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      const unitDir = path.join(dirs.home, '.config', 'systemd', 'user')
      yield* fs.makeDirectory(unitDir, { recursive: true })
      yield* fs.writeFileString(
        path.join(unitDir, '456code.service'),
        '[Service]\nExecStart=/old/node /old/t3 serve\n',
      )

      const status = yield* service.status
      assert.isTrue(status.supported)
      assert.isTrue(status.installed)
      assert.isFalse(status.current)
    }),
  )

  it.effect('reports a current unit as stale when its entry point is gone', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home))

      yield* service.install()
      assert.isTrue((yield* service.status).current)

      // the pinned runtime (or global bin) was deleted to reclaim space; the
      // unit still matches byte-for-byte but would crashloop at boot.
      yield* fs.remove(dirs.stableEntry)
      const status = yield* service.status
      assert.isTrue(status.installed)
      assert.isFalse(status.current)
    }),
  )

  it.effect('fails on unsupported platforms without touching the filesystem', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/usr/local/lib/node_modules/t3/dist/bin.mjs'),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands)),
        provideHostRefs(dirs.home, 'win32', undefined),
      )

      const error = yield* service.install().pipe(Effect.flip)
      const uninstallError = yield* service.uninstall.pipe(Effect.flip)
      assert.isTrue(isUnsupportedError(error))
      assert.isTrue(isUnsupportedError(uninstallError))
      assert.lengthOf(commands, 0)
      assert.isFalse(
        yield* fs.exists(path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')),
      )
      assert.isFalse(
        yield* fs.exists(
          path.join(dirs.home, '.config', 'systemd', 'user', '456code.service.install-lock'),
        ),
      )

      const status = yield* service.status
      assert.isFalse(status.supported)
      assert.isFalse(status.installed)
    }),
  )

  it.effect('removes the unit file when an activation step fails', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/usr/local/lib/node_modules/t3/dist/bin.mjs'),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: 'loginctl' })),
        provideHostRefs(dirs.home),
      )

      const error = yield* service.install().pipe(Effect.flip)
      assert.isTrue(isCommandError(error))
      // a leftover unit would make status report "installed" even though
      // linger never happened.
      assert.isFalse(
        yield* fs.exists(path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')),
      )
      const status = yield* service.status
      assert.isFalse(status.installed)
      assert.isTrue(
        commands.some(
          ({ command, args }) =>
            command === 'systemctl' && args.join(' ') === '--user disable --now 456code.service',
        ),
      )
    }),
  )

  it.effect('restores the previous unit when a repair cannot activate', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const initialCommands: Array<RecordedCommand> = []
      const initialService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(initialCommands)), provideHostRefs(dirs.home))
      yield* initialService.install()

      const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
      const previousUnit = yield* fs.readFileString(unitPath)
      const replacementEntry = path.join(dirs.home, 'replacement-bin.mjs')
      yield* fs.writeFileString(replacementEntry, '#!/usr/bin/env node\n')
      const repairCommands: Array<RecordedCommand> = []
      const repairService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.28',
        host: makeHost(replacementEntry),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(repairCommands, { failCommand: 'loginctl' })),
        provideHostRefs(dirs.home),
      )

      const error = yield* repairService.install().pipe(Effect.flip)

      assert.isTrue(isCommandError(error))
      assert.equal(yield* fs.readFileString(unitPath), previousUnit)
      assert.isTrue(
        repairCommands.some(
          ({ command, args }) =>
            command === 'systemctl' && args.join(' ') === '--user restart 456code.service',
        ),
      )
    }),
  )

  it.effect('does not roll back over a unit replaced during failed activation', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const initialCommands: Array<RecordedCommand> = []
      const initialService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(initialCommands)), provideHostRefs(dirs.home))
      yield* initialService.install()

      const unitPath = path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')
      const replacementEntry = path.join(dirs.home, 'replacement-bin.mjs')
      const concurrentUnit = '[Service]\nEnvironment=CODE456_BOOT_SERVICE_VERSION=0.0.29\n'
      yield* fs.writeFileString(replacementEntry, '#!/usr/bin/env node\n')
      const repairCommands: Array<RecordedCommand> = []
      const repairService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.28',
        host: makeHost(replacementEntry),
      }).pipe(
        Effect.provide(
          makeRecordingRunnerLayer(repairCommands, {
            failCommand: 'loginctl',
            afterRun: (command, _args, failed) =>
              command === 'loginctl' && failed
                ? fs.writeFileString(unitPath, concurrentUnit).pipe(Effect.orDie)
                : Effect.void,
          }),
        ),
        provideHostRefs(dirs.home),
      )

      const error = yield* repairService.install().pipe(Effect.flip)

      assert.isTrue(isCommandError(error))
      assert.equal(yield* fs.readFileString(unitPath), concurrentUnit)
      assert.isFalse(
        yield* fs.exists(path.join(`${unitPath}.install-lock`, SERVER_STORAGE_LEASE_FILE)),
      )
      assert.deepEqual(
        repairCommands.map(({ command, args }) => [command, ...args].join(' ')),
        [
          'systemctl --user daemon-reload',
          'systemctl --user enable 456code.service',
          'systemctl --user restart 456code.service',
          'loginctl enable-linger',
        ],
      )
    }),
  )

  it.effect('keeps the unit when stopping it during uninstall fails', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const installCommands: Array<RecordedCommand> = []
      const installedService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(installCommands)), provideHostRefs(dirs.home))
      yield* installedService.install()

      const uninstallCommands: Array<RecordedCommand> = []
      const failingService = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost(dirs.stableEntry),
      }).pipe(
        Effect.provide(
          makeRecordingRunnerLayer(uninstallCommands, {
            failWhen: (command, args) =>
              command === 'systemctl' && args.includes('disable') && args.includes('--now'),
          }),
        ),
        provideHostRefs(dirs.home),
      )

      const error = yield* failingService.uninstall.pipe(Effect.flip)

      assert.isTrue(isCommandError(error))
      assert.isTrue(
        yield* fs.exists(path.join(dirs.home, '.config', 'systemd', 'user', '456code.service')),
      )
    }),
  )

  it.effect('appends failed steps to the boot-service log', () =>
    Effect.gen(function* ()
    {
      const { dirs, fs, path } = yield* makeTestContext()
      const commands: Array<RecordedCommand> = []
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: '0.0.27',
        host: makeHost('/usr/local/lib/node_modules/t3/dist/bin.mjs'),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: 'systemctl' })),
        provideHostRefs(dirs.home),
      )

      const error = yield* service.install().pipe(Effect.flip)
      assert.isTrue(isCommandError(error))
      if (!isCommandError(error)) return
      assert.equal(error.exitCode, 1)
      assert.equal(error.stderrLength, 'systemctl exploded'.length)

      const logPath = path.join(dirs.logsDir, 'boot-service.log')
      assert.isTrue(yield* fs.exists(logPath))
      assert.include(yield* fs.readFileString(logPath), 'exit code 1')
    }),
  )
})
