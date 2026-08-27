// apps/server/src/service/bootService.ts
// installs and manages the per-user 456code background service

import * as Context from 'effect/Context'
import * as Clock from 'effect/Clock'
import * as Config from 'effect/Config'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from '@t3tools/shared/hostProcess'

import * as ProcessRunner from '../process/processRunner.ts'
import { SERVER_STORAGE_LEASE_FILE, ServerStorageLeaseOwner } from '../serverStorageLease.ts'
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from './pinnedRuntime.ts'

// installs 456code as a per-user systemd unit or macOS launch agent. The
// service runs a stable or pinned runtime, never an ephemeral package-manager
// cache whose eviction could break startup.

const BOOT_SERVICE_NAME = '456code'
const DEFAULT_BOOT_SERVICE_PATH = '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin'

export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`
export const BOOT_SERVICE_LAUNCHD_LABEL = 'com.t3tools.456code.service'
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`
export const BOOT_SERVICE_UNIT_ENV = 'CODE456_BOOT_SERVICE_UNIT'

// launchd may wait for the plist's 90-second ExitTimeOut before bootout returns.
const STOP_STEP_TIMEOUT = '120 seconds'

const decodeStorageOwner = Schema.decodeUnknownOption(
  Schema.fromJsonString(ServerStorageLeaseOwner),
)

const EPHEMERAL_CACHE_SEGMENTS = [
  // npx
  '/_npx/',
  '\\_npx\\',
  // pnpm dlx (~/.cache/pnpm/dlx and $PNPM_HOME/.pnpm/dlx)
  '/pnpm/dlx/',
  '/.pnpm/dlx/',
  // bunx
  '/.bun/install/cache/',
]

// `npx 456code` (and pnpm dlx / bunx) run out of ephemeral package-manager
// caches that can be evicted at any time — a boot service must never point
// there. Global installs, repo checkouts, and the pinned runtime below are
// all stable.
export function isEphemeralCacheEntry(entryPath: string): boolean
{
  return EPHEMERAL_CACHE_SEGMENTS.some((segment) => entryPath.includes(segment))
}

// systemd expands `%` specifiers in most directive values, including the
// `append:` file paths, which take the rest of the line literally and must
// NOT be quoted.
export function escapeSystemdSpecifiers(value: string): string
{
  return value.replaceAll('%', '%%')
}

