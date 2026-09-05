// apps/server/src/provider/maintenance/providerMaintenance.ts
// create provider maintenance capabilities

import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from '@t3tools/contracts'
import { compareSemverVersions } from '@t3tools/shared/semver'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import { causeErrorTag } from '@t3tools/shared/observability'
import { resolveCommandPath } from '@t3tools/shared/shell'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { collectUint8StreamText } from '../../stream/collectUint8StreamText.ts'

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000
const LATEST_VERSION_TIMEOUT_MS = 4_000
const HOMEBREW_INFO_TIMEOUT_MS = 10_000
const HOMEBREW_INFO_MAX_BYTES = 256 * 1_024
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = 'Install the update now or review provider settings.'

// ownership is re-derived often enough to bound stale Homebrew metadata
export const MAINTENANCE_CAPABILITIES_CACHE_TTL = Duration.hours(1)

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  )

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string('PATH').pipe(Config.option),
  Path: Config.string('Path').pipe(Config.option),
  path: Config.string('path').pipe(Config.option),
  PATHEXT: Config.string('PATHEXT').pipe(Config.option),
}).pipe(Config.map(compactEnv))

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})))

export interface ProviderMaintenanceCapabilities
{
  readonly provider: ProviderDriverKind
  readonly packageName: string | null
  readonly update: ProviderMaintenanceCommandAction | null
  // undefined uses npm; null means the owning installer did not know
  readonly latestVersion?: string | null
}

export interface ProviderMaintenanceCommandAction
{
  readonly command: string
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly lockKey: string
  // native updaters need the same install-selection env as the provider
  readonly env?: NodeJS.ProcessEnv
}

export interface ProviderMaintenanceResolutionContext
{
  readonly binaryPath: string
  readonly resolvedCommandPath: string
  readonly realCommandPath: string
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
}

export type ProviderMaintenanceResolverServices =
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

export interface ProviderMaintenanceCapabilitiesResolver
{
  readonly resolve: (
    context: ProviderMaintenanceResolutionContext | null,
  ) => Effect.Effect<ProviderMaintenanceCapabilities, never, ProviderMaintenanceResolverServices>
}

export interface PackageManagedProviderMaintenanceDefinition
{
  readonly provider: ProviderDriverKind
  readonly npmPackageName: string
  readonly nativeUpdate: {
    readonly args: ReadonlyArray<string>
    readonly isCommandPath: (commandPath: string) => boolean
    readonly env?: NodeJS.ProcessEnv
  } | null
}

export interface ProviderVersionCacheEntry
{
  readonly expiresAt: number
  readonly version: string | null
}

export const ProviderVersionCache = Context.Reference<Map<string, ProviderVersionCacheEntry>>(
  '@t3tools/server/providerMaintenance/ProviderVersionCache',
  {
    defaultValue: () => new Map(),
  },
)
const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
})

function nonEmptyString(value: unknown): string | null
{
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function quoteShellWord(word: string, platform: NodeJS.Platform): string
{
  const safeWord = platform === 'win32' ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/
  if (safeWord.test(word)) return word
  return platform === 'win32'
    ? `'${word.replace(/['\u2018\u2019]/g, '$&$&')}'`
    : `'${word.replaceAll("'", "'\\''")}'`
}

function quoteUpdateExecutable(executable: string, platform: NodeJS.Platform): string
{
  const quoted = quoteShellWord(executable, platform)
  // windows terminals default to PowerShell, where a quoted executable needs &
  return platform === 'win32' && quoted !== executable ? `& ${quoted}` : quoted
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind
  readonly packageName: string | null
  readonly updateExecutable: string | null
  readonly updateArgs: ReadonlyArray<string>
  readonly updateLockKey: string | null
  // use only when the displayed command intentionally uses a bare tool name
  readonly updateCommand?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly latestVersion?: string | null
}): ProviderMaintenanceCapabilities
{
  const platform = input.platform ?? HostProcessPlatform.defaultValue()
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command:
            input.updateCommand ??
            [
              quoteUpdateExecutable(input.updateExecutable, platform),
              ...input.updateArgs.map((arg) => quoteShellWord(arg, platform)),
            ].join(' '),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(input.env ? { env: input.env } : {}),
        }
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...('latestVersion' in input ? { latestVersion: input.latestVersion } : {}),
  }
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind
  readonly packageName: string | null
}): ProviderMaintenanceCapabilities
{
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  })
}

