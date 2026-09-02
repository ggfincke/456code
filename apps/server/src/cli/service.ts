// apps/server/src/cli/service.ts
// format service status

import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { Command, Flag, GlobalFlag } from 'effect/unstable/cli'

import packageJson from '../../package.json' with { type: 'json' }
import * as BootService from '../service/bootService.ts'
import type * as ServerConfig from '../config.ts'
import * as ProcessRunner from '../process/processRunner.ts'
import {
  projectLocationFlags,
  resolveCliAuthConfig,
  resolveProjectCliProbeConfig,
} from './config.ts'

export const bootServiceLayer = (config: ServerConfig.ServerConfig['Service']) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
  }).pipe(Layer.provide(ProcessRunner.layer))

export type ServiceReconcileResult =
  | {
      readonly changed: false
      readonly status: BootService.BootServiceStatus
    }
  | {
      readonly changed: true
      readonly previouslyInstalled: boolean
      readonly plan: BootService.BootServicePlan
    }

interface ServiceLocationFlags
{
  readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]['baseDir']
}

interface ServiceReconcileFlags extends ServiceLocationFlags
{
  readonly allowDowngrade: boolean
}

const requireServiceDowngradeAllowed = (
  status: BootService.BootServiceStatus,
  options?: BootService.BootServiceInstallOptions,
) =>
  status.installedVersion !== undefined &&
  options?.allowDowngrade !== true &&
  (BootService.compareServiceVersions(status.installedVersion, packageJson.version) ?? 0) > 0
    ? Effect.fail(
        new BootService.BootServiceDowngradeRefusedError({
          installedVersion: status.installedVersion,
          targetVersion: packageJson.version,
        }),
      )
    : Effect.void

// install, update, or repair the service using the CLI version running this command.
export const reconcileService = Effect.fn('cli.service.reconcile')(function* (
  options?: BootService.BootServiceInstallOptions,
)
{
  const service = yield* BootService.BootService
  const status = yield* service.status
  if (status.installed && status.current)
  {
    return { changed: false, status } satisfies ServiceReconcileResult
  }
  yield* requireServiceDowngradeAllowed(status, options)
  const plan = yield* service.install(options)
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult
})

