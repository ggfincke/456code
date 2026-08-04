// apps/server/src/import/sourceCatalog.ts
// resolves configured transcript roots and validates client-selected source files
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  defaultInstanceIdForDriver,
  GrokSettings,
  OpenCodeSettings,
  type ProviderContinuationIdentity,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ServerSettings,
} from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { buildCursorAcpSpawnInput } from '../provider/acp/CursorAcpSupport.ts'
import { buildGrokAcpSpawnInput } from '../provider/acp/GrokAcpSupport.ts'
import {
  acpContinuationEnvironment,
  acpContinuationRouteIssue,
  fileContinuationIdentity,
  normalizeAcpRuntimeEnvironment,
  resolveAcpContinuationIdentity,
  resolveClaudeProjectsRoot,
  resolveCodexSessionsRoot,
  resolveOpenCodeSessionsRoot,
} from '../provider/continuationIdentity.ts'
import { mergeProviderInstanceEnvironment } from '../provider/ProviderInstanceEnvironment.ts'
import type { AcpImportConnectionOptions } from './acpImport.ts'
import { loadCodexSessionTitles } from './importTitle.ts'
import {
  type BoundedUtf8File,
  type ImportByteBudget,
  importFileSystemIdentity,
  type ImportResourceLimitError,
  type ImportSourceValidation,
  type ImportValidatedRoot,
  IMPORT_SESSION_MAX_BYTES,
  readBoundedUtf8File,
} from './resourceLimits.ts'
import type { ImportSource } from './types.ts'

const CODEX_DRIVER = ProviderDriverKind.make('codex')
const CLAUDE_DRIVER = ProviderDriverKind.make('claudeAgent')
const CURSOR_DRIVER = ProviderDriverKind.make('cursor')
const GROK_DRIVER = ProviderDriverKind.make('grok')
const OPENCODE_DRIVER = ProviderDriverKind.make('opencode')
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings)
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings)
const decodeCursorSettings = Schema.decodeUnknownEffect(CursorSettings)
const decodeGrokSettings = Schema.decodeUnknownEffect(GrokSettings)
const decodeOpenCodeSettings = Schema.decodeUnknownEffect(OpenCodeSettings)

export interface ImportScanRootOverrides
{
  readonly homePath?: string
  readonly codexHome?: string
  readonly claudeHome?: string
}

export interface ImportScanRoots
{
  readonly codexSessions: string
  readonly codexArchivedSessions: string
  readonly claudeProjects: string
}

export type ImportFileSource = Exclude<ImportSource, 'cursor' | 'grok'>
export type ImportFileSourceLayout = 'codex-archive'

export interface ImportFileSourceDescriptor
{
  readonly source: ImportFileSource
  readonly driverKind: ProviderDriverKind
  readonly providerInstanceId: ProviderInstanceId
  readonly scanRoot: string
  readonly codexSessionTitles?: ReadonlyMap<string, string>
  readonly layout?: ImportFileSourceLayout
  readonly continuationIdentity: ProviderContinuationIdentity
  readonly displayName?: string
}

export interface ImportFileSourceDescriptorGroup
{
  readonly source: ImportFileSource
  readonly driverKind: ProviderDriverKind
  readonly scanRoot: string
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>
  readonly layout?: ImportFileSourceLayout
}

export interface SourceCatalogOptions
{
  readonly environment?: NodeJS.ProcessEnv
  readonly homePath?: string
  readonly cwd?: string
  readonly rootResolutionTimeoutMs?: number
  readonly resolveRealPath?: (path: string, signal: AbortSignal) => Promise<string>
}

export interface SourceCatalogIssue
{
  readonly sourcePath: string | null
  readonly message: string
}

export interface SourceCatalogResult
{
  readonly descriptors: ReadonlyArray<ImportFileSourceDescriptor>
  readonly errors: ReadonlyArray<SourceCatalogIssue>
}

export interface AcpImportSourceDescriptor
{
  readonly source: 'cursor' | 'grok'
  readonly driverKind: ProviderDriverKind
  readonly providerInstanceId: ProviderInstanceId
  readonly displayName?: string
  readonly continuationIdentity: ProviderContinuationIdentity
  readonly connection: AcpImportConnectionOptions
}

