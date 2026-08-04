// apps/server/src/import/resourceLimits.ts
// enforces shared import byte, file, traversal, and candidate budgets
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export const IMPORT_RPC_MAX_BYTES = 256 * 1024 * 1024
export const IMPORT_SESSION_MAX_BYTES = IMPORT_RPC_MAX_BYTES
// rendered activity details can exceed their raw transcript representation
export const IMPORT_NORMALIZED_SESSION_MAX_BYTES = 50 * 1024 * 1024
export const IMPORT_NORMALIZED_SESSION_MAX_RECORDS = 25_000
export const IMPORT_NORMALIZED_REQUEST_MAX_RECORDS = 25_000
export const IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES = 50_000
export const OPENCODE_SESSION_MAX_JSON_FILES = 10_000
export const ACP_IMPORT_DEFAULT_CATALOG_MAX_BYTES = 25 * 1024 * 1024
export const ACP_IMPORT_DEFAULT_REPLAY_SESSION_MAX_BYTES = 25 * 1024 * 1024
export const ACP_IMPORT_DEFAULT_REPLAY_CONNECTION_MAX_BYTES = 100 * 1024 * 1024
export const ACP_IMPORT_DEFAULT_NORMALIZED_CONNECTION_MAX_BYTES = 100 * 1024 * 1024

export interface ImportByteBudget
{
  readonly maximumBytes: number
  consumedBytes: number
}

export interface ImportCountBudget
{
  readonly maximumCount: number
  consumedCount: number
  truncated: boolean
}

export interface AcpImportBytePolicyInput
{
  readonly maxCatalogBytes?: number
  readonly maxReplayBytesPerSession?: number
  readonly maxReplayBytesPerConnection?: number
  readonly maxNormalizedBytesPerConnection?: number
}

export interface BoundedAcpImportBytePolicy
{
  readonly maxCatalogBytes: number
  readonly maxReplayBytesPerSession: number
  readonly maxReplayBytesPerConnection: number
  readonly maxNormalizedBytesPerConnection: number
}

export interface BoundedUtf8File
{
  readonly content: string
  readonly sizeBytes: number
  readonly mtimeMs: number
}

export interface BoundedUtf8FilePrefix extends BoundedUtf8File
{
  readonly truncated: boolean
}

export interface ImportFileSystemIdentity
{
  readonly device: bigint
  readonly inode: bigint
}

export interface ImportValidatedRoot
{
  readonly canonicalPath: string
  readonly identity: ImportFileSystemIdentity
}

export interface ImportSourceValidation
{
  readonly canonicalPath: string
  readonly fileIdentity: ImportFileSystemIdentity
  readonly roots: ReadonlyArray<ImportValidatedRoot>
}