// systemd word-splits ExecStart and Environment values and expands `%`
// specifiers, so paths with spaces or percents must be quoted and escaped.
export function quoteSystemdValue(value: string): string
{
  const escaped = escapeSystemdSpecifiers(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
  return /[\s"'\\]/.test(escaped) ? `"${escaped}"` : escaped
}

export interface BootServicePlan
{
  // absolute path of the node binary running this CLI.
  readonly nodePath: string
  // absolute path of the pinned 456code entry point the unit will run.
  readonly t3EntryPath: string
  readonly environmentPath: string
  readonly baseDir: string
  readonly logPath: string
  readonly unitPath: string
}

export interface BootServicePreparedInstall
{
  readonly plan: BootServicePlan
  readonly canonicalBaseDir: string
  readonly previousStorageOwnerToken: string | null
  readonly previousUnit: string | null
}

// pure so it is testable byte-for-byte. systemd user units run with a
// minimal environment: executable paths are absolute, while PATH preserves
// provider and source-control CLIs discovered by the installing process.
// failures land in `logPath` because systemctl failures are otherwise invisible.
export function renderBootServiceUnit(plan: BootServicePlan): string
{
  // no After=network-online.target: it does not exist in the systemd *user*
  // manager, so ordering on it is silently ignored. The server retries its
  // relay connection, and Restart=always covers early-boot failures.
  return [
    '[Unit]',
    'Description=456code server',
    // give up after 5 crashes in 5 minutes so a persistently broken install
    // (deleted runtime, broken workspace) stops instead of restarting every
    // 5s forever and growing the unrotated append log without bound.
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    'WorkingDirectory=%h',
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `Environment=${quoteSystemdValue(`PATH=${plan.environmentPath}`)}`,
    `ExecStart=${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.t3EntryPath)} serve`,
    'Restart=always',
    'RestartSec=5',
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function escapeXmlText(value: string): string
{
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string },
): string
{
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXmlText(plan.nodePath)}</string>`,
    `    <string>${escapeXmlText(plan.t3EntryPath)}</string>`,
    '    <string>serve</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>T3CODE_HOME</key>',
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_PLIST_FILE}</string>`,
    '    <key>PATH</key>',
    `    <string>${escapeXmlText(plan.environmentPath)}</string>`,
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>ExitTimeOut</key>',
    '  <integer>90</integer>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  'BootServiceUnsupportedError',
  { platform: Schema.String },
)
{
  override get message(): string
  {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`
  }
}

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  'BootServiceCommandError',
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`
  }
}

export class BootServiceInstallError extends Schema.TaggedErrorClass<BootServiceInstallError>()(
  'BootServiceInstallError',
  { cause: Schema.Defect() },
)
{
  override get message(): string
  {
    return 'Could not set up the 456code background service.'
  }
}

export type BootServiceError =
  BootServiceUnsupportedError | BootServiceCommandError | BootServiceInstallError

export interface BootServiceStatus
{
  readonly supported: boolean
  readonly installed: boolean
  readonly active: boolean
  // false when the installed unit no longer matches what install would write.
  readonly current: boolean
  readonly unitPath: string
  readonly logPath: string
}

export class BootService extends Context.Service<
  BootService,
  {
    // materializes baseDir-owned runtime state and the unit without starting it.
    readonly prepareInstall: Effect.Effect<BootServicePreparedInstall, BootServiceError>
    // activates a prepared unit after the caller releases storage ownership.
    readonly activatePrepared: (
      prepared: BootServicePreparedInstall,
    ) => Effect.Effect<BootServicePlan, BootServiceError>
    // installs the pinned runtime + unit, enables linger, starts the service.
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>
    // restores a previously installed unit after lease-scoped preparation fails.
    readonly restart: Effect.Effect<void, BootServiceError>
    // stops the installed unit without removing it so a storage-owning server
    // releases its lease before an update replaces the runtime or unit.
    readonly stop: Effect.Effect<boolean, BootServiceError>
    // stops and removes the unit; leaves the pinned runtime for reuse.
    // returns whether a unit was actually removed.
    readonly uninstall: Effect.Effect<boolean, BootServiceError>
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>
  }
>()('456code/service/bootService')
{}

export interface BootServiceHost
{
  readonly execPath: string
  readonly cliEntryPath: string
  // embeddings that own an equivalent readiness signal may disable this check.
  readonly awaitStorageOwner?: boolean
}

export const make = Effect.fn('service.boot_service.make')(function* (input: {
  readonly baseDir: string
  readonly logsDir: string
  readonly cliVersion: string
  readonly host?: BootServiceHost
  readonly awaitStorageOwner?: boolean
})
{
  const hostExecPath = yield* HostProcessExecutablePath
  const hostArguments = yield* HostProcessArguments
  const host = input.host ?? {
    execPath: hostExecPath,
    // when running the packed CLI this is dist/bin.mjs; when stable (global
    // install, repo checkout) the boot service runs this same artifact.
    cliEntryPath: hostArguments[1] ?? '',
  }
  const awaitStorageOwnerReadiness = input.awaitStorageOwner ?? host.awaitStorageOwner ?? true
  const platform = yield* HostProcessPlatform
  const uid = yield* HostProcessUserId
  const hostEnvironment = yield* HostProcessEnvironment
  const homeDir = yield* Config.string('HOME').pipe(Config.withDefault(''))
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const runner = yield* ProcessRunner.ProcessRunner

  const isSystemd = platform === 'linux'
  const isLaunchd = platform === 'darwin' && uid !== undefined
  const unitDir = isLaunchd
    ? path.join(homeDir, 'Library', 'LaunchAgents')
    : path.join(homeDir, '.config', 'systemd', 'user')
  const unitPath = path.join(unitDir, isLaunchd ? BOOT_SERVICE_PLIST_FILE : BOOT_SERVICE_UNIT_FILE)
  const logPath = path.join(input.logsDir, 'boot-service.log')
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion)

  const requireSupportedPlatform = Effect.gen(function* ()
  {
    if ((!isSystemd && !isLaunchd) || homeDir === '')
    {
      return yield* new BootServiceUnsupportedError({ platform })
    }
  })

  const runStep = Effect.fn('service.boot_service.run_step')(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  )
  {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: 'a',
            }),
          ),
          Effect.ignore,
        ),
      ),
    )
  })

  // ensures plannedEntryPath exists before the unit points at it. A stable
  // install (global bin, repo checkout) is used as-is; an ephemeral cache
  // entry is replaced by `npm install --prefix`-ing the exact running
  // version into <baseDir>/runtime/versions/<v>. A real install (not a copy
  // of bin.mjs) because 456code ships native deps like node-pty.
  const ensurePinnedRuntime = Effect.gen(function* ()
  {
    if (!isEphemeralCacheEntry(host.cliEntryPath))
    {
      return
    }
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
    }).pipe(
      Effect.mapError((error) =>
        error.step.startsWith('installing')
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error.cause,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: 'a',
            }),
          ),
          Effect.ignore,
        ),
      ),
    )
  })

  // where the unit will point: derivable without touching the network, so
  // status can compare its definition purely before checking runtime readiness.
  const plannedEntryPath = isEphemeralCacheEntry(host.cliEntryPath)
    ? runtimePaths.entryPath
    : host.cliEntryPath
  const plan: BootServicePlan = {
    nodePath: host.execPath,
    t3EntryPath: plannedEntryPath,
    environmentPath: isLaunchd
      ? [
          ...new Set(
            [
              ...(hostEnvironment.PATH?.split(':') ?? []),
              path.dirname(host.execPath),
              '/opt/homebrew/bin',
              ...DEFAULT_BOOT_SERVICE_PATH.split(':'),
            ].filter(
              (entry) =>
                entry.trim().length > 0 &&
                !Array.from(entry).some((character) =>
                  {
                  const code = character.codePointAt(0)!
                  return (
                    (code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
                    (code >= 0xd800 && code <= 0xdfff) ||
                    code === 0xfffe ||
                    code === 0xffff
                  )
                }),
            ),
          ),
        ].join(':')
      : hostEnvironment.PATH?.trim() === '' || hostEnvironment.PATH === undefined
        ? DEFAULT_BOOT_SERVICE_PATH
        : hostEnvironment.PATH,
    baseDir: input.baseDir,
    logPath,
    unitPath,
  }
  const launchdDomainTarget = uid === undefined ? '' : `gui/${uid}`
  const launchdServiceTarget = `${launchdDomainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`
  const renderServiceDefinition = () =>
    isLaunchd ? renderBootServicePlist(plan, { homeDir }) : renderBootServiceUnit(plan)

  const readStorageOwner = Effect.fn('service.boot_service.read_storage_owner')(function* (
    canonicalBaseDir: string,
  )
  {
    return yield* fs.readFileString(path.join(canonicalBaseDir, SERVER_STORAGE_LEASE_FILE)).pipe(
      Effect.map(decodeStorageOwner),
      Effect.orElseSucceed(() => Option.none()),
    )
  })

  const restoreUnitFile = Effect.fn('service.boot_service.restore_unit_file')(function* (
    previousUnit: string | null,
  )
  {
    if (previousUnit === null)
    {
      yield* fs.remove(unitPath).pipe(Effect.ignore)
      return
    }
    yield* fs.writeFileString(unitPath, previousUnit).pipe(Effect.ignore)
  })

  const prepareInstall: BootService['Service']['prepareInstall'] = Effect.gen(function* ()
  {
    yield* requireSupportedPlatform
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))

    yield* ensurePinnedRuntime

    const canonicalBaseDir = yield* fs
      .realPath(input.baseDir)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))
    const previousStorageOwner = yield* readStorageOwner(canonicalBaseDir)
    const previousUnit = yield* fs.exists(unitPath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(unitPath).pipe(Effect.map((unit) => unit as string | null))
          : Effect.succeed(null),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    )

    yield* fs.makeDirectory(unitDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(unitPath, renderServiceDefinition())),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
      Effect.tapError(() => restoreUnitFile(previousUnit)),
    )

    return {
      plan,
      canonicalBaseDir,
      previousStorageOwnerToken: Option.isSome(previousStorageOwner)
        ? previousStorageOwner.value.token
        : null,
      previousUnit,
    }
  }).pipe(Effect.withSpan('service.boot_service.prepare_install'))

  const awaitStorageOwner = Effect.fn('service.boot_service.await_storage_owner')(function* (
    prepared: BootServicePreparedInstall,
  )
  {
    if (!awaitStorageOwnerReadiness) return

    const deadline = (yield* Clock.currentTimeMillis) + 10_000
    while (true)
    {
      const owner = yield* readStorageOwner(prepared.canonicalBaseDir)
      if (
        Option.isSome(owner) &&
        owner.value.canonicalBaseDir === prepared.canonicalBaseDir &&
        owner.value.pid !== process.pid &&
        owner.value.token !== prepared.previousStorageOwnerToken
      )
      {
        break
      }
      if ((yield* Clock.currentTimeMillis) >= deadline)
      {
        return yield* new BootServiceCommandError({
          step: 'waiting for the service to acquire storage ownership',
        })
      }
      yield* Effect.sleep('100 millis')
    }

    yield* isLaunchd
      ? runStep('verifying the service is active', 'launchctl', ['print', launchdServiceTarget])
      : runStep('verifying the service is active', 'systemctl', [
          '--user',
          'is-active',
          '--quiet',
          BOOT_SERVICE_UNIT_FILE,
        ])
  })

  // if activation fails partway (e.g. enable succeeds but restart/linger
  // fails), leave nothing behind: disable removes the enable symlink, remove
  // deletes the file, daemon-reload clears the stale definition — otherwise a
  // dangling wants/ symlink logs "Failed to load unit" at every boot and the
  // next lifecycle command misreports the state.
  const rollbackFailedInstall = Effect.fn('service.boot_service.rollback_failed_install')(
    function* (previousUnit: string | null)
    {
      if (previousUnit !== null)
      {
        if (isLaunchd)
        {
          yield* runStep(
            'stopping the failed launch agent',
            'launchctl',
            ['bootout', '--wait', launchdServiceTarget],
            { timeout: STOP_STEP_TIMEOUT },
          ).pipe(Effect.ignore)
        }
        yield* fs.writeFileString(unitPath, previousUnit).pipe(Effect.ignore)
      }
      else
      {
        yield* isLaunchd
          ? runStep(
              'cleaning up the service',
              'launchctl',
              ['bootout', '--wait', launchdServiceTarget],
              { timeout: STOP_STEP_TIMEOUT },
            ).pipe(Effect.ignore)
          : runStep('cleaning up the service', 'systemctl', [
              '--user',
              'disable',
              '--now',
              BOOT_SERVICE_UNIT_FILE,
            ]).pipe(Effect.ignore)
        yield* fs.remove(unitPath).pipe(Effect.ignore)
      }
      if (isSystemd)
      {
        yield* runStep('reloading systemd user units', 'systemctl', [
          '--user',
          'daemon-reload',
        ]).pipe(Effect.ignore)
      }
      if (previousUnit !== null)
      {
        yield* isLaunchd
          ? runStep('restoring the previous service', 'launchctl', [
              'bootstrap',
              launchdDomainTarget,
              unitPath,
            ]).pipe(Effect.ignore)
          : runStep('restoring the previous service', 'systemctl', [
              '--user',
              'restart',
              BOOT_SERVICE_UNIT_FILE,
            ]).pipe(Effect.ignore)
      }
    },
  )

  const activatePrepared: BootService['Service']['activatePrepared'] = Effect.fn(
    'service.boot_service.activate_prepared',
  )(function* (prepared)
  {
    yield* requireSupportedPlatform
    if (
      prepared.plan.unitPath !== unitPath ||
      prepared.plan.baseDir !== plan.baseDir ||
      prepared.plan.t3EntryPath !== plan.t3EntryPath
    )
    {
      return yield* new BootServiceInstallError({
        cause: new Error('Prepared boot service belongs to a different service configuration.'),
      })
    }

    yield* Effect.gen(function* ()
    {
      if (isLaunchd)
      {
        yield* runStep(
          'stopping the installed launch agent',
          'launchctl',
          ['bootout', '--wait', launchdServiceTarget],
          { timeout: STOP_STEP_TIMEOUT },
        ).pipe(Effect.ignore)
        yield* runStep('enabling the launch agent', 'launchctl', [
          'enable',
          launchdServiceTarget,
        ]).pipe(Effect.ignore)
        yield* runStep('starting the service', 'launchctl', [
          'bootstrap',
          launchdDomainTarget,
          unitPath,
        ])
      }
      else
      {
        yield* runStep('reloading systemd user units', 'systemctl', ['--user', 'daemon-reload'])
        yield* runStep('enabling the service', 'systemctl', [
          '--user',
          'enable',
          BOOT_SERVICE_UNIT_FILE,
        ])
        yield* runStep('starting the service', 'systemctl', [
          '--user',
          'restart',
          BOOT_SERVICE_UNIT_FILE,
        ])
        yield* runStep('enabling lingering for this user', 'loginctl', ['enable-linger'])
      }
      yield* awaitStorageOwner(prepared)
    }).pipe(Effect.tapError(() => rollbackFailedInstall(prepared.previousUnit)))

    return prepared.plan
  })

  const install: BootService['Service']['install'] = prepareInstall.pipe(
    Effect.flatMap(activatePrepared),
    Effect.withSpan('service.boot_service.install'),
  )

  const restart: BootService['Service']['restart'] = Effect.gen(function* ()
  {
    yield* requireSupportedPlatform
    const canonicalBaseDir = yield* fs
      .realPath(input.baseDir)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))
    const previousStorageOwner = yield* readStorageOwner(canonicalBaseDir)
    if (isLaunchd)
    {
      yield* runStep(
        'stopping the installed launch agent',
        'launchctl',
        ['bootout', '--wait', launchdServiceTarget],
        { timeout: STOP_STEP_TIMEOUT },
      ).pipe(Effect.ignore)
      yield* runStep('restoring the previous service', 'launchctl', [
        'bootstrap',
        launchdDomainTarget,
        unitPath,
      ])
    }
    else
    {
      yield* runStep('restoring the previous service', 'systemctl', [
        '--user',
        'restart',
        BOOT_SERVICE_UNIT_FILE,
      ])
    }
    yield* awaitStorageOwner({
      plan,
      canonicalBaseDir,
      previousStorageOwnerToken: Option.isSome(previousStorageOwner)
        ? previousStorageOwner.value.token
        : null,
      previousUnit: null,
    })
  }).pipe(Effect.withSpan('service.boot_service.restart'))

  const uninstall: BootService['Service']['uninstall'] = Effect.gen(function* ()
  {
    yield* requireSupportedPlatform
    const exists = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))
    if (!exists)
    {
      return false
    }
    yield* isLaunchd
      ? runStep('stopping the service', 'launchctl', ['bootout', '--wait', launchdServiceTarget], {
          timeout: STOP_STEP_TIMEOUT,
        }).pipe(Effect.ignore)
      : runStep('stopping the service', 'systemctl', [
          '--user',
          'disable',
          '--now',
          BOOT_SERVICE_UNIT_FILE,
        ])
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))
    if (isSystemd)
    {
      yield* runStep('reloading systemd user units', 'systemctl', ['--user', 'daemon-reload'])
    }
    return true
  }).pipe(Effect.withSpan('service.boot_service.uninstall'))

  const stop: BootService['Service']['stop'] = Effect.gen(function* ()
  {
    yield* requireSupportedPlatform
    const exists = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))
    if (!exists)
    {
      return false
    }
    yield* isLaunchd
      ? runStep('stopping the service', 'launchctl', ['bootout', '--wait', launchdServiceTarget], {
          timeout: STOP_STEP_TIMEOUT,
        }).pipe(Effect.ignore)
      : runStep('stopping the service', 'systemctl', ['--user', 'stop', BOOT_SERVICE_UNIT_FILE])
    return true
  }).pipe(Effect.withSpan('service.boot_service.stop'))

  const status: BootService['Service']['status'] = Effect.gen(function* ()
  {
    if ((!isSystemd && !isLaunchd) || homeDir === '')
    {
      return {
        supported: false,
        installed: false,
        active: false,
        current: false,
        unitPath,
        logPath,
      }
    }
    const unitExists = yield* fs.exists(unitPath)
    if (!unitExists)
    {
      return { supported: true, installed: false, active: false, current: false, unitPath, logPath }
    }
    const unit = yield* fs.readFileString(unitPath)
    // a unit is current only if it matches what install would write now (an
    // older CLI wrote a different runtime/node path) AND the entry point it
    // references still exists (a pinned runtime under ~/.456code can be deleted to
    // reclaim space). Either mismatch makes connect offer a repair.
    const [entryExists, sentinelExists] = yield* Effect.all([
      fs.exists(plannedEntryPath),
      isEphemeralCacheEntry(host.cliEntryPath)
        ? fs.exists(runtimePaths.sentinelPath)
        : Effect.succeed(true),
    ])
    // installer shells vary; only launchd's persisted PATH is installation-specific.
    const normalizeDefinition = (definition: string) =>
      isLaunchd
        ? definition.replace(/(<key>PATH<\/key>\s*<string>)[^<]*(<\/string>)/u, '$1$2')
        : definition
    const definitionCurrent =
      normalizeDefinition(unit) === normalizeDefinition(renderServiceDefinition()) &&
      entryExists &&
      sentinelExists
    const active = yield* runner
      .run(
        isLaunchd
          ? { command: 'launchctl', args: ['print', launchdServiceTarget] }
          : {
              command: 'systemctl',
              args: ['--user', 'is-active', '--quiet', BOOT_SERVICE_UNIT_FILE],
            },
      )
      .pipe(
        Effect.map((result) => result.code === 0),
        Effect.orElseSucceed(() => false),
      )
    const ownerReady =
      definitionCurrent && active && awaitStorageOwnerReadiness
        ? yield* fs.realPath(input.baseDir).pipe(
            Effect.flatMap((canonicalBaseDir) =>
              readStorageOwner(canonicalBaseDir).pipe(
                Effect.map(
                  (owner) =>
                    Option.isSome(owner) &&
                    owner.value.canonicalBaseDir === canonicalBaseDir &&
                    owner.value.pid !== process.pid,
                ),
              ),
            ),
            Effect.orElseSucceed(() => false),
          )
        : definitionCurrent && active
    // a materialized unit that never reached post-lease activation is repairable.
    const current = definitionCurrent && active && ownerReady
    return { supported: true, installed: true, active, current, unitPath, logPath }
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan('service.boot_service.status'),
  )

  return BootService.of({
    prepareInstall,
    activatePrepared,
    install,
    restart,
    stop,
    uninstall,
    status,
  })
})

export const layer = (input: {
  readonly baseDir: string
  readonly logsDir: string
  readonly cliVersion: string
  readonly host?: BootServiceHost
  readonly awaitStorageOwner?: boolean
}) => Layer.effect(BootService, make(input))
