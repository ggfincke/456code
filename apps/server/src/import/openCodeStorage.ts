// apps/server/src/import/openCodeStorage.ts
// discovers and loads deterministic opencode transcript storage bundles

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

export { resolveOpenCodeStorageRoot } from '../provider/continuationIdentity.ts'

import {
  type OpenCodeStoredFile,
  type OpenCodeStoredMessageBundle,
  openCodeSessionIdentityStatus,
  parseOpenCodeSessionBundle,
} from './openCodeSessionParser.ts'
import {
  type ImportByteBudget,
  type ImportCountBudget,
  importFileSystemIdentity,
  type ImportSourceValidation,
  type ImportValidatedRoot,
  IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES,
  IMPORT_SESSION_MAX_BYTES,
  OPENCODE_SESSION_MAX_JSON_FILES,
  makeImportByteBudget,
  makeImportCountBudget,
  readBoundedUtf8File,
  readBoundedUtf8FilePrefix,
  takeImportCount,
} from './resourceLimits.ts'
import type { ImportedSession } from './types.ts'

interface LoadedStoredFile extends OpenCodeStoredFile
{
  readonly absolutePath: string
  readonly mtimeMs: number
}

const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export interface LoadedOpenCodeSession
{
  readonly session: ImportedSession
  readonly contentHash: string
  readonly modifiedAt: string
  readonly sizeBytes: number
  readonly fileCount: number
}

export interface OpenCodeSessionCatalogMetadata
{
  readonly isSubagent: boolean
  readonly nativeSessionId: string
  readonly cwd: string | null
  readonly title: string | null
  readonly modifiedAt: string
  readonly resumable: boolean
  readonly warning: string | null
}

export interface OpenCodeDiscoveryOptions
{
  readonly traversalBudget?: ImportCountBudget
  readonly candidateBudget?: ImportCountBudget
}

export interface OpenCodeLoadOptions
{
  readonly aggregateBudget?: ImportByteBudget
  readonly jsonFileBudget?: ImportCountBudget
  readonly traversalBudget?: ImportCountBudget
  readonly sourceValidation?: ImportSourceValidation
  readonly maximumBytes?: number
  readonly maximumJsonFiles?: number
}

export class OpenCodeStorageError extends Schema.TaggedErrorClass<OpenCodeStorageError>()(
  'OpenCodeStorageError',
  {
    operation: Schema.Literals(['discover', 'layout', 'read', 'stat']),
    sourcePath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `${this.detail} ('${this.sourcePath}')`
  }
}

