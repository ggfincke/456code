// apps/server/src/import/discovery/discovery.ts
// catalogs importable provider sessions without loading full transcripts

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  IMPORT_METADATA_MAX_CHARS,
  IMPORT_RESULT_MESSAGE_MAX_CHARS,
  IMPORT_SCAN_MAX_CANDIDATES,
  IMPORT_SCAN_MAX_ERRORS,
  IMPORT_SOURCE_PATH_MAX_CHARS,
  IMPORT_TITLE_MAX_CHARS,
  IMPORT_WORKSPACE_ROOT_MAX_CHARS,
  ImportScanCandidate,
  type ImportScanResult,
  type ProjectId,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import type { AcpImportCatalogEntry } from '../parsers/acpImport.ts'
import { parseClaudeSession } from '../parsers/claudeSessionParser.ts'
import {
  codexLegacyHeaderNativeSessionId,
  codexNativeSessionId,
  codexRolloutMetadataOwnerSessionId,
  parseCodexRollout,
} from '../parsers/codexRolloutParser.ts'
import {
  claudeExplicitTitle,
  claudeSemanticTitle,
  codexSemanticTitle,
} from '../continuation/importTitle.ts'
import { truncateText as truncate } from '../parsers/parserSupport.ts'
import {
  discoverOpenCodeSessionMetadataFiles,
  loadOpenCodeSessionFromMetadata,
  readOpenCodeSessionCatalogMetadata,
} from '../parsers/openCodeStorage.ts'
import {
  codexSessionTitleForSource,
  groupImportFileSourceDescriptors,
  type AcpImportSourceDescriptor,
  type ImportFileSource,
  type ImportFileSourceDescriptor,
  type ImportFileSourceDescriptorGroup,
  type ImportScanRootOverrides,
  resolveAcpImportSourceCatalog,
  resolveDefaultSourceCatalog,
  readResolvedImportSourceFile,
  resolveImportSourcePath,
  resolveSourceCatalog,
  type SourceCatalogOptions,
} from './sourceCatalog.ts'
import { isImportedSessionSourceIdentityValid } from './sourceIdentity.ts'
import type { ImportSource, ImportedSessionMeta } from '../types.ts'
import {
  type ImportCountBudget,
  IMPORT_RPC_MAX_BYTES,
  IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES,
  OPENCODE_SESSION_MAX_JSON_FILES,
  makeImportByteBudget,
  makeImportCountBudget,
  readBoundedUtf8FilePrefix,
  takeImportCount,
} from './resourceLimits.ts'

export {
  type ImportScanRootOverrides,
  type ImportScanRoots,
  resolveScanRoots,
} from './sourceCatalog.ts'

const claudeSessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const importCatalogPrefixBytes = 64 * 1024
const importScanTimeoutMs = 60_000
const defaultAcpScanPhaseTimeoutMs = Math.floor(importScanTimeoutMs / 2)
const exactTailCandidateLimit = 256
const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const importScanSemaphore = Semaphore.makeUnsafe(1)

export interface ImportDiscoveryResourceLimits
{
  readonly acpScanPhaseTimeoutMs?: number
  readonly scanTimeoutMs?: number
}

export interface ImportDiscoveryDepsShape
{
  readonly findImportedThread: (lookup: {
    readonly source: ImportSource
    readonly sourcePath: string
    readonly nativeSessionId: string | null
    readonly providerInstanceId: ProviderInstanceId | null
  }) => Effect.Effect<
    {
      readonly threadId: ThreadId
      readonly providerInstanceId: ProviderInstanceId | null
      readonly archived: boolean
    } | null,
    Error
  >
  readonly findProjectByWorkspaceRoot: (
    normalizedRoot: string,
  ) => Effect.Effect<ProjectId | null, Error>
  readonly normalizeWorkspaceRoot: (path: string) => Effect.Effect<string, Error>
  readonly scanAcpSource: (
    descriptor: AcpImportSourceDescriptor,
  ) => Effect.Effect<ReadonlyArray<AcpImportCatalogEntry>, Error>
  readonly resourceLimits?: ImportDiscoveryResourceLimits
}

export class ImportDiscoveryDeps extends Context.Service<
  ImportDiscoveryDeps,
  ImportDiscoveryDepsShape
>()('456code/import/discovery/discovery/ImportDiscoveryDeps')
{}

export class ImportDiscovery extends Context.Service<
  ImportDiscovery,
  {
    readonly scan: {
      (settings: ServerSettings, options?: SourceCatalogOptions): Effect.Effect<ImportScanResult>
      (overrides?: ImportScanRootOverrides): Effect.Effect<ImportScanResult>
    }
  }