export class ImportResourceLimitError extends Schema.TaggedErrorClass<ImportResourceLimitError>()(
  'ImportResourceLimitError',
  {
    sourcePath: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Cannot read import resource '${this.sourcePath}': ${this.reason}`
  }
}
const isImportResourceLimitError = Schema.is(ImportResourceLimitError)

export function makeImportByteBudget(maximumBytes: number): ImportByteBudget
{
  return { maximumBytes, consumedBytes: 0 }
}

export function makeImportCountBudget(maximumCount: number): ImportCountBudget
{
  return { maximumCount, consumedCount: 0, truncated: false }
}

function boundedConfiguredBytes(
  configured: number | undefined,
  fallback: number,
  maximum: number,
): number
{
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0)
  {
    return Math.min(fallback, maximum)
  }
  return Math.min(Math.floor(configured), maximum)
}

export function partitionAcpImportBytePolicy(
  maximumBytes: number,
  configured: AcpImportBytePolicyInput | undefined,
): BoundedAcpImportBytePolicy | null
{
  if (!Number.isFinite(maximumBytes))
  {
    return null
  }
  const aggregateMaximum = Math.max(0, Math.floor(maximumBytes))
  if (aggregateMaximum < 3)
  {
    return null
  }
  const catalogMaximum = Math.max(1, Math.floor(aggregateMaximum / 4))
  const maxCatalogBytes = boundedConfiguredBytes(
    configured?.maxCatalogBytes,
    ACP_IMPORT_DEFAULT_CATALOG_MAX_BYTES,
    catalogMaximum,
  )
  const replayAndNormalizedMaximum = aggregateMaximum - maxCatalogBytes
  const replayConnectionMaximum = Math.max(1, Math.floor(replayAndNormalizedMaximum / 2))
  const maxReplayBytesPerConnection = boundedConfiguredBytes(
    configured?.maxReplayBytesPerConnection,
    ACP_IMPORT_DEFAULT_REPLAY_CONNECTION_MAX_BYTES,
    replayConnectionMaximum,
  )
  const maxReplayBytesPerSession = boundedConfiguredBytes(
    configured?.maxReplayBytesPerSession,
    ACP_IMPORT_DEFAULT_REPLAY_SESSION_MAX_BYTES,
    maxReplayBytesPerConnection,
  )
  const normalizedMaximum = replayAndNormalizedMaximum - maxReplayBytesPerConnection
  const maxNormalizedBytesPerConnection = boundedConfiguredBytes(
    configured?.maxNormalizedBytesPerConnection,
    ACP_IMPORT_DEFAULT_NORMALIZED_CONNECTION_MAX_BYTES,
    normalizedMaximum,
  )
  return {
    maxCatalogBytes,
    maxReplayBytesPerSession,
    maxReplayBytesPerConnection,
    maxNormalizedBytesPerConnection,
  }
}

export function takeImportCount(budget: ImportCountBudget): boolean
{
  if (budget.consumedCount >= budget.maximumCount)
  {
    budget.truncated = true
    return false
  }
  budget.consumedCount += 1
  return true
}

export function reserveImportBytes(
  budget: ImportByteBudget,
  sizeBytes: number,
  sourcePath: string,
): ImportResourceLimitError | null
{
  if (sizeBytes > budget.maximumBytes - budget.consumedBytes)
  {
    return new ImportResourceLimitError({
      sourcePath,
      reason: `byte budget exceeded (${budget.maximumBytes} bytes maximum)`,
    })
  }
  budget.consumedBytes += sizeBytes
  return null
}

export function reserveNormalizedImportResources(input: {
  readonly byteBudget: ImportByteBudget
  readonly maximumSessionBytes?: number
  readonly maximumSessionRecords?: number
  readonly recordBudget: ImportCountBudget
  readonly recordCount: number
  readonly serializedBytes: number
  readonly sourcePath: string
}): ImportResourceLimitError | null
{
  const maximumSessionBytes = input.maximumSessionBytes ?? IMPORT_NORMALIZED_SESSION_MAX_BYTES
  const maximumSessionRecords = input.maximumSessionRecords ?? IMPORT_NORMALIZED_SESSION_MAX_RECORDS
  if (input.serializedBytes > maximumSessionBytes)
  {
    return new ImportResourceLimitError({
      sourcePath: input.sourcePath,
      reason: `normalized session exceeds ${maximumSessionBytes} bytes`,
    })
  }
  if (input.recordCount > maximumSessionRecords)
  {
    return new ImportResourceLimitError({
      sourcePath: input.sourcePath,
      reason: `normalized session exceeds ${maximumSessionRecords} records`,
    })
  }
  if (input.serializedBytes > input.byteBudget.maximumBytes - input.byteBudget.consumedBytes)
  {
    return new ImportResourceLimitError({
      sourcePath: input.sourcePath,
      reason: `normalized byte budget exceeded (${input.byteBudget.maximumBytes} bytes maximum)`,
    })
  }
  if (input.recordCount > input.recordBudget.maximumCount - input.recordBudget.consumedCount)
  {
    input.recordBudget.truncated = true
    return new ImportResourceLimitError({
      sourcePath: input.sourcePath,
      reason: `normalized record budget exceeded (${input.recordBudget.maximumCount} records maximum)`,
    })
  }
  input.byteBudget.consumedBytes += input.serializedBytes
  input.recordBudget.consumedCount += input.recordCount
  return null
}

function errorDetail(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

export function importFileSystemIdentity(
  stat: Pick<NodeFS.BigIntStats, 'dev' | 'ino'>,
): ImportFileSystemIdentity
{
  return {
    device: stat.dev,
    inode: stat.ino,
  }
}

function hasIdentity(
  stat: Pick<NodeFS.BigIntStats, 'dev' | 'ino'>,
  expected: ImportFileSystemIdentity,
): boolean
{
  return stat.dev === expected.device && stat.ino === expected.inode
}

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

async function verifyOpenedImportSource(
  sourcePath: string,
  openedStat: NodeFS.BigIntStats,
  validation: ImportSourceValidation,
): Promise<void>
{
  if (
    NodePath.resolve(sourcePath) !== validation.canonicalPath ||
    !hasIdentity(openedStat, validation.fileIdentity)
  )
  {
    throw new ImportResourceLimitError({
      sourcePath,
      reason: 'file changed after its import path was authorized',
    })
  }

  let currentCanonicalPath: string
  let pathStat: NodeFS.BigIntStats
  try
  {
    ;[currentCanonicalPath, pathStat] = await Promise.all([
      NodeFSP.realpath(sourcePath),
      NodeFSP.lstat(sourcePath, { bigint: true }),
    ])
  }
  catch (cause)
  {
    throw new ImportResourceLimitError({
      sourcePath,
      reason: 'authorized import path could not be revalidated',
      cause,
    })
  }
  if (
    currentCanonicalPath !== validation.canonicalPath ||
    !pathStat.isFile() ||
    !hasIdentity(pathStat, validation.fileIdentity) ||
    !hasIdentity(pathStat, importFileSystemIdentity(openedStat))
  )
  {
    throw new ImportResourceLimitError({
      sourcePath,
      reason: 'path changed after its import path was authorized',
    })
  }

  for (const root of validation.roots)
  {
    let currentCanonicalRoot: string
    let rootStat: NodeFS.BigIntStats
    try
    {
      ;[currentCanonicalRoot, rootStat] = await Promise.all([
        NodeFSP.realpath(root.canonicalPath),
        NodeFSP.stat(root.canonicalPath, { bigint: true }),
      ])
    }
    catch (cause)
    {
      throw new ImportResourceLimitError({
        sourcePath,
        reason: 'authorized import root could not be revalidated',
        cause,
      })
    }
    if (
      currentCanonicalRoot !== root.canonicalPath ||
      !rootStat.isDirectory() ||
      !hasIdentity(rootStat, root.identity) ||
      !isCanonicalDescendant(currentCanonicalRoot, currentCanonicalPath)
    )
    {
      throw new ImportResourceLimitError({
        sourcePath,
        reason: 'configured import root changed after the source was authorized',
      })
    }
  }
}

export const readBoundedUtf8File = Effect.fn('ImportResourceLimits.readBoundedUtf8File')(function* (
  sourcePath: string,
  maximumFileBytes: number,
  budgets: ReadonlyArray<ImportByteBudget> = [],
  validation?: ImportSourceValidation,
)
{
  return yield* Effect.tryPromise({
    try: async (signal) =>
    {
      const noFollow = NodeFS.constants.O_NOFOLLOW ?? 0
      const nonBlock = NodeFS.constants.O_NONBLOCK ?? 0
      const handle = await NodeFSP.open(sourcePath, NodeFS.constants.O_RDONLY | noFollow | nonBlock)
      try
      {
        const initialStat = await handle.stat({ bigint: true })
        if (!initialStat.isFile())
        {
          throw new ImportResourceLimitError({
            sourcePath,
            reason: 'path is not a regular file',
          })
        }
        if (validation !== undefined)
        {
          await verifyOpenedImportSource(sourcePath, initialStat, validation)
        }
        const sizeBytes = Number(initialStat.size)
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes > maximumFileBytes)
        {
          throw new ImportResourceLimitError({
            sourcePath,
            reason: `file exceeds ${maximumFileBytes} bytes`,
          })
        }
        const pathStat = await NodeFSP.lstat(sourcePath, { bigint: true })
        if (
          !pathStat.isFile() ||
          pathStat.dev !== initialStat.dev ||
          pathStat.ino !== initialStat.ino
        )
        {
          throw new ImportResourceLimitError({
            sourcePath,
            reason: 'path changed while it was being validated',
          })
        }
        for (const budget of new Set(budgets))
        {
          const reservationError = reserveImportBytes(budget, sizeBytes, sourcePath)
          if (reservationError !== null)
          {
            throw reservationError
          }
        }

        const chunks: Buffer[] = []
        let totalBytes = 0
        while (totalBytes <= sizeBytes)
        {
          signal.throwIfAborted()
          const remainingProbeBytes = sizeBytes + 1 - totalBytes
          if (remainingProbeBytes <= 0)
          {
            break
          }
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingProbeBytes))
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes)
          if (bytesRead === 0)
          {
            break
          }
          chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
          totalBytes += bytesRead
        }
        const finalStat = await handle.stat({ bigint: true })
        if (
          totalBytes !== sizeBytes ||
          finalStat.size !== initialStat.size ||
          finalStat.mtimeNs !== initialStat.mtimeNs ||
          finalStat.ctimeNs !== initialStat.ctimeNs
        )
        {
          throw new ImportResourceLimitError({
            sourcePath,
            reason: 'file changed while it was being read',
          })
        }
        if (validation !== undefined)
        {
          await verifyOpenedImportSource(sourcePath, finalStat, validation)
        }
        return {
          content: Buffer.concat(chunks, totalBytes).toString('utf8'),
          sizeBytes,
          mtimeMs: Number(initialStat.mtimeMs),
        } satisfies BoundedUtf8File
      }
      finally
      {
        await handle.close()
      }
    },
    catch: (cause) =>
      isImportResourceLimitError(cause)
        ? cause
        : new ImportResourceLimitError({
            sourcePath,
            reason: errorDetail(cause),
            cause,
          }),
  })
})

export const readBoundedUtf8FilePrefix = Effect.fn(
  'ImportResourceLimits.readBoundedUtf8FilePrefix',
)(function* (sourcePath: string, maximumPrefixBytes: number, validation?: ImportSourceValidation)
{
  return yield* Effect.tryPromise({
    try: async (signal) =>
    {
      const noFollow = NodeFS.constants.O_NOFOLLOW ?? 0
      const nonBlock = NodeFS.constants.O_NONBLOCK ?? 0
      const handle = await NodeFSP.open(sourcePath, NodeFS.constants.O_RDONLY | noFollow | nonBlock)
      try
      {
        const initialStat = await handle.stat({ bigint: true })
        if (!initialStat.isFile())
        {
          throw new ImportResourceLimitError({
            sourcePath,
            reason: 'path is not a regular file',
          })
        }
        if (validation !== undefined)
        {
          await verifyOpenedImportSource(sourcePath, initialStat, validation)
        }
        const sizeBytes = Number(initialStat.size)
        if (!Number.isSafeInteger(sizeBytes))
        {
          throw new ImportResourceLimitError({
            sourcePath,
            reason: 'file size exceeds the supported integer range',
          })
        }

        const prefixBytes = Math.min(sizeBytes, Math.max(0, Math.floor(maximumPrefixBytes)))
        signal.throwIfAborted()
        const prefix = Buffer.allocUnsafe(prefixBytes)
        let bytesRead = 0
        while (bytesRead < prefixBytes)
        {
          signal.throwIfAborted()
          const chunk = await handle.read(prefix, bytesRead, prefixBytes - bytesRead, bytesRead)
          if (chunk.bytesRead === 0)
          {
            break
          }
          bytesRead += chunk.bytesRead
        }

        const finalStat = await handle.stat({ bigint: true })
        if (
          finalStat.size !== initialStat.size ||
          finalStat.mtimeNs !== initialStat.mtimeNs ||
          finalStat.ctimeNs !== initialStat.ctimeNs
        )
        {
          throw new ImportResourceLimitError({
            sourcePath,
            reason: 'file changed while its metadata prefix was being read',
          })
        }
        if (validation !== undefined)
        {
          await verifyOpenedImportSource(sourcePath, finalStat, validation)
        }
        return {
          content: prefix.subarray(0, bytesRead).toString('utf8'),
          sizeBytes,
          mtimeMs: Number(initialStat.mtimeMs),
          truncated: bytesRead < sizeBytes,
        } satisfies BoundedUtf8FilePrefix
      }
      finally
      {
        await handle.close()
      }
    },
    catch: (cause) =>
      isImportResourceLimitError(cause)
        ? cause
        : new ImportResourceLimitError({
            sourcePath,
            reason: errorDetail(cause),
            cause,
          }),
  })
})