export interface AcpImportSourceCatalogResult
{
  readonly descriptors: ReadonlyArray<AcpImportSourceDescriptor>
  readonly errors: ReadonlyArray<SourceCatalogIssue>
}

export interface ResolvedImportSourcePath
{
  readonly canonicalPath: string
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>
  readonly layout?: ImportFileSourceLayout
  readonly validation: ImportSourceValidation
}

export interface LoadedImportSourceFile extends BoundedUtf8File
{
  readonly canonicalPath: string
  readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>
}

export class ImportSourcePathResolutionError extends Schema.TaggedErrorClass<ImportSourcePathResolutionError>()(
  'ImportSourcePathResolutionError',
  {
    sourcePath: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Cannot use import source '${this.sourcePath}': ${this.reason}`
  }
}

class SourceCatalogRootResolutionError extends Schema.TaggedErrorClass<SourceCatalogRootResolutionError>()(
  'SourceCatalogRootResolutionError',
  {
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
)
{}

interface ConfiguredSource
{
  readonly providerInstanceId: ProviderInstanceId
  readonly driverKind: ProviderDriverKind
  readonly displayName?: string
  readonly environment?: ProviderInstanceEnvironment
  readonly enabled?: boolean
  readonly config: unknown
}

function errorMessage(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

function isMissingPathError(error: unknown): boolean
{
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function expandHome(value: string, homePath: string): string
{
  if (value === '~') return homePath
  if (value.startsWith('~/') || value.startsWith('~\\'))
  {
    return NodePath.join(homePath, value.slice(2))
  }
  return value
}

function resolveEnvironmentPath(value: string, cwd: string): string
{
  return NodePath.resolve(cwd, value)
}

function environmentForInstance(
  baseEnvironment: NodeJS.ProcessEnv,
  environment: ProviderInstanceEnvironment | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv
{
  return mergeProviderInstanceEnvironment(environment, baseEnvironment, platform)
}

function nonEmptyEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | null
{
  const value = environment[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

function fallbackHomePath(environment: NodeJS.ProcessEnv, cwd: string): string
{
  const configuredHome = nonEmptyEnvironmentValue(environment, 'HOME')
  return resolveEnvironmentPath(configuredHome ?? NodeOS.homedir(), cwd)
}

function configuredSources(settings: ServerSettings): ReadonlyArray<ConfiguredSource>
{
  const sources: ConfiguredSource[] = []
  for (const [rawInstanceId, instance] of Object.entries(settings.providerInstances))
  {
    if (
      instance.driver !== CODEX_DRIVER &&
      instance.driver !== CLAUDE_DRIVER &&
      instance.driver !== CURSOR_DRIVER &&
      instance.driver !== GROK_DRIVER &&
      instance.driver !== OPENCODE_DRIVER
    )
    {
      continue
    }
    sources.push({
      providerInstanceId: rawInstanceId as ProviderInstanceId,
      driverKind: instance.driver,
      ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
      ...(instance.environment === undefined ? {} : { environment: instance.environment }),
      ...(instance.enabled === undefined ? {} : { enabled: instance.enabled }),
      config: instance.config ?? {},
    })
  }

  const legacySources = [
    {
      providerInstanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
      driverKind: CODEX_DRIVER,
      config: settings.providers.codex,
    },
    {
      providerInstanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
      driverKind: CLAUDE_DRIVER,
      config: settings.providers.claudeAgent,
    },
    {
      providerInstanceId: defaultInstanceIdForDriver(CURSOR_DRIVER),
      driverKind: CURSOR_DRIVER,
      config: settings.providers.cursor,
    },
    {
      providerInstanceId: defaultInstanceIdForDriver(GROK_DRIVER),
      driverKind: GROK_DRIVER,
      config: settings.providers.grok,
    },
    {
      providerInstanceId: defaultInstanceIdForDriver(OPENCODE_DRIVER),
      driverKind: OPENCODE_DRIVER,
      config: settings.providers.opencode,
    },
  ] as const
  for (const source of legacySources)
  {
    if (source.providerInstanceId in settings.providerInstances)
    {
      continue
    }
    sources.push(source)
  }
  return sources
}

function decodeConfiguredSource(source: ConfiguredSource)
{
  if (source.driverKind === CODEX_DRIVER)
  {
    return decodeCodexSettings(source.config)
  }
  if (source.driverKind === CLAUDE_DRIVER)
  {
    return decodeClaudeSettings(source.config)
  }
  if (source.driverKind === CURSOR_DRIVER)
  {
    return decodeCursorSettings(source.config)
  }
  if (source.driverKind === GROK_DRIVER)
  {
    return decodeGrokSettings(source.config)
  }
  return decodeOpenCodeSettings(source.config)
}

const canonicalizeScanRoot = Effect.fn('SourceCatalog.canonicalizeScanRoot')(function* (
  scanRoot: string,
  resolveRealPath: SourceCatalogOptions['resolveRealPath'],
): Effect.fn.Return<
  { readonly scanRoot: string; readonly error: SourceCatalogIssue | null },
  never
>
{
  const normalizedRoot = NodePath.resolve(scanRoot)
  return yield* Effect.tryPromise({
    try: (signal) =>
      resolveRealPath === undefined
        ? NodeFSP.realpath(normalizedRoot)
        : resolveRealPath(normalizedRoot, signal),
    catch: (cause) =>
      new SourceCatalogRootResolutionError({
        sourcePath: normalizedRoot,
        cause,
      }),
  }).pipe(
    Effect.map((canonicalRoot) => ({ scanRoot: canonicalRoot, error: null })),
    Effect.catch((error) =>
      Effect.succeed(
        isMissingPathError(error.cause)
          ? { scanRoot: normalizedRoot, error: null }
          : {
              scanRoot: normalizedRoot,
              error: {
                sourcePath: normalizedRoot,
                message: `failed to resolve import root: ${errorMessage(error.cause)}`,
              },
            },
      ),
    ),
  )
})

const canonicalizeScanRootWithinLimit = Effect.fn('SourceCatalog.canonicalizeScanRootWithinLimit')(
  function* (
    scanRoot: string,
    options: SourceCatalogOptions,
  ): Effect.fn.Return<
    { readonly scanRoot: string; readonly error: SourceCatalogIssue | null },
    never
  >
  {
    const timeoutMs =
      options.rootResolutionTimeoutMs === undefined ||
      !Number.isFinite(options.rootResolutionTimeoutMs)
        ? 5_000
        : Math.max(0, Math.floor(options.rootResolutionTimeoutMs))
    const completion = yield* canonicalizeScanRoot(scanRoot, options.resolveRealPath).pipe(
      Effect.timeoutOption(timeoutMs),
    )
    if (completion._tag === 'Some')
    {
      return completion.value
    }
    const normalizedRoot = NodePath.resolve(scanRoot)
    return {
      scanRoot: normalizedRoot,
      error: {
        sourcePath: normalizedRoot,
        message: `timed out resolving import root after ${timeoutMs}ms`,
      },
    }
  },
)

function baseEnvironment(options: SourceCatalogOptions): NodeJS.ProcessEnv
{
  const environment = { ...(options.environment ?? process.env) }
  if (options.homePath !== undefined)
  {
    environment.HOME = options.homePath
  }
  return environment
}

const resolveCodexFileDescriptors = Effect.fn('SourceCatalog.resolveCodexFileDescriptors')(
  function* (
    providerInstanceId: ProviderInstanceId,
    displayName: string | undefined,
    primaryScanRoot: string,
    options: SourceCatalogOptions,
    resolveArchiveAfterPrimaryFailure: boolean,
  ): Effect.fn.Return<SourceCatalogResult>
  {
    const archiveRoot = NodePath.join(NodePath.dirname(primaryScanRoot), 'archived_sessions')
    const canonicalRoots = yield* resolveArchiveAfterPrimaryFailure
      ? Effect.all(
          [
            canonicalizeScanRootWithinLimit(primaryScanRoot, options),
            canonicalizeScanRootWithinLimit(archiveRoot, options),
          ],
          { concurrency: 'unbounded' },
        )
      : Effect.gen(function* ()
        {
          const primaryCanonical = yield* canonicalizeScanRootWithinLimit(primaryScanRoot, options)
          if (primaryCanonical.error !== null)
            {
            return [primaryCanonical] as const
          }
          const archiveCanonical = yield* canonicalizeScanRootWithinLimit(archiveRoot, options)
          return [primaryCanonical, archiveCanonical] as const
        })
    const [primaryCanonical, archiveCanonical] = canonicalRoots
    if (archiveCanonical === undefined)
    {
      return {
        descriptors: [],
        errors: primaryCanonical.error === null ? [] : [primaryCanonical.error],
      }
    }

    const codexSessionTitles = yield* loadCodexSessionTitles(
      NodePath.join(NodePath.dirname(primaryScanRoot), 'session_index.jsonl'),
    )
    const continuationIdentity = fileContinuationIdentity(CODEX_DRIVER, primaryCanonical.scanRoot)
    const commonDescriptor: Omit<ImportFileSourceDescriptor, 'scanRoot'> = {
      source: 'codex-cli',
      driverKind: CODEX_DRIVER,
      providerInstanceId,
      continuationIdentity,
      ...(displayName === undefined ? {} : { displayName }),
      ...(codexSessionTitles.size === 0 ? {} : { codexSessionTitles }),
    }
    return {
      descriptors: [
        ...(primaryCanonical.error === null
          ? [{ ...commonDescriptor, scanRoot: primaryCanonical.scanRoot }]
          : []),
        ...(archiveCanonical.error === null
          ? [
              {
                ...commonDescriptor,
                scanRoot: archiveCanonical.scanRoot,
                layout: 'codex-archive' as const,
              },
            ]
          : []),
      ],
      errors: [
        ...(primaryCanonical.error === null ? [] : [primaryCanonical.error]),
        ...(archiveCanonical.error === null ? [] : [archiveCanonical.error]),
      ],
    }
  },
)

const resolveConfiguredFileSource = Effect.fn('SourceCatalog.resolveConfiguredFileSource')(
  function* (
    source: ConfiguredSource,
    environment: NodeJS.ProcessEnv,
    hostHomePath: string,
    cwd: string,
    platform: NodeJS.Platform,
    options: SourceCatalogOptions,
  ): Effect.fn.Return<SourceCatalogResult>
  {
    if (
      source.driverKind !== CODEX_DRIVER &&
      source.driverKind !== CLAUDE_DRIVER &&
      source.driverKind !== OPENCODE_DRIVER
    )
    {
      return { descriptors: [], errors: [] }
    }
    const instanceEnvironment = normalizeAcpRuntimeEnvironment(
      environmentForInstance(environment, source.environment, platform),
      cwd,
      platform,
    )
    const decodedConfig = yield* decodeConfiguredSource(source).pipe(Effect.result)
    if (decodedConfig._tag === 'Failure')
    {
      return {
        descriptors: [],
        errors: [
          {
            sourcePath: null,
            message: `invalid config for provider instance '${source.providerInstanceId}': ${errorMessage(decodedConfig.failure)}`,
          },
        ],
      }
    }
    const decoded = decodedConfig.success as CodexSettings | ClaudeSettings | OpenCodeSettings
    if ((source.enabled ?? decoded.enabled ?? true) === false)
    {
      return { descriptors: [], errors: [] }
    }
    if (
      source.driverKind === OPENCODE_DRIVER &&
      (decoded as OpenCodeSettings).serverUrl.trim().length > 0
    )
    {
      return {
        descriptors: [],
        errors: [
          {
            sourcePath: null,
            message: `OpenCode import is unavailable for provider instance '${source.providerInstanceId}' because an external server URL does not prove ownership of local transcript storage`,
          },
        ],
      }
    }

    const rootOptions = {
      environment: instanceEnvironment,
      homePath: hostHomePath,
      cwd,
    }
    const primaryScanRoot =
      source.driverKind === CODEX_DRIVER
        ? resolveCodexSessionsRoot(decodedConfig.success as CodexSettings, rootOptions)
        : source.driverKind === CLAUDE_DRIVER
          ? resolveClaudeProjectsRoot(decodedConfig.success as ClaudeSettings, rootOptions)
          : resolveOpenCodeSessionsRoot(rootOptions)
    if (source.driverKind === CODEX_DRIVER)
    {
      // configured sources stop before resolving the archive when the primary root fails
      return yield* resolveCodexFileDescriptors(
        source.providerInstanceId,
        source.displayName,
        primaryScanRoot,
        options,
        false,
      )
    }

    const primaryCanonical = yield* canonicalizeScanRootWithinLimit(primaryScanRoot, options)
    if (primaryCanonical.error !== null)
    {
      return { descriptors: [], errors: [primaryCanonical.error] }
    }
    const sourceName = source.driverKind === CLAUDE_DRIVER ? 'claude-code' : 'opencode'
    const continuationIdentity = fileContinuationIdentity(
      source.driverKind,
      primaryCanonical.scanRoot,
    )
    const primaryDescriptor: ImportFileSourceDescriptor = {
      source: sourceName,
      driverKind: source.driverKind,
      providerInstanceId: source.providerInstanceId,
      scanRoot: primaryCanonical.scanRoot,
      continuationIdentity,
      ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
    }
    return { descriptors: [primaryDescriptor], errors: [] }
  },
)

export const resolveSourceCatalog = Effect.fn('resolveSourceCatalog')(function* (
  settings: ServerSettings,
  options: SourceCatalogOptions = {},
): Effect.fn.Return<SourceCatalogResult>
{
  const descriptors: ImportFileSourceDescriptor[] = []
  const errors: SourceCatalogIssue[] = []
  const platform = yield* HostProcessPlatform
  const pathApi = platform === 'win32' ? NodePath.win32 : NodePath.posix
  const environment = baseEnvironment(options)
  const cwd = pathApi.resolve(options.cwd ?? process.cwd())
  const hostHomePath = fallbackHomePath(environment, cwd)

  const sourceResults = yield* Effect.forEach(
    configuredSources(settings),
    (source) =>
      resolveConfiguredFileSource(source, environment, hostHomePath, cwd, platform, options),
    { concurrency: 'unbounded' },
  )
  for (const sourceResult of sourceResults)
  {
    descriptors.push(...sourceResult.descriptors)
    errors.push(...sourceResult.errors)
  }

  const uniqueDescriptors = new Map<string, ImportFileSourceDescriptor>()
  for (const descriptor of descriptors)
  {
    uniqueDescriptors.set(
      `${descriptor.source}\0${descriptor.scanRoot}\0${descriptor.providerInstanceId}`,
      descriptor,
    )
  }
  return {
    descriptors: [...uniqueDescriptors.values()],
    errors,
  }
})

export const resolveAcpImportSourceCatalog = Effect.fn('resolveAcpImportSourceCatalog')(function* (
  settings: ServerSettings,
  options: SourceCatalogOptions = {},
): Effect.fn.Return<AcpImportSourceCatalogResult>
{
  const descriptors: AcpImportSourceDescriptor[] = []
  const errors: SourceCatalogIssue[] = []
  const platform = yield* HostProcessPlatform
  const pathApi = platform === 'win32' ? NodePath.win32 : NodePath.posix
  const environment = baseEnvironment(options)
  const cwd = pathApi.resolve(options.cwd ?? process.cwd())

  for (const source of configuredSources(settings))
  {
    if (source.driverKind !== CURSOR_DRIVER && source.driverKind !== GROK_DRIVER)
    {
      continue
    }
    const decodedConfig = yield* decodeConfiguredSource(source).pipe(Effect.result)
    if (decodedConfig._tag === 'Failure')
    {
      errors.push({
        sourcePath: null,
        message: `invalid config for provider instance '${source.providerInstanceId}': ${errorMessage(decodedConfig.failure)}`,
      })
      continue
    }
    const config = decodedConfig.success as CursorSettings | GrokSettings
    if ((source.enabled ?? config.enabled ?? true) === false)
    {
      continue
    }
    const instanceEnvironment = normalizeAcpRuntimeEnvironment(
      environmentForInstance(environment, source.environment, platform),
      cwd,
      platform,
    )
    const connection: AcpImportConnectionOptions =
      source.driverKind === CURSOR_DRIVER
        ? {
            driverKind: 'cursor',
            providerInstanceId: source.providerInstanceId,
            cwd,
            binaryPath: (config as CursorSettings).binaryPath,
            apiEndpoint: (config as CursorSettings).apiEndpoint,
            environment: instanceEnvironment,
          }
        : {
            driverKind: 'grok',
            providerInstanceId: source.providerInstanceId,
            cwd,
            binaryPath: (config as GrokSettings).binaryPath,
            environment: instanceEnvironment,
          }
    const spawnRoute =
      source.driverKind === CURSOR_DRIVER
        ? buildCursorAcpSpawnInput(config as CursorSettings, cwd, instanceEnvironment)
        : buildGrokAcpSpawnInput(config as GrokSettings, cwd, instanceEnvironment)
    const continuationRoute = {
      command: spawnRoute.command,
      args: spawnRoute.args,
      env: normalizeAcpRuntimeEnvironment(
        acpContinuationEnvironment(source.driverKind, spawnRoute.env ?? {}, source.environment),
        cwd,
        platform,
      ),
    } as const
    const continuationRouteIssue = acpContinuationRouteIssue(continuationRoute, platform)
    if (continuationRouteIssue !== null)
    {
      errors.push({
        sourcePath: null,
        message: `ACP import is unavailable for provider instance '${source.providerInstanceId}' because ${continuationRouteIssue}`,
      })
      continue
    }
    descriptors.push({
      source: source.driverKind === CURSOR_DRIVER ? 'cursor' : 'grok',
      driverKind: source.driverKind,
      providerInstanceId: source.providerInstanceId,
      ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
      continuationIdentity: yield* resolveAcpContinuationIdentity(
        source.driverKind,
        continuationRoute,
      ),
      connection,
    })
  }

  return { descriptors, errors }
})

export function groupImportFileSourceDescriptors(
  descriptors: ReadonlyArray<ImportFileSourceDescriptor>,
): ReadonlyArray<ImportFileSourceDescriptorGroup>
{
  const groups = new Map<
    string,
    {
      source: ImportFileSource
      driverKind: ProviderDriverKind
      scanRoot: string
      providerInstanceIds: ProviderInstanceId[]
      layout?: ImportFileSourceLayout
    }
  >()
  for (const descriptor of descriptors)
  {
    const key = `${descriptor.source}\0${descriptor.scanRoot}\0${descriptor.layout ?? ''}`
    const group = groups.get(key)
    if (group === undefined)
    {
      groups.set(key, {
        source: descriptor.source,
        driverKind: descriptor.driverKind,
        scanRoot: descriptor.scanRoot,
        providerInstanceIds: [descriptor.providerInstanceId],
        ...(descriptor.layout === undefined ? {} : { layout: descriptor.layout }),
      })
      continue
    }
    if (!group.providerInstanceIds.includes(descriptor.providerInstanceId))
    {
      group.providerInstanceIds.push(descriptor.providerInstanceId)
    }
  }
  return [...groups.values()]
}

export function resolveScanRoots(overrides: ImportScanRootOverrides = {}): ImportScanRoots
{
  const homePath = NodePath.resolve(overrides.homePath ?? NodeOS.homedir())
  const codexHome = NodePath.resolve(
    expandHome(overrides.codexHome ?? NodePath.join(homePath, '.codex'), homePath),
  )
  const claudeHome = NodePath.resolve(
    expandHome(overrides.claudeHome ?? NodePath.join(homePath, '.claude'), homePath),
  )
  return {
    codexSessions: NodePath.join(codexHome, 'sessions'),
    codexArchivedSessions: NodePath.join(codexHome, 'archived_sessions'),
    claudeProjects: NodePath.join(claudeHome, 'projects'),
  }
}

export const resolveDefaultSourceCatalog = Effect.fn('resolveDefaultSourceCatalog')(function* (
  overrides: ImportScanRootOverrides = {},
  options: SourceCatalogOptions = {},
): Effect.fn.Return<SourceCatalogResult>
{
  const roots = resolveScanRoots(overrides)
  // default discovery keeps a valid archive when the primary root fails
  const [codexCatalog, claudeCanonical] = yield* Effect.all(
    [
      resolveCodexFileDescriptors(
        defaultInstanceIdForDriver(CODEX_DRIVER),
        undefined,
        roots.codexSessions,
        options,
        true,
      ),
      canonicalizeScanRootWithinLimit(roots.claudeProjects, options),
    ],
    { concurrency: 'unbounded' },
  )
  return {
    descriptors: [
      ...codexCatalog.descriptors,
      ...(claudeCanonical.error === null
        ? [
            {
              source: 'claude-code' as const,
              driverKind: CLAUDE_DRIVER,
              providerInstanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
              scanRoot: claudeCanonical.scanRoot,
              continuationIdentity: fileContinuationIdentity(
                CLAUDE_DRIVER,
                claudeCanonical.scanRoot,
              ),
            },
          ]
        : []),
    ],
    errors: [
      ...codexCatalog.errors,
      ...(claudeCanonical.error === null ? [] : [claudeCanonical.error]),
    ],
  }
})

function isCanonicalDescendant(root: string, candidate: string): boolean
{
  const relative = NodePath.relative(root, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  )
}

export function codexSessionTitleForSource(
  descriptors: ReadonlyArray<ImportFileSourceDescriptor>,
  sourcePath: string,
  nativeSessionId: string | null,
): string | null
{
  if (nativeSessionId === null) return null
  for (const descriptor of descriptors)
  {
    if (
      descriptor.source === 'codex-cli' &&
      descriptor.codexSessionTitles !== undefined &&
      isCanonicalDescendant(descriptor.scanRoot, sourcePath)
    )
    {
      const title = descriptor.codexSessionTitles.get(nativeSessionId)
      if (title !== undefined) return title
    }
  }
  return null
}

const claudeSessionFileNamePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i

function hasRecognizedFileLayout(
  descriptor: ImportFileSourceDescriptor,
  canonicalRoot: string,
  canonicalPath: string,
): boolean
{
  const relativePath = NodePath.relative(canonicalRoot, canonicalPath)
  const segments = relativePath.split(NodePath.sep)
  const fileName = segments.at(-1) ?? ''
  if (descriptor.source === 'codex-cli')
  {
    if (descriptor.layout === 'codex-archive')
    {
      return segments.length === 1 && /^rollout-.*\.jsonl$/.test(fileName)
    }
    return (
      segments.length === 4 &&
      /^\d{4}$/.test(segments[0] ?? '') &&
      /^\d{2}$/.test(segments[1] ?? '') &&
      /^\d{2}$/.test(segments[2] ?? '') &&
      /^rollout-.*\.jsonl$/.test(fileName)
    )
  }
  if (descriptor.source === 'claude-code')
  {
    return segments.length === 2 && claudeSessionFileNamePattern.test(fileName)
  }
  return (
    segments.length === 2 && segments[0]!.length > 0 && /^ses_[a-zA-Z0-9_-]+\.json$/.test(fileName)
  )
}

export const resolveImportSourcePath = Effect.fn('resolveImportSourcePath')(function* (
  descriptors: ReadonlyArray<ImportFileSourceDescriptor>,
  source: ImportSource,
  sourcePath: string,
): Effect.fn.Return<ResolvedImportSourcePath, ImportSourcePathResolutionError>
{
  const canonicalPath = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(NodePath.resolve(sourcePath)),
    catch: (cause) =>
      new ImportSourcePathResolutionError({
        sourcePath,
        reason: 'the file does not exist or cannot be resolved',
        cause,
      }),
  })
  const fileStat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(canonicalPath, { bigint: true }),
    catch: (cause) =>
      new ImportSourcePathResolutionError({
        sourcePath,
        reason: 'the resolved path cannot be inspected',
        cause,
      }),
  })
  if (!fileStat.isFile())
  {
    return yield* new ImportSourcePathResolutionError({
      sourcePath,
      reason: 'the resolved path is not a regular file',
    })
  }
  yield* Effect.tryPromise({
    try: async () =>
    {
      const [revalidatedPath, pathStat] = await Promise.all([
        NodeFSP.realpath(canonicalPath),
        NodeFSP.lstat(canonicalPath, { bigint: true }),
      ])
      if (
        revalidatedPath !== canonicalPath ||
        !pathStat.isFile() ||
        pathStat.dev !== fileStat.dev ||
        pathStat.ino !== fileStat.ino
      )
      {
        throw new Error('resolved import file changed while it was being validated')
      }
    },
    catch: (cause) =>
      new ImportSourcePathResolutionError({
        sourcePath,
        reason: 'the resolved file changed while it was being validated',
        cause,
      }),
  })

  const matchingProviderIds: ProviderInstanceId[] = []
  const matchingRoots = new Map<string, ImportValidatedRoot>()
  let matchingLayout: ImportFileSourceLayout | undefined
  let containedByMatchingSource = false
  for (const descriptor of descriptors)
  {
    if (descriptor.source !== source)
    {
      continue
    }
    const canonicalRootResult = yield* Effect.tryPromise({
      try: async () =>
      {
        const canonicalRoot = await NodeFSP.realpath(NodePath.resolve(descriptor.scanRoot))
        const rootStat = await NodeFSP.stat(canonicalRoot, { bigint: true })
        const revalidatedRoot = await NodeFSP.realpath(NodePath.resolve(descriptor.scanRoot))
        if (canonicalRoot !== revalidatedRoot || !rootStat.isDirectory())
        {
          throw new Error('configured import root changed while it was being validated')
        }
        return {
          canonicalRoot,
          validation: {
            canonicalPath: canonicalRoot,
            identity: importFileSystemIdentity(rootStat),
          } satisfies ImportValidatedRoot,
        }
      },
      catch: (cause) =>
        new ImportSourcePathResolutionError({
          sourcePath,
          reason: `configured import root '${descriptor.scanRoot}' cannot be resolved`,
          cause,
        }),
    }).pipe(Effect.result)
    if (canonicalRootResult._tag !== 'Success')
    {
      continue
    }
    if (!isCanonicalDescendant(canonicalRootResult.success.canonicalRoot, canonicalPath))
    {
      continue
    }
    containedByMatchingSource = true
    if (
      !hasRecognizedFileLayout(descriptor, canonicalRootResult.success.canonicalRoot, canonicalPath)
    )
    {
      continue
    }
    if (!matchingProviderIds.includes(descriptor.providerInstanceId))
    {
      matchingProviderIds.push(descriptor.providerInstanceId)
    }
    if (descriptor.layout !== undefined)
    {
      matchingLayout ??= descriptor.layout
    }
    if (!matchingRoots.has(canonicalRootResult.success.canonicalRoot))
    {
      matchingRoots.set(
        canonicalRootResult.success.canonicalRoot,
        canonicalRootResult.success.validation,
      )
    }
  }

  if (matchingProviderIds.length === 0)
  {
    return yield* new ImportSourcePathResolutionError({
      sourcePath,
      reason: containedByMatchingSource
        ? 'the file does not use a recognized session transcript layout'
        : 'the canonical file path is outside every configured import root',
    })
  }
  return {
    canonicalPath,
    providerInstanceIds: matchingProviderIds,
    ...(matchingLayout === undefined ? {} : { layout: matchingLayout }),
    validation: {
      canonicalPath,
      fileIdentity: importFileSystemIdentity(fileStat),
      roots: [...matchingRoots.values()],
    },
  }
})

export const loadBoundedImportSourceFile = Effect.fn('loadBoundedImportSourceFile')(function* (
  descriptors: ReadonlyArray<ImportFileSourceDescriptor>,
  source: Exclude<ImportFileSource, 'opencode'>,
  sourcePath: string,
  aggregateBudget: ImportByteBudget,
): Effect.fn.Return<
  LoadedImportSourceFile,
  ImportSourcePathResolutionError | ImportResourceLimitError
>
{
  const trusted = yield* resolveImportSourcePath(descriptors, source, sourcePath)
  return yield* readResolvedImportSourceFile(trusted, aggregateBudget)
})

export const readResolvedImportSourceFile = Effect.fn('readResolvedImportSourceFile')(function* (
  trusted: ResolvedImportSourcePath,
  aggregateBudget: ImportByteBudget,
): Effect.fn.Return<LoadedImportSourceFile, ImportResourceLimitError>
{
  const loaded = yield* readBoundedUtf8File(
    trusted.canonicalPath,
    IMPORT_SESSION_MAX_BYTES,
    [aggregateBudget],
    trusted.validation,
  )
  return {
    ...loaded,
    canonicalPath: trusted.canonicalPath,
    providerInstanceIds: trusted.providerInstanceIds,
  }
})