>()('456code/import/discovery/discovery/ImportDiscovery')
{}

interface CatalogMetadata
{
  readonly isSubagent: boolean
  readonly nativeSessionId: string | null
  readonly title: string | null
  readonly cwd: string | null
  readonly gitBranch: string | null
  readonly model: string | null
  readonly modifiedAt: string
  readonly resumable: boolean
  readonly warning: string | null
}

interface ImportScanProgress
{
  readonly candidateBuckets: Map<string, ImportScanCandidate[]>
  readonly errors: ImportScanResult['errors'][number][]
  omittedErrorCount: number
  truncated: boolean
}

class ImportDiscoveryOperationError extends Schema.TaggedErrorClass<ImportDiscoveryOperationError>()(
  'ImportDiscoveryOperationError',
  {
    operation: Schema.Literal('discover'),
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `discover failed for '${this.sourcePath}': ${errorMessage(this.cause)}`
  }
}

async function* directoryEntries(
  path: string,
  traversalBudget: ImportCountBudget,
  signal: AbortSignal,
): AsyncGenerator<NodeFS.Dirent>
{
  let directory: NodeFS.Dir | null = null
  try
  {
    signal.throwIfAborted()
    directory = await NodeFSP.opendir(path)
  }
  catch (error)
  {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    {
      return
    }
    throw error
  }
  try
  {
    for await (const entry of directory)
    {
      signal.throwIfAborted()
      if (!takeImportCount(traversalBudget))
      {
        return
      }
      yield entry
    }
  }
  finally
  {
    await directory.close().catch(() => undefined)
  }
}

async function codexCandidates(
  root: string,
  layout: ImportFileSourceDescriptorGroup['layout'],
  traversalBudget: ImportCountBudget,
  signal: AbortSignal,
): Promise<string[]>
{
  const candidates: string[] = []
  if (layout === 'codex-archive')
  {
    for await (const file of directoryEntries(root, traversalBudget, signal))
    {
      if (file.isFile() && /^rollout-.*\.jsonl$/.test(file.name))
      {
        candidates.push(NodePath.join(root, file.name))
      }
    }
    return candidates
  }
  for await (const year of directoryEntries(root, traversalBudget, signal))
  {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name))
    {
      continue
    }
    const yearPath = NodePath.join(root, year.name)
    for await (const month of directoryEntries(yearPath, traversalBudget, signal))
    {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name))
      {
        continue
      }
      const monthPath = NodePath.join(yearPath, month.name)
      for await (const day of directoryEntries(monthPath, traversalBudget, signal))
      {
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name))
        {
          continue
        }
        const dayPath = NodePath.join(monthPath, day.name)
        for await (const file of directoryEntries(dayPath, traversalBudget, signal))
        {
          if (file.isFile() && /^rollout-.*\.jsonl$/.test(file.name))
          {
            candidates.push(NodePath.join(dayPath, file.name))
          }
        }
        if (traversalBudget.truncated) return candidates
      }
      if (traversalBudget.truncated) return candidates
    }
    if (traversalBudget.truncated) return candidates
  }
  return candidates
}

async function claudeCandidates(
  root: string,
  traversalBudget: ImportCountBudget,
  signal: AbortSignal,
): Promise<string[]>
{
  const candidates: string[] = []
  for await (const project of directoryEntries(root, traversalBudget, signal))
  {
    if (!project.isDirectory())
    {
      continue
    }
    const projectPath = NodePath.join(root, project.name)
    for await (const file of directoryEntries(projectPath, traversalBudget, signal))
    {
      if (
        file.isFile() &&
        file.name.endsWith('.jsonl') &&
        claudeSessionIdPattern.test(file.name.slice(0, -'.jsonl'.length))
      )
      {
        candidates.push(NodePath.join(projectPath, file.name))
      }
    }
    if (traversalBudget.truncated) return candidates
  }
  return candidates
}