function isMissingPathError(error: unknown): boolean
{
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null
{
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function boundedCatalogText(value: string | null, maximumChars: number): string | null
{
  if (value === null)
  {
    return null
  }
  return value.length <= maximumChars ? value : `${value.slice(0, maximumChars - 1)}…`
}

function errorDetail(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

const readDirectory = Effect.fn('OpenCodeStorage.readDirectory')(function* (
  directory: string,
  traversalBudget: ImportCountBudget,
)
{
  return yield* Effect.tryPromise({
    try: async (signal) =>
    {
      const entries: NodeFS.Dirent[] = []
      signal.throwIfAborted()
      const handle = await NodeFSP.opendir(directory)
      try
      {
        for await (const entry of handle)
        {
          signal.throwIfAborted()
          if (!takeImportCount(traversalBudget))
          {
            break
          }
          entries.push(entry)
        }
      }
      finally
      {
        await handle.close().catch(() => undefined)
      }
      return entries
    },
    catch: (cause) =>
      new OpenCodeStorageError({
        operation: 'discover',
        sourcePath: directory,
        detail: `Could not inspect OpenCode storage: ${errorDetail(cause)}`,
        cause,
      }),
  })
})

const readStoredFile = Effect.fn('OpenCodeStorage.readStoredFile')(function* (
  storageRoot: ImportValidatedRoot,
  absolutePath: string,
  relativePath: string,
  sessionBudget: ImportByteBudget,
  aggregateBudget: ImportByteBudget | undefined,
  fileBudget: ImportCountBudget,
  sourceValidation?: ImportSourceValidation,
)
{
  if (!takeImportCount(fileBudget))
  {
    return yield* new OpenCodeStorageError({
      operation: 'read',
      sourcePath: absolutePath,
      detail: `OpenCode session exceeds ${fileBudget.maximumCount} JSON files`,
    })
  }
  const validation =
    sourceValidation ??
    (yield* Effect.tryPromise({
      try: async () =>
      {
        const fileStat = await NodeFSP.stat(absolutePath, { bigint: true })
        const revalidatedPath = await NodeFSP.realpath(absolutePath)
        if (!fileStat.isFile() || revalidatedPath !== absolutePath)
        {
          throw new Error('OpenCode transcript file changed while it was being authorized')
        }
        return {
          canonicalPath: absolutePath,
          fileIdentity: importFileSystemIdentity(fileStat),
          roots: [storageRoot],
        } satisfies ImportSourceValidation
      },
      catch: (cause) =>
        new OpenCodeStorageError({
          operation: 'read',
          sourcePath: absolutePath,
          detail: 'Could not authorize OpenCode transcript file',
          cause,
        }),
    }))
  const loaded = yield* readBoundedUtf8File(
    absolutePath,
    IMPORT_SESSION_MAX_BYTES,
    aggregateBudget === undefined ? [sessionBudget] : [sessionBudget, aggregateBudget],
    validation,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeStorageError({
          operation: 'read',
          sourcePath: absolutePath,
          detail: `Could not read OpenCode transcript file: ${errorDetail(cause)}`,
          cause,
        }),
    ),
  )
  return {
    absolutePath,
    relativePath,
    content: loaded.content,
    mtimeMs: loaded.mtimeMs,
  } satisfies LoadedStoredFile
})

function safeStorageId(value: string): boolean
{
  return /^[a-zA-Z0-9_-]+$/.test(value)
}

function isSessionMetadataFileName(value: string): boolean
{
  return /^ses_[a-zA-Z0-9_-]+\.json$/.test(value)
}

function isPathContainedBy(root: string, candidate: string): boolean
{
  const relative = NodePath.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  )
}

const captureValidatedRoot = Effect.fn('OpenCodeStorage.captureValidatedRoot')(function* (
  canonicalRoot: string,
)
{
  return yield* Effect.tryPromise({
    try: async () =>
    {
      const rootStat = await NodeFSP.stat(canonicalRoot, { bigint: true })
      const revalidatedRoot = await NodeFSP.realpath(canonicalRoot)
      if (!rootStat.isDirectory() || revalidatedRoot !== canonicalRoot)
      {
        throw new Error('OpenCode storage root changed while it was being authorized')
      }
      return {
        canonicalPath: canonicalRoot,
        identity: importFileSystemIdentity(rootStat),
      } satisfies ImportValidatedRoot
    },
    catch: (cause) =>
      new OpenCodeStorageError({
        operation: 'layout',
        sourcePath: canonicalRoot,
        detail: 'Could not authorize OpenCode storage root',
        cause,
      }),
  })
})

const canonicalContainedPath = Effect.fn('OpenCodeStorage.canonicalContainedPath')(function* (
  storageRoot: string,
  candidatePath: string,
  expectedType: 'directory' | 'file',
  missingAllowed: boolean,
)
{
  const canonicalPath = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(candidatePath),
    catch: (cause) =>
      new OpenCodeStorageError({
        operation: 'layout',
        sourcePath: candidatePath,
        detail: `Could not resolve OpenCode storage path: ${errorDetail(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.catchIf(
      (cause) => missingAllowed && isMissingPathError(cause.cause),
      () => Effect.succeed(null),
    ),
  )
  if (canonicalPath === null)
  {
    return null
  }
  if (!isPathContainedBy(storageRoot, canonicalPath))
  {
    return yield* new OpenCodeStorageError({
      operation: 'layout',
      sourcePath: candidatePath,
      detail: 'OpenCode transcript path escapes its storage root',
    })
  }
  const stat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(canonicalPath),
    catch: (cause) =>
      new OpenCodeStorageError({
        operation: 'stat',
        sourcePath: canonicalPath,
        detail: `Could not inspect OpenCode storage path: ${errorDetail(cause)}`,
        cause,
      }),
  })
  const hasExpectedType = expectedType === 'directory' ? stat.isDirectory() : stat.isFile()
  if (!hasExpectedType)
  {
    return yield* new OpenCodeStorageError({
      operation: 'layout',
      sourcePath: canonicalPath,
      detail: `OpenCode transcript path is not a regular ${expectedType}`,
    })
  }
  return canonicalPath
})

const containedJsonFiles = Effect.fn('OpenCodeStorage.containedJsonFiles')(function* (
  storageRoot: string,
  directory: string,
  traversalBudget: ImportCountBudget,
)
{
  const canonicalDirectory = yield* canonicalContainedPath(
    storageRoot,
    directory,
    'directory',
    true,
  )
  if (canonicalDirectory === null)
  {
    return []
  }
  const entries = yield* readDirectory(canonicalDirectory, traversalBudget)
  return yield* Effect.forEach(
    entries
      .filter((entry) => entry.name.endsWith('.json'))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    (entry) =>
      canonicalContainedPath(
        storageRoot,
        NodePath.join(canonicalDirectory, entry.name),
        'file',
        false,
      ).pipe(
        Effect.flatMap((absolutePath) =>
          absolutePath === null
            ? Effect.fail(
                new OpenCodeStorageError({
                  operation: 'layout',
                  sourcePath: NodePath.join(canonicalDirectory, entry.name),
                  detail: 'OpenCode transcript file disappeared during import',
                }),
              )
            : Effect.succeed({
                absolutePath,
                fileName: entry.name,
              }),
        ),
      ),
  )
})

function hashStoredFile(hash: NodeCrypto.Hash, file: LoadedStoredFile): void
{
  const relativePathBytes = Buffer.byteLength(file.relativePath)
  const contentBytes = Buffer.byteLength(file.content)
  hash.update(`${relativePathBytes}:`)
  hash.update(file.relativePath)
  hash.update(`${contentBytes}:`)
  hash.update(file.content)
}

function hashBundle(
  metadata: LoadedStoredFile,
  messages: ReadonlyArray<{
    readonly message: LoadedStoredFile
    readonly parts: ReadonlyArray<LoadedStoredFile>
  }>,
): string
{
  const hash = NodeCrypto.createHash('sha256')
  hashStoredFile(hash, metadata)
  for (const { message, parts } of messages)
  {
    hashStoredFile(hash, message)
    for (const part of parts)
    {
      hashStoredFile(hash, part)
    }
  }
  return hash.digest('hex')
}

export const discoverOpenCodeSessionMetadataFiles = Effect.fn(
  'OpenCodeStorage.discoverOpenCodeSessionMetadataFiles',
)(function* (storageRoot: string, options: OpenCodeDiscoveryOptions = {})
{
  const traversalBudget =
    options.traversalBudget ?? makeImportCountBudget(IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES)
  const canonicalStorageRoot = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(storageRoot),
    catch: (cause) =>
      new OpenCodeStorageError({
        operation: 'discover',
        sourcePath: storageRoot,
        detail: `Could not resolve OpenCode storage root: ${errorDetail(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.catchIf(
      (cause) => isMissingPathError(cause.cause),
      () => Effect.succeed(null),
    ),
  )
  if (canonicalStorageRoot === null)
  {
    return []
  }
  const sessionRoot = yield* canonicalContainedPath(
    canonicalStorageRoot,
    NodePath.join(canonicalStorageRoot, 'session'),
    'directory',
    true,
  )
  if (sessionRoot === null)
  {
    return []
  }
  const projectEntries = yield* readDirectory(sessionRoot, traversalBudget)
  const candidates: string[] = []
  projectLoop: for (const project of projectEntries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .toSorted((left, right) => left.name.localeCompare(right.name)))
    {
    const projectDirectory = yield* canonicalContainedPath(
      canonicalStorageRoot,
      NodePath.join(sessionRoot, project.name),
      'directory',
      false,
    )
    if (projectDirectory === null)
    {
      return yield* new OpenCodeStorageError({
        operation: 'layout',
        sourcePath: NodePath.join(sessionRoot, project.name),
        detail: 'OpenCode project directory disappeared during discovery',
      })
    }
    for (const file of yield* containedJsonFiles(
      canonicalStorageRoot,
      projectDirectory,
      traversalBudget,
    ))
    {
      if (isSessionMetadataFileName(file.fileName))
      {
        if (options.candidateBudget !== undefined && !takeImportCount(options.candidateBudget))
        {
          break projectLoop
        }
        candidates.push(NodePath.join(storageRoot, 'session', project.name, file.fileName))
      }
    }
    if (traversalBudget.truncated)
    {
      break
    }
  }
  return candidates
})

export const readOpenCodeSessionCatalogMetadata = Effect.fn(
  'OpenCodeStorage.readOpenCodeSessionCatalogMetadata',
)(function* (sourcePath: string, validation: ImportSourceValidation)
{
  const canonicalSourcePath = validation.canonicalPath
  const nativeSessionId = NodePath.basename(canonicalSourcePath, '.json')
  const prefix = yield* readBoundedUtf8FilePrefix(canonicalSourcePath, 64 * 1024, validation).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeStorageError({
          operation: 'read',
          sourcePath,
          detail: `Could not read OpenCode session metadata: ${errorDetail(cause)}`,
          cause,
        }),
    ),
  )
  const fallbackModifiedAt = DateTime.formatIso(DateTime.makeUnsafe(prefix.mtimeMs))
  if (prefix.truncated)
  {
    return {
      isSubagent: false,
      nativeSessionId,
      cwd: null,
      title: null,
      modifiedAt: fallbackModifiedAt,
      resumable: false,
      warning: 'OpenCode session metadata exceeded the 64 KiB catalog probe',
    } satisfies OpenCodeSessionCatalogMetadata
  }

  const decoded = decodeUnknownJsonString(prefix.content)
  if (Option.isNone(decoded))
  {
    return {
      isSubagent: false,
      nativeSessionId,
      cwd: null,
      title: null,
      modifiedAt: fallbackModifiedAt,
      resumable: false,
      warning: 'OpenCode session metadata is not valid JSON',
    } satisfies OpenCodeSessionCatalogMetadata
  }
  const parsed = decoded.value
  if (!isRecord(parsed))
  {
    return {
      isSubagent: false,
      nativeSessionId,
      cwd: null,
      title: null,
      modifiedAt: fallbackModifiedAt,
      resumable: false,
      warning: 'OpenCode session metadata is not a JSON object',
    } satisfies OpenCodeSessionCatalogMetadata
  }

  const storedSessionId = nonEmptyString(parsed.id)
  const storedProjectId = nonEmptyString(parsed.projectID)
  const enclosingProjectId = NodePath.basename(NodePath.dirname(canonicalSourcePath))
  const identity = openCodeSessionIdentityStatus({
    storedSessionId,
    storedProjectId,
    sessionId: nativeSessionId,
    enclosingProjectId,
  })
  const time = isRecord(parsed.time) ? parsed.time : null
  const updatedAtMs =
    typeof time?.updated === 'number' && Number.isFinite(time.updated)
      ? time.updated
      : prefix.mtimeMs
  const updatedAt = DateTime.make(updatedAtMs).pipe(
    Option.getOrElse(() => DateTime.makeUnsafe(prefix.mtimeMs)),
  )
  return {
    isSubagent: nonEmptyString(parsed.parentID) !== null,
    nativeSessionId,
    cwd: boundedCatalogText(nonEmptyString(parsed.directory), 4_096),
    title: boundedCatalogText(nonEmptyString(parsed.title), 512),
    modifiedAt: DateTime.formatIso(updatedAt),
    resumable: identity.valid,
    warning: identity.valid
      ? null
      : !identity.sessionIdMatches
        ? 'OpenCode session id does not match the metadata filename'
        : 'OpenCode session project id does not match its enclosing storage directory',
  } satisfies OpenCodeSessionCatalogMetadata
})

export const loadOpenCodeSessionFromMetadata = Effect.fn(
  'OpenCodeStorage.loadOpenCodeSessionFromMetadata',
)(function* (sourcePath: string, options: OpenCodeLoadOptions = {})
{
  const sessionBudget = makeImportByteBudget(
    Math.min(options.maximumBytes ?? IMPORT_SESSION_MAX_BYTES, IMPORT_SESSION_MAX_BYTES),
  )
  const fileBudget =
    options.jsonFileBudget ??
    makeImportCountBudget(
      Math.min(
        options.maximumJsonFiles ?? OPENCODE_SESSION_MAX_JSON_FILES,
        OPENCODE_SESSION_MAX_JSON_FILES,
      ),
    )
  const traversalBudget =
    options.traversalBudget ?? makeImportCountBudget(IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES)
  const absoluteSourcePath = NodePath.resolve(sourcePath)
  const metadataFileName = NodePath.basename(absoluteSourcePath)
  const projectDirectory = NodePath.dirname(absoluteSourcePath)
  const sessionDirectory = NodePath.dirname(projectDirectory)
  const lexicalStorageRoot = NodePath.dirname(sessionDirectory)
  const sessionId = NodePath.basename(metadataFileName, '.json')
  if (
    NodePath.basename(sessionDirectory) !== 'session' ||
    !isSessionMetadataFileName(metadataFileName) ||
    !safeStorageId(sessionId)
  )
  {
    return yield* new OpenCodeStorageError({
      operation: 'layout',
      sourcePath: absoluteSourcePath,
      detail: 'OpenCode session metadata must use storage/session/<project>/<session>.json layout',
    })
  }

  const storageRoot = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(lexicalStorageRoot),
    catch: (cause) =>
      new OpenCodeStorageError({
        operation: 'layout',
        sourcePath: absoluteSourcePath,
        detail: `Could not resolve OpenCode storage root: ${errorDetail(cause)}`,
        cause,
      }),
  })
  const storageRootValidation = yield* captureValidatedRoot(storageRoot)
  const canonicalSourcePath = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(absoluteSourcePath),
    catch: (cause) =>
      new OpenCodeStorageError({
        operation: 'layout',
        sourcePath: absoluteSourcePath,
        detail: `Could not resolve OpenCode session metadata: ${errorDetail(cause)}`,
        cause,
      }),
  })
  if (!isPathContainedBy(storageRoot, canonicalSourcePath))
  {
    return yield* new OpenCodeStorageError({
      operation: 'layout',
      sourcePath: absoluteSourcePath,
      detail: 'OpenCode transcript path escapes its storage root',
    })
  }
  const metadataValidation =
    options.sourceValidation === undefined
      ? undefined
      : {
          ...options.sourceValidation,
          roots: [
            ...options.sourceValidation.roots,
            ...(options.sourceValidation.roots.some(
              (root) => root.canonicalPath === storageRootValidation.canonicalPath,
            )
              ? []
              : [storageRootValidation]),
          ],
        }

  const metadataRelativePath = NodePath.posix.join(
    'session',
    NodePath.basename(projectDirectory),
    metadataFileName,
  )
  const metadata = yield* readStoredFile(
    storageRootValidation,
    canonicalSourcePath,
    metadataRelativePath,
    sessionBudget,
    options.aggregateBudget,
    fileBudget,
    metadataValidation,
  )
  const messageDirectory = NodePath.join(storageRoot, 'message', sessionId)
  const messageFiles = yield* containedJsonFiles(storageRoot, messageDirectory, traversalBudget)
  if (traversalBudget.truncated)
  {
    return yield* new OpenCodeStorageError({
      operation: 'discover',
      sourcePath: messageDirectory,
      detail: `OpenCode traversal exceeds ${traversalBudget.maximumCount} filesystem entries`,
    })
  }
  const messages: Array<{
    readonly message: LoadedStoredFile
    readonly parts: ReadonlyArray<LoadedStoredFile>
  }> = []

  for (const messageFile of messageFiles)
  {
    const messageId = NodePath.basename(messageFile.fileName, '.json')
    if (!safeStorageId(messageId))
    {
      continue
    }
    const message = yield* readStoredFile(
      storageRootValidation,
      messageFile.absolutePath,
      NodePath.posix.join('message', sessionId, messageFile.fileName),
      sessionBudget,
      options.aggregateBudget,
      fileBudget,
    )
    const partDirectory = NodePath.join(storageRoot, 'part', messageId)
    const parts = yield* Effect.forEach(
      yield* containedJsonFiles(storageRoot, partDirectory, traversalBudget),
      (partFile) =>
        readStoredFile(
          storageRootValidation,
          partFile.absolutePath,
          NodePath.posix.join('part', messageId, partFile.fileName),
          sessionBudget,
          options.aggregateBudget,
          fileBudget,
        ),
    )
    if (traversalBudget.truncated)
    {
      return yield* new OpenCodeStorageError({
        operation: 'discover',
        sourcePath: partDirectory,
        detail: `OpenCode traversal exceeds ${traversalBudget.maximumCount} filesystem entries`,
      })
    }
    messages.push({ message, parts })
  }

  const contentHash = hashBundle(metadata, messages)
  let latestMtimeMs = metadata.mtimeMs
  for (const { message, parts } of messages)
  {
    latestMtimeMs = Math.max(latestMtimeMs, message.mtimeMs)
    for (const part of parts)
    {
      latestMtimeMs = Math.max(latestMtimeMs, part.mtimeMs)
    }
  }
  const parserMessages: OpenCodeStoredMessageBundle[] = messages.map(({ message, parts }) => ({
    message,
    parts,
  }))

  return {
    session: parseOpenCodeSessionBundle({
      sourcePath: canonicalSourcePath,
      contentHash,
      sessionId,
      session: metadata,
      messages: parserMessages,
    }),
    contentHash,
    modifiedAt: DateTime.formatIso(DateTime.makeUnsafe(latestMtimeMs)),
    sizeBytes: sessionBudget.consumedBytes,
    fileCount: fileBudget.consumedCount,
  } satisfies LoadedOpenCodeSession
})