export function normalizeCommandPath(commandPath: string): string
{
  return commandPath.replaceAll('\\', '/').toLowerCase()
}

function normalizeOwnershipPrefix(prefix: string, platform: NodeJS.Platform): string
{
  const normalized = prefix.replaceAll('\\', '/').replace(/\/+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isBunGlobalCommandPath(commandPath: string): boolean
{
  return normalizeCommandPath(commandPath).includes('/.bun/bin/')
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean
{
  return normalizeCommandPath(commandPath).includes('/.vite-plus/bin/')
}

function isPnpmGlobalCommandPath(commandPath: string): boolean
{
  const normalized = normalizeCommandPath(commandPath)
  return (
    normalized.includes('/.local/share/pnpm/') ||
    normalized.includes('/library/pnpm/') ||
    normalized.includes('/local/share/pnpm/') ||
    normalized.includes('/appdata/local/pnpm/') ||
    normalized.includes('/pnpm/global/')
  )
}

export function npmGlobalPrefixFromCommandPath(
  realCommandPath: string,
  packageName: string,
  platform: NodeJS.Platform = HostProcessPlatform.defaultValue(),
): string | null
{
  const slashPath = realCommandPath.replaceAll('\\', '/')
  const ownershipPath = platform === 'win32' ? slashPath.toLowerCase() : slashPath
  const ownershipPackageName = platform === 'win32' ? packageName.toLowerCase() : packageName
  const packageSegment = `/lib/node_modules/${ownershipPackageName}/`
  const packageIndex = ownershipPath.lastIndexOf(packageSegment)
  if (packageIndex < 0 || ownershipPath.slice(0, packageIndex).includes('/node_modules/'))
  {
    return null
  }
  // mise's npm backend mimics a global layout inside the tool version
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(
    ownershipPath.slice(0, packageIndex),
  )?.[1]
  if (miseTool && miseTool !== 'node')
  {
    return null
  }
  return packageIndex === 0 ? '/' : slashPath.slice(0, packageIndex)
}

// <prefix>/Cellar/<name>/<version>/... or <prefix>/Caskroom/<name>/<version>/...
const HOMEBREW_KEG_PATTERN = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i

export interface HomebrewOwnership
{
  readonly kind: 'formula' | 'cask'
  readonly name: string
  readonly prefix: string
}

export function homebrewOwnershipFromCommandPath(
  realCommandPath: string,
): HomebrewOwnership | null
{
  const match = HOMEBREW_KEG_PATTERN.exec(realCommandPath.replaceAll('\\', '/'))
  if (!match)
  {
    return null
  }
  return {
    kind: match[2]!.toLowerCase() === 'cellar' ? 'formula' : 'cask',
    name: match[3]!,
    prefix: match[1]!,
  }
}

const HomebrewInfoResponse = Schema.Struct({
  formulae: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        versions: Schema.optional(Schema.Struct({ stable: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  casks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        token: Schema.optional(Schema.String),
        version: Schema.optional(Schema.String),
      }),
    ),
  ),
})

const decodeHomebrewInfo = Schema.decodeUnknownOption(Schema.fromJsonString(HomebrewInfoResponse))

export function parseHomebrewLatestVersion(
  infoJson: string,
  ownership: HomebrewOwnership,
): string | null
{
  const decoded = decodeHomebrewInfo(infoJson)
  if (Option.isNone(decoded))
  {
    return null
  }
  const raw =
    ownership.kind === 'formula'
      ? decoded.value.formulae?.[0]?.versions?.stable
      : decoded.value.casks?.[0]?.version?.split(',', 1)[0]
  return nonEmptyString(raw)
}

function homebrewInfoMatchesOwnership(infoJson: string, ownership: HomebrewOwnership): boolean
{
  const decoded = decodeHomebrewInfo(infoJson)
  if (Option.isNone(decoded))
  {
    return false
  }
  const name =
    ownership.kind === 'formula'
      ? decoded.value.formulae?.[0]?.name
      : decoded.value.casks?.[0]?.token
  return name === ownership.name
}

const runHomebrew = Effect.fn('runHomebrew')(function* (
  brewPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
)
{
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const collect = Effect.gen(function* ()
  {
    const child = yield* spawner.spawn(ChildProcess.make(brewPath, args, { env, extendEnv: true }))
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore))
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: HOMEBREW_INFO_MAX_BYTES }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: 'unbounded' },
    )
    return Number(exitCode) !== 0 || stdout.truncated ? null : stdout.text
  })
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(HOMEBREW_INFO_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) =>
      Effect.logWarning('Homebrew probe failed', {
        subcommand: args[0],
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  )
})