function errorMessage(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

function boundedPath(value: string | null): string | null
{
  return value === null ? null : truncate(value, IMPORT_SOURCE_PATH_MAX_CHARS)
}

function boundedMetadata(value: string | null, maximumChars: number): string | null
{
  return value === null ? null : truncate(value, maximumChars)
}

function boundedIdentity(value: string | null): string | null
{
  return value !== null && value.length <= IMPORT_METADATA_MAX_CHARS ? value : null
}

function boundedPositiveInteger(
  configured: number | undefined,
  fallback: number,
  maximum: number,
): number
{
  if (configured === undefined || !Number.isFinite(configured))
  {
    return fallback
  }
  return Math.max(1, Math.min(Math.floor(configured), maximum))
}

function fairShares(total: number, participantCount: number): ReadonlyArray<number>
{
  if (participantCount <= 0)
  {
    return []
  }
  const base = Math.floor(total / participantCount)
  const remainder = total % participantCount
  return Array.from({ length: participantCount }, (_, index) => base + (index < remainder ? 1 : 0))
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null
{
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function completeJsonlLines(content: string, truncated: boolean): ReadonlyArray<string>
{
  const lines = content.split(/\r?\n/)
  if (truncated && !content.endsWith('\n'))
  {
    lines.pop()
  }
  return lines
}

function sourceIdentityValid(
  source: ImportSource,
  sourcePath: string,
  nativeSessionId: string | null,
): boolean
{
  return isImportedSessionSourceIdentityValid({
    source,
    sourcePath,
    contentHash: '',
    nativeSessionId,
    cwd: null,
    gitBranch: null,
    model: null,
    title: null,
    firstActivityAt: null,
    lastActivityAt: null,
  } satisfies ImportedSessionMeta)
}

function parseCodexCatalogMetadata(
  sourcePath: string,
  content: string,
  prefixTruncated: boolean,
  modifiedAt: string,
  allowContinuation: boolean,
): CatalogMetadata
{
  let isSubagent = false
  let nativeSessionId: string | null = null
  let metadataOwnerSessionId: string | null = null
  let dialect: 'legacy' | 'modern' | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null
  let model: string | null = null
  let title: string | null = null
  let firstRecordSeen = false
  for (const rawLine of completeJsonlLines(content, prefixTruncated))
  {
    const decoded = decodeUnknownJsonString(rawLine)
    if (Option.isNone(decoded))
    {
      continue
    }
    const parsed = decoded.value
    if (!isRecord(parsed))
    {
      continue
    }
    const type = typeof parsed.type === 'string' ? parsed.type : null
    if (!firstRecordSeen)
    {
      firstRecordSeen = true
      const legacySessionId = codexLegacyHeaderNativeSessionId(parsed, sourcePath)
      if (legacySessionId !== undefined)
      {
        dialect = 'legacy'
        if (legacySessionId === null)
        {
          continue
        }
        const git = isRecord(parsed.git) ? parsed.git : null
        nativeSessionId = legacySessionId
        metadataOwnerSessionId = legacySessionId
        gitBranch = asString(git?.branch)
        continue
      }
      dialect = 'modern'
    }
    if (dialect === 'legacy')
    {
      continue
    }
    const payload = isRecord(parsed.payload) ? parsed.payload : null
    if (type === 'session_meta' && payload !== null)
    {
      const candidateSessionId = codexNativeSessionId(payload.id)
      const git = isRecord(payload.git) ? payload.git : null
      if (candidateSessionId === null)
      {
        continue
      }
      const ownerSessionId = codexRolloutMetadataOwnerSessionId(sourcePath, metadataOwnerSessionId)
      if (ownerSessionId !== null && candidateSessionId !== ownerSessionId)
      {
        continue
      }
      metadataOwnerSessionId ??= candidateSessionId
      isSubagent =
        (isRecord(payload.source) && 'subagent' in payload.source) ||
        asString(payload.thread_source) === 'subagent'
      nativeSessionId = candidateSessionId
      cwd = asString(payload.cwd) ?? cwd
      gitBranch = asString(git?.branch) ?? gitBranch
    }
    else if (type === 'turn_context' && payload !== null)
    {
      cwd = asString(payload.cwd) ?? cwd
      model = asString(payload.model) ?? model
    }
    else if (
      title === null &&
      type === 'event_msg' &&
      payload?.type === 'user_message' &&
      typeof payload.message === 'string'
    )
    {
      title = codexSemanticTitle(payload.message)
    }
  }
  const boundedNativeSessionId = boundedIdentity(nativeSessionId)
  return {
    isSubagent,
    nativeSessionId: boundedNativeSessionId,
    title,
    cwd,
    gitBranch,
    model,
    modifiedAt,
    resumable:
      allowContinuation && sourceIdentityValid('codex-cli', sourcePath, boundedNativeSessionId),
    warning: null,
  }
}

function parseClaudeCatalogMetadata(
  sourcePath: string,
  content: string,
  prefixTruncated: boolean,
  modifiedAt: string,
): CatalogMetadata
{
  const nativeSessionId = NodePath.basename(sourcePath, '.jsonl')
  let cwd: string | null = null
  let gitBranch: string | null = null
  let model: string | null = null
  let title: string | null = null
  let semanticTitle: string | null = null
  let customTitleSeen = false
  let matchingSessionSeen = false
  for (const rawLine of completeJsonlLines(content, prefixTruncated))
  {
    const decoded = decodeUnknownJsonString(rawLine)
    if (Option.isNone(decoded))
    {
      continue
    }
    const parsed = decoded.value
    if (!isRecord(parsed) || parsed.isSidechain === true)
    {
      continue
    }
    const recordSessionId = asString(parsed.sessionId)
    if (recordSessionId !== nativeSessionId)
    {
      continue
    }
    matchingSessionSeen = true
    cwd = asString(parsed.cwd) ?? cwd
    gitBranch = asString(parsed.gitBranch) ?? gitBranch
    const message = isRecord(parsed.message) ? parsed.message : null
    model = asString(message?.model) ?? model
    const type = asString(parsed.type)
    if (type === 'user' && semanticTitle === null)
    {
      semanticTitle = claudeSemanticTitle(parsed.isMeta, message?.content)
    }
    if (type !== 'ai-title' && type !== 'custom-title')
    {
      continue
    }
    const nextTitle = claudeExplicitTitle(
      asString(parsed.aiTitle) ??
        asString(parsed.customTitle) ??
        asString(parsed.title) ??
        asString(parsed.content),
    )
    if (nextTitle === null)
    {
      continue
    }
    if (type === 'custom-title')
    {
      title = nextTitle
      customTitleSeen = true
    }
    else if (!customTitleSeen)
    {
      title = nextTitle
    }
  }
  return {
    isSubagent: false,
    nativeSessionId,
    title: title ?? semanticTitle ?? 'Imported session',
    cwd,
    gitBranch,
    model,
    modifiedAt,
    resumable:
      matchingSessionSeen && sourceIdentityValid('claude-code', sourcePath, nativeSessionId),
    warning: null,
  }
}

function compareCandidates(left: ImportScanCandidate, right: ImportScanCandidate): number
{
  return (
    (right.modifiedAt ?? '').localeCompare(left.modifiedAt ?? '') ||
    left.source.localeCompare(right.source) ||
    left.sourcePath.localeCompare(right.sourcePath)
  )
}

function selectFairCandidates(
  buckets: ReadonlyArray<ReadonlyArray<ImportScanCandidate>>,
): ReadonlyArray<ImportScanCandidate>
{
  const sortedBuckets = buckets
    .filter((bucket) => bucket.length > 0)
    .map((bucket) => bucket.toSorted(compareCandidates))
  const totalCandidates = sortedBuckets.reduce((total, bucket) => total + bucket.length, 0)
  if (totalCandidates <= IMPORT_SCAN_MAX_CANDIDATES)
  {
    return sortedBuckets.flat().toSorted(compareCandidates)
  }

  const shares = fairShares(IMPORT_SCAN_MAX_CANDIDATES, sortedBuckets.length)
  const selected = sortedBuckets.flatMap((bucket, index) => bucket.slice(0, shares[index]))
  const overflow = sortedBuckets
    .flatMap((bucket, index) => bucket.slice(shares[index]))
    .toSorted(compareCandidates)
  return [...selected, ...overflow.slice(0, IMPORT_SCAN_MAX_CANDIDATES - selected.length)].toSorted(
    compareCandidates,
  )
}

export const make = Effect.gen(function* ()
{
  const deps = yield* ImportDiscoveryDeps
  const configuredScanTimeoutMs = boundedPositiveInteger(
    deps.resourceLimits?.scanTimeoutMs,
    importScanTimeoutMs,
    importScanTimeoutMs,
  )
  const configuredAcpScanPhaseTimeoutMs = boundedPositiveInteger(
    deps.resourceLimits?.acpScanPhaseTimeoutMs,
    defaultAcpScanPhaseTimeoutMs,
    configuredScanTimeoutMs,
  )

  const appendScanError = (
    progress: ImportScanProgress,
    issue: ImportScanResult['errors'][number],
  ) =>
  {
    if (progress.errors.length < IMPORT_SCAN_MAX_ERRORS)
    {
      progress.errors.push({
        sourcePath: boundedPath(issue.sourcePath),
        message: truncate(
          issue.message.trim() || 'Unknown import scan error',
          IMPORT_RESULT_MESSAGE_MAX_CHARS,
        ),
      })
      return
    }
    progress.omittedErrorCount += 1
  }

  const appendCandidate = (
    progress: ImportScanProgress,
    bucketKey: string,
    candidate: ImportScanCandidate,
  ) =>
  {
    const bucket = progress.candidateBuckets.get(bucketKey) ?? []
    if (bucket.length >= IMPORT_SCAN_MAX_CANDIDATES)
    {
      progress.truncated = true
      if (!progress.errors.some((error) => error.message.includes('candidate catalog limit')))
      {
        appendScanError(progress, {
          sourcePath: null,
          message: `scan reached the ${IMPORT_SCAN_MAX_CANDIDATES}-session candidate catalog limit`,
        })
      }
      return
    }
    bucket.push(candidate)
    progress.candidateBuckets.set(bucketKey, bucket)
  }

  const snapshotScanProgress = (progress: ImportScanProgress) =>
    DateTime.now.pipe(
      Effect.map((now) =>
      {
        const allBuckets = [...progress.candidateBuckets.values()]
        const totalCandidateCount = allBuckets.reduce((total, bucket) => total + bucket.length, 0)
        const candidateLimited = totalCandidateCount > IMPORT_SCAN_MAX_CANDIDATES
        const errors = [...progress.errors]
        if (progress.omittedErrorCount > 0)
        {
          errors.push({
            sourcePath: null,
            message: `${progress.omittedErrorCount} additional scan errors omitted`,
          })
        }
        if (
          candidateLimited &&
          !errors.some((error) => error.message.includes('candidate catalog limit'))
        )
        {
          errors.push({
            sourcePath: null,
            message: `scan reached the ${IMPORT_SCAN_MAX_CANDIDATES}-session candidate catalog limit`,
          })
        }
        return {
          candidates: selectFairCandidates(allBuckets),
          scannedAt: DateTime.formatIso(now),
          truncated: progress.truncated || candidateLimited,
          errors: errors.slice(0, IMPORT_SCAN_MAX_ERRORS + 1),
        } satisfies ImportScanResult
      }),
    )

  const findImportedThread = Effect.fn('ImportDiscovery.findImportedThread')(function* (input: {
    readonly source: ImportSource
    readonly sourcePath: string
    readonly nativeSessionId: string | null
    readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>
  })
  {
    for (const providerInstanceId of input.providerInstanceIds)
    {
      const match = yield* deps.findImportedThread({
        source: input.source,
        sourcePath: input.sourcePath,
        nativeSessionId: input.nativeSessionId,
        providerInstanceId,
      })
      if (match !== null)
      {
        return match
      }
    }
    return yield* deps.findImportedThread({
      source: input.source,
      sourcePath: input.sourcePath,
      nativeSessionId: input.nativeSessionId,
      providerInstanceId: null,
    })
  })

  const enrichCandidate = Effect.fn('ImportDiscovery.enrichCandidate')(function* (input: {
    readonly source: ImportSource
    readonly sourcePath: string
    readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>
    readonly metadata: CatalogMetadata
  })
  {
    const normalizedCwd =
      input.metadata.cwd === null
        ? null
        : yield* deps.normalizeWorkspaceRoot(input.metadata.cwd).pipe(
            Effect.map((value) => value as string | null),
            Effect.orElseSucceed(() => null),
          )
    const matchedProjectId =
      normalizedCwd === null ? null : yield* deps.findProjectByWorkspaceRoot(normalizedCwd)
    const nativeSessionId = boundedIdentity(input.metadata.nativeSessionId)
    const importedThread = yield* findImportedThread({
      source: input.source,
      sourcePath: input.sourcePath,
      nativeSessionId,
      providerInstanceIds: input.providerInstanceIds,
    })
    return {
      source: input.source,
      sourcePath: input.sourcePath,
      providerInstanceIds: [...input.providerInstanceIds],
      nativeSessionId,
      title: boundedMetadata(input.metadata.title, IMPORT_TITLE_MAX_CHARS),
      cwd: boundedMetadata(input.metadata.cwd, IMPORT_WORKSPACE_ROOT_MAX_CHARS),
      gitBranch: boundedMetadata(input.metadata.gitBranch, IMPORT_METADATA_MAX_CHARS),
      model: boundedMetadata(input.metadata.model, IMPORT_METADATA_MAX_CHARS),
      messageCount: null,
      modifiedAt: input.metadata.modifiedAt,
      alreadyImportedThreadId: importedThread?.threadId ?? null,
      alreadyImportedProviderInstanceId: importedThread?.providerInstanceId ?? null,
      alreadyImportedArchived: importedThread?.archived ?? false,
      matchedProjectId,
      resumable: nativeSessionId !== null && input.metadata.resumable,
    } satisfies ImportScanCandidate
  })

  const describeFileCandidate = Effect.fn('ImportDiscovery.describeFileCandidate')(function* (
    source: ImportFileSource,
    sourcePath: string,
    sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor>,
    layout: ImportFileSourceDescriptorGroup['layout'],
  )
  {
    if (sourcePath.length > IMPORT_SOURCE_PATH_MAX_CHARS)
    {
      return yield* new ImportDiscoveryOperationError({
        operation: 'discover',
        sourcePath,
        cause: `source path exceeds ${IMPORT_SOURCE_PATH_MAX_CHARS} characters`,
      })
    }
    const trustedSource = yield* resolveImportSourcePath(sourceDescriptors, source, sourcePath)
    let metadata: CatalogMetadata
    if (source === 'opencode')
    {
      const openCodeMetadata = yield* readOpenCodeSessionCatalogMetadata(
        trustedSource.canonicalPath,
        trustedSource.validation,
      )
      metadata = {
        isSubagent: openCodeMetadata.isSubagent,
        nativeSessionId: openCodeMetadata.nativeSessionId,
        title: openCodeMetadata.title,
        cwd: openCodeMetadata.cwd,
        gitBranch: null,
        model: null,
        modifiedAt: openCodeMetadata.modifiedAt,
        resumable: openCodeMetadata.resumable,
        warning: openCodeMetadata.warning,
      }
    }
    else
    {
      const prefix = yield* readBoundedUtf8FilePrefix(
        trustedSource.canonicalPath,
        importCatalogPrefixBytes,
        trustedSource.validation,
      )
      const modifiedAt = DateTime.formatIso(DateTime.makeUnsafe(prefix.mtimeMs))
      metadata =
        source === 'codex-cli'
          ? (() =>
            {
              const parsed = parseCodexCatalogMetadata(
                trustedSource.canonicalPath,
                prefix.content,
                prefix.truncated,
                modifiedAt,
                layout !== 'codex-archive',
              )
              return {
                ...parsed,
                title:
                  codexSessionTitleForSource(
                    sourceDescriptors,
                    trustedSource.canonicalPath,
                    parsed.nativeSessionId,
                  ) ?? parsed.title,
              }
            })()
          : parseClaudeCatalogMetadata(
              trustedSource.canonicalPath,
              prefix.content,
              prefix.truncated,
              modifiedAt,
            )
    }
    if (metadata.isSubagent)
    {
      return { candidate: null, warning: null }
    }
    return {
      candidate: yield* enrichCandidate({
        source,
        sourcePath: trustedSource.canonicalPath,
        providerInstanceIds: trustedSource.providerInstanceIds,
        metadata,
      }),
      warning: metadata.warning,
    }
  })

  const scanFileGroup = Effect.fn('ImportDiscovery.scanFileGroup')(function* (
    group: ImportFileSourceDescriptorGroup,
    sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor>,
    progress: ImportScanProgress,
  )
  {
    const traversalBudget = makeImportCountBudget(IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES)
    const paths =
      group.source === 'codex-cli'
        ? yield* Effect.tryPromise({
            try: (signal) => codexCandidates(group.scanRoot, group.layout, traversalBudget, signal),
            catch: (cause) =>
              new ImportDiscoveryOperationError({
                operation: 'discover',
                sourcePath: group.scanRoot,
                cause,
              }),
          })
        : group.source === 'claude-code'
          ? yield* Effect.tryPromise({
              try: (signal) => claudeCandidates(group.scanRoot, traversalBudget, signal),
              catch: (cause) =>
                new ImportDiscoveryOperationError({
                  operation: 'discover',
                  sourcePath: group.scanRoot,
                  cause,
                }),
            })
          : yield* discoverOpenCodeSessionMetadataFiles(NodePath.dirname(group.scanRoot), {
              traversalBudget,
            })
    if (traversalBudget.truncated)
    {
      progress.truncated = true
      appendScanError(progress, {
        sourcePath: group.scanRoot,
        message: `scan traversal reached the ${IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES}-entry limit for this source root`,
      })
    }
    const bucketKey = `file:${group.source}:${group.scanRoot}`
    yield* Effect.forEach(
      paths,
      (sourcePath) =>
        describeFileCandidate(group.source, sourcePath, sourceDescriptors, group.layout).pipe(
          Effect.tap(({ candidate, warning }) =>
            Effect.sync(() =>
            {
              if (candidate !== null)
              {
                appendCandidate(progress, bucketKey, candidate)
              }
              if (warning !== null)
              {
                appendScanError(progress, { sourcePath, message: warning })
              }
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() =>
            {
              progress.truncated = true
              appendScanError(progress, { sourcePath, message: errorMessage(error) })
            }),
          ),
        ),
      { concurrency: 16, discard: true },
    )
  })

  const scanAcpDescriptor = Effect.fn('ImportDiscovery.scanAcpDescriptor')(function* (
    descriptor: AcpImportSourceDescriptor,
    progress: ImportScanProgress,
  )
  {
    const catalogOption = yield* deps
      .scanAcpSource(descriptor)
      .pipe(Effect.timeoutOption(configuredAcpScanPhaseTimeoutMs))
    if (Option.isNone(catalogOption))
    {
      progress.truncated = true
      appendScanError(progress, {
        sourcePath: null,
        message: `scan timed out after ${configuredAcpScanPhaseTimeoutMs}ms for ${descriptor.source} sessions for provider instance '${descriptor.providerInstanceId}'`,
      })
      return
    }
    const bucketKey = `acp:${descriptor.source}:${descriptor.providerInstanceId}`
    yield* Effect.forEach(
      catalogOption.value,
      (entry) =>
        Effect.gen(function* ()
        {
          if (entry.sourcePath.length > IMPORT_SOURCE_PATH_MAX_CHARS)
          {
            progress.truncated = true
            appendScanError(progress, {
              sourcePath: entry.sourcePath,
              message: `skipped: source path exceeds ${IMPORT_SOURCE_PATH_MAX_CHARS} characters`,
            })
            return
          }
          const nativeSessionId = boundedIdentity(entry.nativeSessionId)
          const candidate = yield* enrichCandidate({
            source: descriptor.source,
            sourcePath: entry.sourcePath,
            providerInstanceIds: [descriptor.providerInstanceId],
            metadata: {
              isSubagent: false,
              nativeSessionId,
              title: entry.title,
              cwd: entry.cwd,
              gitBranch: null,
              model: null,
              modifiedAt: entry.updatedAt ?? DateTime.formatIso(yield* DateTime.now),
              resumable: sourceIdentityValid(descriptor.source, entry.sourcePath, nativeSessionId),
              warning: null,
            },
          })
          appendCandidate(progress, bucketKey, candidate)
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
            {
              progress.truncated = true
              appendScanError(progress, {
                sourcePath: entry.sourcePath,
                message: errorMessage(error),
              })
            }),
          ),
        ),
      { concurrency: 16, discard: true },
    )
  })

  const scanWithinBudgets = Effect.fn('ImportDiscovery.scanWithinBudgets')(function* (
    input: ServerSettings | ImportScanRootOverrides = {},
    options: SourceCatalogOptions = {},
    progress: ImportScanProgress,
  )
  {
    const catalogResolutionTimeoutMs = Math.min(
      5_000,
      Math.max(1, Math.floor(configuredScanTimeoutMs / 10)),
    )
    const fileCatalogEffect =
      'providers' in input && 'providerInstances' in input
        ? resolveSourceCatalog(input, {
            ...options,
            rootResolutionTimeoutMs: Math.max(1, catalogResolutionTimeoutMs - 1),
          })
        : resolveDefaultSourceCatalog(input, {
            ...options,
            rootResolutionTimeoutMs: Math.max(1, catalogResolutionTimeoutMs - 1),
          })
    const acpCatalogEffect =
      'providers' in input && 'providerInstances' in input
        ? resolveAcpImportSourceCatalog(input, options)
        : Effect.succeed({ descriptors: [], errors: [] })
    const [fileCatalogOption, acpCatalogOption] = yield* Effect.all(
      [
        fileCatalogEffect.pipe(Effect.timeoutOption(catalogResolutionTimeoutMs)),
        acpCatalogEffect.pipe(Effect.timeoutOption(catalogResolutionTimeoutMs)),
      ],
      { concurrency: 'unbounded' },
    )
    const catalog = Option.getOrElse(fileCatalogOption, () =>
    {
      progress.truncated = true
      return {
        descriptors: [],
        errors: [
          {
            sourcePath: null,
            message: `file-source catalog resolution timed out after ${catalogResolutionTimeoutMs}ms`,
          },
        ],
      }
    })
    const acpCatalog = Option.getOrElse(acpCatalogOption, () =>
    {
      progress.truncated = true
      return {
        descriptors: [],
        errors: [
          {
            sourcePath: null,
            message: `ACP source catalog resolution timed out after ${catalogResolutionTimeoutMs}ms`,
          },
        ],
      }
    })
    for (const issue of [...catalog.errors, ...acpCatalog.errors])
    {
      progress.truncated = true
      appendScanError(progress, issue)
    }

    const work: ReadonlyArray<Effect.Effect<void>> = [
      ...groupImportFileSourceDescriptors(catalog.descriptors).map((group) =>
        scanFileGroup(group, catalog.descriptors, progress).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
            {
              progress.truncated = true
              appendScanError(progress, {
                sourcePath: group.scanRoot,
                message: errorMessage(error),
              })
            }),
          ),
        ),
      ),
      ...acpCatalog.descriptors.map((descriptor) =>
        scanAcpDescriptor(descriptor, progress).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
            {
              progress.truncated = true
              appendScanError(progress, {
                sourcePath: null,
                message: `failed to scan ${descriptor.source} sessions for provider instance '${descriptor.providerInstanceId}': ${errorMessage(error)}`,
              })
            }),
          ),
        ),
      ),
    ]
    yield* Effect.all(work, { concurrency: 4, discard: true })

    const unresolvedFileCandidates = [...progress.candidateBuckets.values()].flatMap((bucket) =>
      bucket.flatMap((candidate, index) =>
        candidate.alreadyImportedThreadId === null &&
        candidate.source !== 'cursor' &&
        candidate.source !== 'grok'
          ? [{ bucket, candidate, index }]
          : [],
      ),
    )
    if (unresolvedFileCandidates.length <= exactTailCandidateLimit)
    {
      const rawByteBudget = makeImportByteBudget(IMPORT_RPC_MAX_BYTES)
      yield* Effect.forEach(
        unresolvedFileCandidates,
        ({ bucket, candidate, index }) =>
          Effect.gen(function* ()
          {
            const trustedSource = yield* resolveImportSourcePath(
              catalog.descriptors,
              candidate.source,
              candidate.sourcePath,
            )
            const session =
              candidate.source === 'opencode'
                ? (yield* loadOpenCodeSessionFromMetadata(trustedSource.canonicalPath, {
                    aggregateBudget: rawByteBudget,
                    jsonFileBudget: makeImportCountBudget(OPENCODE_SESSION_MAX_JSON_FILES),
                    sourceValidation: trustedSource.validation,
                    traversalBudget: makeImportCountBudget(IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES),
                  })).session
                : yield* readResolvedImportSourceFile(trustedSource, rawByteBudget).pipe(
                    Effect.flatMap((sourceFile) =>
                      Effect.try({
                        try: () =>
                          candidate.source === 'codex-cli'
                            ? parseCodexRollout({
                                content: sourceFile.content,
                                sourcePath: sourceFile.canonicalPath,
                                contentHash: '',
                              })
                            : parseClaudeSession({
                                content: sourceFile.content,
                                sourcePath: sourceFile.canonicalPath,
                                contentHash: '',
                              }),
                        catch: (cause) =>
                          new ImportDiscoveryOperationError({
                            operation: 'discover',
                            sourcePath: candidate.sourcePath,
                            cause,
                          }),
                      }),
                    ),
                  )
            bucket[index] = {
              ...candidate,
              messageCount: session.records.filter((record) => record.kind === 'message').length,
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
              {
                appendScanError(progress, {
                  sourcePath: candidate.sourcePath,
                  message: `could not verify transcript message count: ${errorMessage(error)}`,
                })
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      )
    }

    const totalCandidateCount = [...progress.candidateBuckets.values()].reduce(
      (total, bucket) => total + bucket.length,
      0,
    )
    if (totalCandidateCount > IMPORT_SCAN_MAX_CANDIDATES)
    {
      progress.truncated = true
    }
    return yield* snapshotScanProgress(progress)
  })

  const diagnosticScanResult = (message: string) =>
    DateTime.now.pipe(
      Effect.map(
        (now) =>
          ({
            candidates: [],
            scannedAt: DateTime.formatIso(now),
            truncated: true,
            errors: [{ sourcePath: null, message }],
          }) satisfies ImportScanResult,
      ),
    )

  const scan = (
    input: ServerSettings | ImportScanRootOverrides = {},
    options: SourceCatalogOptions = {},
  ) =>
    Effect.suspend(() =>
    {
      const progress: ImportScanProgress = {
        candidateBuckets: new Map(),
        errors: [],
        omittedErrorCount: 0,
        truncated: false,
      }
      return importScanSemaphore
        .withPermitsIfAvailable(1)(
          scanWithinBudgets(input, options, progress).pipe(
            Effect.timeoutOption(configuredScanTimeoutMs),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                {
                  progress.truncated = true
                  appendScanError(progress, {
                    sourcePath: null,
                    message: `scan timed out after ${configuredScanTimeoutMs}ms`,
                  })
                  return snapshotScanProgress(progress)
                },
                onSome: Effect.succeed,
              }),
            ),
          ),
        )
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                diagnosticScanResult(
                  'scan skipped because another import scan is already in progress',
                ),
              onSome: Effect.succeed,
            }),
          ),
        )
    })

  return ImportDiscovery.of({ scan })
})

export const layer = Layer.effect(ImportDiscovery, make)
