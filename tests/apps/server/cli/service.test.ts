// tests/apps/server/cli/service.test.ts
// verify service behavior

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import { HostProcessEnvironment } from '@t3tools/shared/hostProcess'
import * as NetService from '@t3tools/shared/Net'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { Command } from 'effect/unstable/cli'
import { afterEach, vi } from 'vite-plus/test'

import packageJson from '../../../../apps/server/package.json' with { type: 'json' }
import {
  formatServiceStatus,
  reconcileService,
  serviceCommand,
  withPreparedServiceInstall,
} from '../../../../apps/server/src/cli/service.ts'
import * as BootService from '../../../../apps/server/src/service/bootService.ts'

afterEach(() => vi.restoreAllMocks())

const status = {
  supported: true,
  installed: true,
  active: true,
  current: true,
  unitPath: '/home/me/.config/systemd/user/456code.service',
  logPath: '/home/me/.456code/userdata/logs/boot-service.log',
} as const

it('reports the installed service version and host paths', () =>
{
  assert.equal(
    formatServiceStatus(status, '0.0.29'),
    [
      '456code service',
      '  Status: installed · 456code@0.0.29',
      '  Unit: /home/me/.config/systemd/user/456code.service',
      '  Logs: /home/me/.456code/userdata/logs/boot-service.log',
    ].join('\n'),
  )
})

it('gives a direct repair command for a stale service', () =>
{
  assert.include(
    formatServiceStatus({ ...status, current: false }, '0.0.29'),
    'Next: Run `npx 456code@latest service update`.',
  )
})

it('reports a newer installed service with exact-version recovery guidance', () =>
{
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: '0.0.30-nightly.1' },
    '0.0.29',
  )

  assert.include(output, '456code@0.0.30-nightly.1 (newer than this 456code@0.0.29 CLI)')
  assert.include(output, 'npx 456code@0.0.30-nightly.1 service update')
  assert.notInclude(output, 'npx 456code@latest service update')
})

function makeTestService(serviceStatus: BootService.BootServiceStatus)
{
  const installOptions: Array<BootService.BootServiceInstallOptions | undefined> = []
  const prepareOptions: Array<BootService.BootServiceInstallOptions | undefined> = []
  const plan: BootService.BootServicePlan = {
    nodePath: '/test/node',
    t3EntryPath: '/test/bin.mjs',
    environmentPath: '/test/bin',
    serviceVersion: packageJson.version,
    baseDir: '/test/base',
    unitPath: serviceStatus.unitPath,
    logPath: serviceStatus.logPath,
  }
  const service = BootService.BootService.of({
    withMutationLock: (effect) => effect,
    status: Effect.succeed(serviceStatus),
    install: (options) =>
      Effect.sync(() =>
      {
        installOptions.push(options)
        return plan
      }),
    prepareInstall: (options) =>
      Effect.sync(() =>
      {
        prepareOptions.push(options)
        return {
          plan,
          preparedUnit: '',
          installerLockToken: '',
          canonicalBaseDir: plan.baseDir,
          previousStorageOwnerToken: null,
          previousUnit: null,
          allowDowngrade: options?.allowDowngrade === true,
        }
      }),
    activatePrepared: () => Effect.succeed(plan),
    releasePreparedInstall: () => Effect.void,
    restartSnapshot: Effect.succeed({ unit: '' }),
    restartIfUnchanged: () => Effect.succeed(true),
    stop: () => Effect.succeed(true),
    uninstall: Effect.succeed(false),
  })
  return { service, installOptions, prepareOptions }
}

it.effect('refuses a downgrade before asking the service to install', () =>
  Effect.gen(function* ()
  {
    const { service, installOptions } = makeTestService({
      ...status,
      current: false,
      installedVersion: '999.0.0',
    })

    const error = yield* reconcileService().pipe(
      Effect.provideService(BootService.BootService, service),
      Effect.flip,
    )

    assert.deepInclude(error, {
      _tag: 'BootServiceDowngradeRefusedError',
      installedVersion: '999.0.0',
      targetVersion: packageJson.version,
    })
    assert.deepEqual(installOptions, [])
  }),
)