export const resolvePackageManagedProviderMaintenance = Effect.fn(
  'resolvePackageManagedProviderMaintenance',
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: ProviderMaintenanceResolutionContext | null,
)
{
  const manual = makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  })
  if (!context)
  {
    return manual
  }
  const commandPaths = [context.resolvedCommandPath, context.realCommandPath]
  const packageName = definition.npmPackageName

  const nativeUpdate = definition.nativeUpdate
  if (nativeUpdate && commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath)))
  {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: nativeUpdate.args,
      updateLockKey: `${definition.provider}-native`,
      platform: context.platform,
      env: { ...context.env, ...nativeUpdate.env },
    })
  }
  if (commandPaths.some(isVitePlusGlobalCommandPath))
  {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: 'vp',
      updateArgs: ['i', '-g', packageName],
      updateLockKey: 'vite-plus-global',
      env: context.env,
    })
  }
  if (commandPaths.some(isBunGlobalCommandPath))
  {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: 'bun',
      updateArgs: ['i', '-g', `${packageName}@latest`],
      updateLockKey: 'bun-global',
      env: context.env,
    })
  }
  if (commandPaths.some(isPnpmGlobalCommandPath))
  {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: 'pnpm',
      updateArgs: ['add', '-g', `${packageName}@latest`],
      updateLockKey: 'pnpm-global',
      env: context.env,
    })
  }

  const npmPrefix = yield* resolveNpmGlobalPrefix(context, packageName)
  if (npmPrefix)
  {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: 'npm',
      // npm 12 blocks install scripts while still exiting successfully
      updateArgs: [
        'install',
        '-g',
        '--prefix',
        npmPrefix,
        `--allow-scripts=${packageName}`,
        `${packageName}@latest`,
      ],
      updateLockKey: `npm-global:${normalizeCommandPath(npmPrefix)}`,
      env: context.env,
    })
  }

  const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath)
  if (homebrew)
  {
    const brewPath = yield* resolveCommandPath('brew', { env: context.env }).pipe(
      Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
    )
    if (!brewPath)
    {
      return manual
    }
    const fileSystem = yield* FileSystem.FileSystem
    const brewPrefix = nonEmptyString(yield* runHomebrew(brewPath, ['--prefix'], context.env))
    const realBrewPrefix = brewPrefix
      ? yield* fileSystem.realPath(brewPrefix).pipe(Effect.orElseSucceed(() => brewPrefix))
      : null
    if (
      !realBrewPrefix ||
      normalizeOwnershipPrefix(realBrewPrefix, context.platform) !==
        normalizeOwnershipPrefix(homebrew.prefix, context.platform)
    )
    {
      return manual
    }
    const args =
      homebrew.kind === 'cask' ? ['upgrade', '--cask', homebrew.name] : ['upgrade', homebrew.name]
    const info = yield* runHomebrew(brewPath, ['info', '--json=v2', homebrew.name], context.env)
    if (!info || !homebrewInfoMatchesOwnership(info, homebrew))
    {
      return manual
    }
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: brewPath,
      updateArgs: args,
      updateLockKey: 'homebrew',
      updateCommand: [
        quoteUpdateExecutable('brew', context.platform),
        ...args.map((arg) => quoteShellWord(arg, context.platform)),
      ].join(' '),
      env: context.env,
      latestVersion: parseHomebrewLatestVersion(info, homebrew),
    })
  }

  return manual
})

