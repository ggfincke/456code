// apps/server/src/cli/service.ts
// format service status

import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import { Command, GlobalFlag } from 'effect/unstable/cli'

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

// install, update, or repair the service using the CLI version running this command.
export const reconcileService = Effect.fn('cli.service.reconcile')(function* ()
{
  const service = yield* BootService.BootService
  const status = yield* service.status
  if (status.installed && status.current)
  {
    return { changed: false, status } satisfies ServiceReconcileResult
  }
  const plan = yield* service.install
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
    return '456code service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd'
  }
  if (!status.installed)
  {
    return '456code service\n  Status: not installed\n  Next: Run `456code service install`.'
  }
  return [
    '456code service',
    `  Status: ${status.current ? `installed · 456code@${cliVersion}` : 'needs an update or repair'}`,
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

export const prepareServiceStorageMutation = Effect.fn('cli.service.prepare_storage_mutation')(
  function* ()
  {
    const service = yield* BootService.BootService
    const status = yield* service.status
    if (status.installed && status.active && !status.current)
    {
      yield* service.stop
    }
    return status
  },
)

const reconcileServiceWithStorageOwnership = Effect.fn(
  'cli.service.reconcile_with_storage_ownership',
)(function* (flags: ServiceLocationFlags)
{
  const logLevel = yield* GlobalFlag.LogLevel
  const probeConfig = yield* resolveProjectCliProbeConfig(flags, logLevel)
  const status = yield* prepareServiceStorageMutation().pipe(
    Effect.provide(bootServiceLayer(probeConfig)),
  )

  if (status.installed && status.current)
  {
    return { changed: false, status } satisfies ServiceReconcileResult
  }

  // this nested scope releases the CLI storage lease before systemd starts
  // the server process that must acquire the same lease.
  const preparation = yield* Effect.scoped(
    Effect.gen(function* ()
    {
      const { config } = yield* resolveCliAuthConfig(flags, logLevel)
      const prepared = yield* Effect.gen(function* ()
      {
        const service = yield* BootService.BootService
        return yield* service.prepareInstall
      }).pipe(Effect.provide(bootServiceLayer(config)))
      return { config, prepared }
    }).pipe(Effect.result),
  )

  if (Result.isFailure(preparation))
  {
    if (status.active)
    {
      yield* Effect.gen(function* ()
      {
        const service = yield* BootService.BootService
        yield* service.restart
      }).pipe(Effect.provide(bootServiceLayer(probeConfig)), Effect.ignore)
    }
    return yield* Effect.fail(preparation.failure)
  }

  const plan = yield* Effect.gen(function* ()
  {
    const service = yield* BootService.BootService
    return yield* service.activatePrepared(preparation.success.prepared)
  }).pipe(Effect.provide(bootServiceLayer(preparation.success.config)))
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult
})

const runServiceReconcile = (flags: ServiceLocationFlags) =>
  Effect.scoped(reconcileServiceWithStorageOwnership(flags))

const serviceInstallCommand = Command.make('install', projectLocationFlags).pipe(
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

const serviceUpdateCommand = Command.make('update', projectLocationFlags).pipe(
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