it.effect('passes an explicit downgrade override to the service', () =>
  Effect.gen(function* ()
  {
    const { service, installOptions } = makeTestService({
      ...status,
      current: false,
      installedVersion: '999.0.0',
    })

    const result = yield* reconcileService({ allowDowngrade: true }).pipe(
      Effect.provideService(BootService.BootService, service),
    )

    assert.isTrue(result.changed)
    assert.deepEqual(installOptions, [{ allowDowngrade: true }])
  }),
)

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))(
  'service install and update flags',
  (it) =>
  {
    it.effect.each(['install', 'update'] as const)(
      '%s refuses a downgrade before preparing service storage',
      (command) =>
        Effect.gen(function* ()
        {
          const fs = yield* FileSystem.FileSystem
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: '456code-service-cli-test-' })
          const { service, prepareOptions } = makeTestService({
            ...status,
            active: false,
            current: false,
            installedVersion: '999.0.0',
          })
          vi.spyOn(BootService, 'layer').mockReturnValue(
            Layer.succeed(BootService.BootService, service),
          )

          const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
            command,
            '--base-dir',
            baseDir,
          ]).pipe(
            Effect.provideService(HostProcessEnvironment, {}),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
            Effect.flip,
          )

          assert.equal(error._tag, 'BootServiceDowngradeRefusedError')
          assert.deepEqual(prepareOptions, [])
        }),
    )

    it.effect.each(['install', 'update'] as const)('%s accepts --allow-downgrade', (command) =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: '456code-service-cli-test-' })
        const { service, prepareOptions } = makeTestService({
          ...status,
          active: false,
          current: false,
          installedVersion: '999.0.0',
        })
        vi.spyOn(BootService, 'layer').mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        )

        yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          '--base-dir',
          baseDir,
          '--allow-downgrade',
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        )

        assert.deepEqual(prepareOptions, [{ allowDowngrade: true }])
      }),
    )

    it.effect('holds one mutation lock across the update storage handoff', () =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: '456code-service-cli-test-' })
        const operations: Array<string> = []
        let lockDepth = 0
        const { service: baseService } = makeTestService({ ...status, current: false })
        const assertLocked = (operation: string) =>
          Effect.sync(() =>
          {
            assert.equal(lockDepth, 1)
            operations.push(operation)
          })
        const service = BootService.BootService.of({
          ...baseService,
          withMutationLock: (effect) =>
            Effect.acquireUseRelease(
              Effect.sync(() =>
              {
                lockDepth += 1
                operations.push('lock')
              }),
              () => effect,
              () =>
                Effect.sync(() =>
                {
                  operations.push('unlock')
                  lockDepth -= 1
                }),
            ),
          status: assertLocked('status').pipe(Effect.as({ ...status, current: false })),
          restartSnapshot: assertLocked('snapshot').pipe(Effect.as({ unit: 'previous unit' })),
          stop: () => assertLocked('stop').pipe(Effect.as(true)),
          prepareInstall: () =>
            assertLocked('prepare').pipe(Effect.andThen(baseService.prepareInstall())),
          activatePrepared: (prepared) =>
            assertLocked('activate').pipe(Effect.andThen(baseService.activatePrepared(prepared))),
          releasePreparedInstall: (prepared) =>
            assertLocked('release').pipe(
              Effect.andThen(baseService.releasePreparedInstall(prepared)),
            ),
        })
        vi.spyOn(BootService, 'layer').mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        )

        yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          'update',
          '--base-dir',
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        )

        assert.deepEqual(operations, [
          'lock',
          'status',
          'snapshot',
          'stop',
          'prepare',
          'activate',
          'release',
          'unlock',
        ])
        assert.equal(lockDepth, 0)
      }),
    )

    it.effect('releases a prepared install when interrupted in the storage-release gap', () =>
      Effect.gen(function* ()
      {
        const prepared = yield* Deferred.make<void>()
        const allowPreparationReturn = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        let activationCount = 0
        let releaseCount = 0
        const { service } = makeTestService({
          ...status,
          active: false,
          current: false,
        })
        const installation = withPreparedServiceInstall(
          service.prepareInstall().pipe(
            Effect.tap(() => Deferred.succeed(prepared, undefined)),
            Effect.tap(() => Deferred.await(allowPreparationReturn)),
          ),
          (preparedInstall) =>
            Effect.sync(() => (activationCount += 1)).pipe(
              Effect.andThen(service.activatePrepared(preparedInstall)),
            ),
          (preparedInstall) =>
            Effect.sync(() => (releaseCount += 1)).pipe(
              Effect.andThen(service.releasePreparedInstall(preparedInstall)),
              Effect.andThen(Deferred.succeed(released, undefined)),
            ),
        )

        const installFiber = yield* installation.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(prepared).pipe(
          Effect.timeout('5 seconds'),
          TestClock.withLive,
          Effect.catch(() => Effect.sync(() => assert.fail('preparation did not complete'))),
        )
        assert.equal(activationCount, 0)
        const interruption = yield* Fiber.interrupt(installFiber).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.succeed(allowPreparationReturn, undefined)
        yield* Fiber.join(interruption).pipe(
          Effect.timeout('5 seconds'),
          TestClock.withLive,
          Effect.catch(() => Effect.sync(() => assert.fail('interruption did not settle'))),
        )
        yield* Deferred.await(released).pipe(
          Effect.timeout('5 seconds'),
          TestClock.withLive,
          Effect.catch(() => Effect.sync(() => assert.fail('prepared install was not released'))),
        )

        assert.equal(activationCount, 0)
        assert.equal(releaseCount, 1)
      }),
    )

    it.effect('uses an exact stopped-unit snapshot for preparation-failure recovery', () =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: '456code-service-cli-test-' })
        const restartSnapshots: Array<BootService.BootServiceRestartSnapshot> = []
        const { service: baseService } = makeTestService({ ...status, current: false })
        const service = BootService.BootService.of({
          ...baseService,
          prepareInstall: () =>
            Effect.fail(new BootService.BootServiceInstallError({ cause: new Error('failed') })),
          restartSnapshot: Effect.succeed({ unit: 'previous unit' }),
          restartIfUnchanged: (snapshot) =>
            Effect.sync(() =>
            {
              restartSnapshots.push(snapshot)
              return true
            }),
        })
        vi.spyOn(BootService, 'layer').mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        )

        const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          'update',
          '--base-dir',
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.flip,
        )

        assert.equal(error._tag, 'BootServiceInstallError')
        assert.deepEqual(restartSnapshots, [{ unit: 'previous unit' }])
      }),
    )
  },
)

it('explains service availability without systemd', () =>
{
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, '0.0.29'),
    'Supported on: Linux with systemd',
  )
})