const resolveNpmGlobalPrefix = Effect.fn('resolveNpmGlobalPrefix')(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
)
{
  const fromRealPath = npmGlobalPrefixFromCommandPath(
    context.realCommandPath,
    packageName,
    context.platform,
  )
  if (fromRealPath)
  {
    return fromRealPath
  }
  if ((yield* HostProcessPlatform) !== 'win32')
  {
    return null
  }
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const shimDir = path.dirname(context.resolvedCommandPath)
  const manifestPath = path.join(shimDir, 'node_modules', ...packageName.split('/'), 'package.json')
  const hasManifest = yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false))
  return hasManifest ? shimDir : null
})

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver
{
  return {
    resolve: (context) => resolvePackageManagedProviderMaintenance(definition, context),
  }
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities
{
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  })
}

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  'resolveProviderMaintenanceCapabilitiesEffect',
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: {
    readonly binaryPath?: string | null
    readonly env?: NodeJS.ProcessEnv
  },
)
{
  const binaryPath = nonEmptyString(options?.binaryPath)
  if (!binaryPath)
  {
    return yield* resolver.resolve(null)
  }

  const env = options?.env ?? (yield* readCommandLookupEnv)
  const resolvedCommandPath = yield* resolveCommandPath(binaryPath, { env }).pipe(
    Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
  )
  if (!resolvedCommandPath)
  {
    return yield* resolver.resolve(null)
  }

  const fileSystem = yield* FileSystem.FileSystem
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => null))
  if (!realCommandPath)
  {
    return yield* resolver.resolve(null)
  }
  return yield* resolver.resolve({
    binaryPath,
    env,
    resolvedCommandPath,
    realCommandPath,
    platform: yield* HostProcessPlatform,
  })
})

export const makeCachedProviderMaintenanceResolution = Effect.fn(
  'makeCachedProviderMaintenanceResolution',
)(function* (resolve: Effect.Effect<ProviderMaintenanceCapabilities>)
{
  const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    resolve,
    MAINTENANCE_CAPABILITIES_CACHE_TTL,
  )
  return (options?: { readonly fresh?: boolean }) =>
    options?.fresh ? invalidate.pipe(Effect.andThen(cached)) : cached
})

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null
  readonly latestVersion: string | null
}): Pick<ServerProviderVersionAdvisory, 'status' | 'message'>
{
  if (!input.currentVersion)
  {
    return { status: 'unknown', message: null }
  }
  if (!input.latestVersion)
  {
    return { status: 'unknown', message: null }
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0)
  {
    return {
      status: 'behind_latest',
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    }
  }
  return { status: 'current', message: null }
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind
  readonly currentVersion: string | null
  readonly latestVersion?: string | null
  readonly checkedAt?: string | null
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities
}): ServerProviderVersionAdvisory
{
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver)
  const latestVersion = input.latestVersion ?? null
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  })

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  }
}

const fetchNpmLatestVersion = Effect.fn('fetchNpmLatestVersion')(function* (packageName: string)
{
  const client = yield* HttpClient.HttpClient
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader('accept', 'application/json'))
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  )
  if (Option.isNone(response))
  {
    return null
  }
  const httpResponse = response.value
  if (httpResponse.status < 200 || httpResponse.status >= 300)
  {
    return null
  }
  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.orElseSucceed(() => null),
  )
  return payload ? nonEmptyString(payload.version) : null
})

export const resolveLatestProviderVersion = Effect.fn('resolveLatestProviderVersion')(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
)
{
  if (maintenanceCapabilities.latestVersion !== undefined)
  {
    return maintenanceCapabilities.latestVersion
  }
  const packageName = maintenanceCapabilities.packageName
  if (!packageName)
  {
    return null
  }

  const latestVersionCache = yield* ProviderVersionCache
  const cached = latestVersionCache.get(packageName)
  const now = DateTime.toEpochMillis(yield* DateTime.now)
  if (cached && cached.expiresAt > now)
  {
    return cached.version
  }

  const version = yield* fetchNpmLatestVersion(packageName)
  latestVersionCache.set(packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  })
  return version
})

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  'enrichProviderSnapshotWithVersionAdvisory',
)(function* (
  snapshot: ServerProvider,
  maintenanceCapabilities?: ProviderMaintenanceCapabilities,
  options?: {
    readonly enableProviderUpdateChecks: boolean | undefined
  },
)
{
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver)
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(snapshot.version)
  if (!shouldResolveLatestVersion)
  {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    }
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities)
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  }
})