export function formatServiceStatus(
  status: BootService.BootServiceStatus,
  cliVersion: string,
): string
{
  if (!status.supported)
  {
    return '456code service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd, macOS with launchd'
  }
  if (!status.installed)
  {
    return '456code service\n  Status: not installed\n  Next: Run `456code service install`.'
  }
  const installedVersion = status.installedVersion ?? cliVersion
  if (
    !status.current &&
    status.installedVersion !== undefined &&
    (BootService.compareServiceVersions(status.installedVersion, cliVersion) ?? 0) > 0
  )
  {
    return [
      '456code service',
      `  Status: installed · 456code@${installedVersion} (newer than this 456code@${cliVersion} CLI)`,
      `  Unit: ${status.unitPath}`,
      `  Logs: ${status.logPath}`,
      `  Next: Use \`npx 456code@${installedVersion} service update\` to repair it, or pass \`--allow-downgrade\` explicitly.`,
    ].join('\n')
  }
  return [
    '456code service',
    `  Status: ${status.current ? `installed · 456code@${installedVersion}` : 'needs an update or repair'}`,
    `  Unit: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...(status.current ? [] : ['  Next: Run `npx 456code@latest service update`.']),
  ].join('\n')
}

const runServiceCommandUnscoped = Effect.fn('cli.service.run')(function* <A, E>(
  flags: ServiceLocationFlags,
  run: Effect.Effect<A, E, BootService.BootService>,
)
{
  const logLevel = yield* GlobalFlag.LogLevel
  const config = yield* resolveProjectCliProbeConfig(flags, logLevel)
  return yield* run.pipe(Effect.provide(bootServiceLayer(config)))
})

const runServiceCommand = <A, E>(
  flags: ServiceLocationFlags,
  run: Effect.Effect<A, E, BootService.BootService>,
) => Effect.scoped(runServiceCommandUnscoped(flags, run))

export const withPreparedServiceInstall = <A, B, E, E2, R, R2>(
  prepare: Effect.Effect<A, E, R>,
  activate: (prepared: A) => Effect.Effect<B, E2, R2>,
  release: (prepared: A) => Effect.Effect<void>,
) =>
  Effect.acquireUseRelease(prepare, activate, (prepared) =>
    release(prepared).pipe(Effect.uninterruptible),
  )

const prepareServiceStorageHandoff = Effect.fn('cli.service.prepare_storage_handoff')(function* (
  options?: BootService.BootServiceInstallOptions,
  onRestartSnapshot?: (snapshot: BootService.BootServiceRestartSnapshot) => void,
)
{
  const service = yield* BootService.BootService
  const status = yield* service.status
  yield* requireServiceDowngradeAllowed(status, options)
  let restartSnapshot: BootService.BootServiceRestartSnapshot | null = null
  if (status.installed && status.active && !status.current)
  {
    restartSnapshot = yield* service.restartSnapshot
    if (restartSnapshot !== null) onRestartSnapshot?.(restartSnapshot)
    yield* service.stop(options)
  }
  return { status, restartSnapshot }
})

export const prepareServiceStorageMutation = Effect.fn('cli.service.prepare_storage_mutation')(
  function* (options?: BootService.BootServiceInstallOptions)
  {
    const service = yield* BootService.BootService
    return yield* service.withMutationLock(
      prepareServiceStorageHandoff(options).pipe(Effect.map(({ status }) => status)),
    )
  },
)

const reconcileServiceWithStorageOwnership = Effect.fn(
  'cli.service.reconcile_with_storage_ownership',
)(function* (flags: ServiceReconcileFlags)
{
  const logLevel = yield* GlobalFlag.LogLevel
  const probeConfig = yield* resolveProjectCliProbeConfig(flags, logLevel)
  const installOptions = { allowDowngrade: flags.allowDowngrade }
  return yield* Effect.gen(function* ()
  {
    const service = yield* BootService.BootService
    let restartSnapshot: BootService.BootServiceRestartSnapshot | null = null
    let preparedAcquired = false
    return yield* service.withMutationLock(
      Effect.gen(function* ()
      {
        const storageMutation = yield* prepareServiceStorageHandoff(installOptions, (snapshot) =>
        {
          restartSnapshot = snapshot
        })
        const status = storageMutation.status

        if (status.installed && status.current)
        {
          return { changed: false, status } satisfies ServiceReconcileResult
        }

        const plan = yield* withPreparedServiceInstall(
          // this nested scope releases the CLI storage lease before systemd starts
          // the server process that must acquire the same lease.
          Effect.scoped(
            Effect.gen(function* ()
            {
              const { config } = yield* resolveCliAuthConfig(flags, logLevel)
              const handoff = yield* Effect.gen(function* ()
              {
                const service = yield* BootService.BootService
                const prepared = yield* service.prepareInstall(installOptions)
                return { prepared, release: service.releasePreparedInstall(prepared) }
              }).pipe(Effect.provide(bootServiceLayer(config)))
              return { config, ...handoff }
            }),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() =>
              {
                preparedAcquired = true
              }),
            ),
          ),
          (preparation) =>
            Effect.gen(function* ()
            {
              const service = yield* BootService.BootService
              return yield* service.activatePrepared(preparation.prepared)
            }).pipe(Effect.provide(bootServiceLayer(preparation.config))),
          (preparation) => preparation.release,
        )

        return {
          changed: true,
          previouslyInstalled: status.installed,
          plan,
        } satisfies ServiceReconcileResult
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && restartSnapshot !== null && !preparedAcquired
            ? service.restartIfUnchanged(restartSnapshot).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    )
  }).pipe(Effect.provide(bootServiceLayer(probeConfig)))
})

const runServiceReconcile = (flags: ServiceReconcileFlags) =>
  Effect.scoped(reconcileServiceWithStorageOwnership(flags))

const serviceReconcileFlags = {
  ...projectLocationFlags,
  allowDowngrade: Flag.boolean('allow-downgrade').pipe(
    Flag.withDescription('Allow replacing a newer installed service with this older CLI version.'),
    Flag.withDefault(false),
  ),
}

const serviceInstallCommand = Command.make('install', serviceReconcileFlags).pipe(
  Command.withDescription('Install 456code as a background service for this user.'),
  Command.withHandler((flags) =>
    Effect.gen(function* ()
    {
      const result = yield* runServiceReconcile(flags)
      if (!result.changed)
      {
        yield* Console.log(
          `456code service is already installed with 456code@${packageJson.version}.`,
        )
        return
      }
      yield* Console.log(
        `${result.previouslyInstalled ? 'Updated' : 'Installed'} 456code service with 456code@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
      )
    }),
  ),
)

const serviceUpdateCommand = Command.make('update', serviceReconcileFlags).pipe(
  Command.withDescription(
    'Update or repair the background service using this CLI version. Use `npx 456code@latest service update` for the latest release.',
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* ()
    {
      const result = yield* runServiceReconcile(flags)
      if (!result.changed)
      {
        yield* Console.log(`456code service is already using 456code@${packageJson.version}.`)
        return
      }
      yield* Console.log(
        `${result.previouslyInstalled ? 'Updated' : 'Installed'} 456code service with 456code@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
      )
    }),
  ),
)

const serviceUninstallCommand = Command.make('uninstall', projectLocationFlags).pipe(
  Command.withDescription('Stop and remove the 456code background service.'),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* ()
      {
        const service = yield* BootService.BootService
        const removed = yield* service.uninstall
        yield* Console.log(
          removed ? 'Removed the 456code service.' : '456code service is not installed.',
        )
      }),
    ),
  ),
)

const serviceStatusCommand = Command.make('status', projectLocationFlags).pipe(
  Command.withDescription('Show whether the 456code background service is installed.'),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* ()
      {
        const service = yield* BootService.BootService
        yield* Console.log(formatServiceStatus(yield* service.status, packageJson.version))
      }),
    ),
  ),
)

export const serviceCommand = Command.make('service').pipe(
  Command.withDescription('Manage the 456code background service.'),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceUninstallCommand,
    serviceUpdateCommand,
    serviceStatusCommand,
  ]),
)
