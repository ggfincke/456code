// apps/server/src/serverStorageLease.ts
// owns one canonical base-directory storage authority per process

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodePerfHooks from 'node:perf_hooks'
import * as NodeUtil from 'node:util'

import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

export const SERVER_STORAGE_LEASE_FILE = '.456code-storage.lock'
export const SERVER_STORAGE_LEASE_MUTEX_FILE = '.456code-storage.lock.sqlite'
export const SERVER_STORAGE_LEASE_RECOVERY_GRACE_MS = 30_000

export const ServerStorageLeaseOwner = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  hostname: Schema.String,
  acquiredAt: Schema.String,
  processStartedAt: Schema.String,
  canonicalBaseDir: Schema.String,
})
export type ServerStorageLeaseOwner = typeof ServerStorageLeaseOwner.Type

export class ServerStorageLeaseConflictError extends Schema.TaggedErrorClass<ServerStorageLeaseConflictError>()(
  'ServerStorageLeaseConflictError',
  {
    canonicalBaseDir: Schema.String,
    lockPath: Schema.String,
    reason: Schema.Literals(['active-owner', 'different-host-owner', 'recent-unreadable-owner']),
    incumbent: Schema.optional(ServerStorageLeaseOwner),
  },
)
{
  override get message(): string
  {
    const owner = this.incumbent
    const ownerText = owner
      ? `pid ${owner.pid} on ${owner.hostname}, acquired ${owner.acquiredAt}`
      : 'an unreadable recent owner record'
    return `Server storage at ${this.canonicalBaseDir} is already owned by ${ownerText}.`
  }
}

export class ServerStorageLeaseIoError extends Schema.TaggedErrorClass<ServerStorageLeaseIoError>()(
  'ServerStorageLeaseIoError',
  {
    operation: Schema.Literals([
      'create-parent',
      'canonicalize-parent',
      'canonicalize-path',
      'open-mutex',
      'release-mutex',
      'create-lock',
      'write-lock',
      'read-lock',
      'stat-lock',
      'quarantine-lock',
      'release-lock',
    ]),
    lockPath: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to ${this.operation} for server storage lease ${this.lockPath}.`
  }
}

export class ServerStorageLeaseBoundaryError extends Schema.TaggedErrorClass<ServerStorageLeaseBoundaryError>()(
  'ServerStorageLeaseBoundaryError',
  {
    canonicalBaseDir: Schema.String,
    requestedPath: Schema.String,
  },
)
{
  override get message(): string
  {
    return `Storage path ${this.requestedPath} is outside leased base directory ${this.canonicalBaseDir}.`
  }
}

interface SqliteMutexDatabase
{
  readonly exec: (sql: string) => unknown
  readonly close: () => unknown
}

interface StorageMutexHandle
{
  readonly database: SqliteMutexDatabase
}

const storageMutexHandle = Symbol('456code/server-storage-lease-mutex')

export interface ServerStorageLeaseService
{
  readonly canonicalBaseDir: string
  readonly lockPath: string
  readonly mutexPath: string
  readonly owner: ServerStorageLeaseOwner
  readonly [storageMutexHandle]?: StorageMutexHandle
}

export class ServerStorageLease extends Context.Service<
  ServerStorageLease,
  ServerStorageLeaseService
>()('456code/serverStorageLease')
{}

export const layer = (lease: ServerStorageLeaseService) =>
  Layer.succeed(ServerStorageLease, ServerStorageLease.of(lease))

export const assertLeasedStoragePath = Effect.fn('ServerStorageLease.assertPath')(function* (
  requestedPath: string,
)
{
  const lease = yield* ServerStorageLease
  const resolvedPath = NodePath.resolve(requestedPath)
  const canonicalPath = yield* io('canonicalize-path', lease.lockPath, () =>
    NodeFSP.realpath(resolvedPath),
  ).pipe(
    Effect.catchIf(ioErrorHasCode('ENOENT'), () =>
      io('canonicalize-path', lease.lockPath, () =>
        NodeFSP.realpath(NodePath.dirname(resolvedPath)).then((parent) =>
          NodePath.join(parent, NodePath.basename(resolvedPath)),
        ),
      ),
    ),
  )
  const relative = NodePath.relative(lease.canonicalBaseDir, canonicalPath)
  if (relative === '' || (!relative.startsWith('..') && !NodePath.isAbsolute(relative))) return
  return yield* new ServerStorageLeaseBoundaryError({
    canonicalBaseDir: lease.canonicalBaseDir,
    requestedPath: resolvedPath,
  })
})

const decodeOwner = Schema.decodeUnknownOption(Schema.fromJsonString(ServerStorageLeaseOwner))
const currentProcessStartedAt = DateTime.formatIso(
  DateTime.makeUnsafe(NodePerfHooks.performance.timeOrigin),
)
const realEpochMillis = (): number =>
  NodePerfHooks.performance.timeOrigin + NodePerfHooks.performance.now()
const execFilePromise = NodeUtil.promisify(NodeChildProcess.execFile)

const nodeErrorCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined

const io = <A>(
  operation: ServerStorageLeaseIoError['operation'],
  lockPath: string,
  run: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ServerStorageLeaseIoError({ operation, lockPath, cause }),
  })

const ioErrorHasCode =
  (code: string) =>
  (error: ServerStorageLeaseIoError): boolean =>
    nodeErrorCode(error.cause) === code

const isSqliteBusy = (cause: unknown): boolean =>
{
  if (typeof cause !== 'object' || cause === null) return false
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : ''
  const message = 'message' in cause && typeof cause.message === 'string' ? cause.message : ''
  return code === 'SQLITE_BUSY' || message.toLowerCase().includes('database is locked')
}

// the exclusive SQLite transaction is the acquisition/recovery serializer.
// the kernel releases it on process death, so no stale-observer can rename a
// replacement owner's record between inspection and exclusive creation.
const openStorageMutex = Effect.fn('ServerStorageLease.openStorageMutex')(function* (
  mutexPath: string,
)
{
  const opened = yield* Effect.tryPromise({
    try: async (): Promise<StorageMutexHandle | null> =>
    {
      let database: SqliteMutexDatabase | undefined
      try
      {
        if (process.versions.bun !== undefined)
        {
          const { Database } = await import('bun:sqlite')
          database = new Database(mutexPath, { create: true })
        }
        else
        {
          const { DatabaseSync } = await import('node:sqlite')
          database = new DatabaseSync(mutexPath)
        }
        database.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 50; BEGIN EXCLUSIVE')
        await NodeFSP.chmod(mutexPath, 0o600)
        return { database }
      }
      catch (cause)
      {
        try
        {
          database?.close()
        }
        catch
        {
          // acquisition is already failing; closing cannot restore ownership
        }
        if (isSqliteBusy(cause)) return null
        throw cause
      }
    },
    catch: (cause) =>
      new ServerStorageLeaseIoError({ operation: 'open-mutex', lockPath: mutexPath, cause }),
  })
  return opened
})

const releaseStorageMutex = Effect.fn('ServerStorageLease.releaseStorageMutex')(function* (
  mutexPath: string,
  mutex: StorageMutexHandle,
)
{
  yield* io('release-mutex', mutexPath, async () =>
  {
    try
    {
      mutex.database.exec('ROLLBACK')
    }
    finally
    {
      mutex.database.close()
    }
  })
})

type ProcessLiveness = 'alive' | 'dead' | 'unknown'

const processLiveness = (pid: number): ProcessLiveness =>
{
  try
  {
    process.kill(pid, 0)
    return 'alive'
  }
  catch (cause)
  {
    const code = nodeErrorCode(cause)
    if (code === 'ESRCH') return 'dead'
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

// compares process birth where the host exposes it so PID reuse cannot inherit a stale lease
const observedProcessStartedAt = Effect.fn('ServerStorageLease.observedProcessStartedAt')(
  function* (pid: number)
  {
    if ((yield* HostProcessPlatform) === 'win32') return undefined
    const result = yield* Effect.tryPromise({
      try: () => execFilePromise('ps', ['-o', 'lstart=', '-p', String(pid)]),
      catch: () => false as const,
    }).pipe(Effect.option)
    if (Option.isNone(result)) return undefined

    const startedAt = Date.parse(result.value.stdout.trim())
    return Number.isFinite(startedAt) ? startedAt : undefined
  },
)

const incumbentProcessLiveness = Effect.fn('ServerStorageLease.incumbentProcessLiveness')(
  function* (incumbent: ServerStorageLeaseOwner)
  {
    const liveness = processLiveness(incumbent.pid)
    if (liveness !== 'alive') return liveness

    if (incumbent.pid === process.pid)
    {
      return incumbent.processStartedAt === currentProcessStartedAt ? 'alive' : 'dead'
    }

    const observedStartedAt = yield* observedProcessStartedAt(incumbent.pid)
    const claimedStartedAt = Date.parse(incumbent.processStartedAt)
    if (
      observedStartedAt !== undefined &&
      Number.isFinite(claimedStartedAt) &&
      Math.abs(observedStartedAt - claimedStartedAt) > 2_500
    )
    {
      return 'dead'
    }
    return 'alive'
  },
)

interface AcquireServerStorageLeaseOptions
{
  readonly recoveryGraceMs?: number | undefined
}

type IncumbentInspection = Readonly<
  | { disposition: 'retry' | 'recover' }
  | { disposition: 'conflict'; conflict: ServerStorageLeaseConflictError }
>

const inspectIncumbent = Effect.fn('ServerStorageLease.inspectIncumbent')(function* (input: {
  readonly canonicalBaseDir: string
  readonly lockPath: string
  readonly recoveryGraceMs: number
})
{
  const raw = yield* io('read-lock', input.lockPath, () =>
    NodeFSP.readFile(input.lockPath, 'utf8'),
  ).pipe(
    Effect.map(Option.some),
    Effect.catchIf(ioErrorHasCode('ENOENT'), () => Effect.succeed(Option.none())),
  )
  if (Option.isNone(raw))
  {
    return { disposition: 'retry' } satisfies IncumbentInspection
  }

  const decoded = decodeOwner(raw.value)
  if (Option.isNone(decoded) || decoded.value.canonicalBaseDir !== input.canonicalBaseDir)
  {
    const stat = yield* io('stat-lock', input.lockPath, () => NodeFSP.stat(input.lockPath)).pipe(
      Effect.map(Option.some),
      Effect.catchIf(ioErrorHasCode('ENOENT'), () => Effect.succeed(Option.none())),
    )
    if (Option.isNone(stat))
    {
      return { disposition: 'retry' } satisfies IncumbentInspection
    }
    if (realEpochMillis() - stat.value.mtimeMs >= input.recoveryGraceMs)
    {
      return { disposition: 'recover' } satisfies IncumbentInspection
    }
    return {
      disposition: 'conflict',
      conflict: new ServerStorageLeaseConflictError({
        canonicalBaseDir: input.canonicalBaseDir,
        lockPath: input.lockPath,
        reason: 'recent-unreadable-owner',
      }),
    } satisfies IncumbentInspection
  }

  const incumbent = decoded.value
  if (incumbent.hostname !== NodeOS.hostname())
  {
    return {
      disposition: 'conflict',
      conflict: new ServerStorageLeaseConflictError({
        canonicalBaseDir: input.canonicalBaseDir,
        lockPath: input.lockPath,
        reason: 'different-host-owner',
        incumbent,
      }),
    } satisfies IncumbentInspection
  }

  const liveness = yield* incumbentProcessLiveness(incumbent)
  if (liveness !== 'dead')
  {
    return {
      disposition: 'conflict',
      conflict: new ServerStorageLeaseConflictError({
        canonicalBaseDir: input.canonicalBaseDir,
        lockPath: input.lockPath,
        reason: 'active-owner',
        incumbent,
      }),
    } satisfies IncumbentInspection
  }
  return { disposition: 'recover' } satisfies IncumbentInspection
})

const writeOwnerFile = Effect.fn('ServerStorageLease.writeOwnerFile')(function* (input: {
  readonly lockPath: string
  readonly owner: ServerStorageLeaseOwner
})
{
  const handle = yield* io('create-lock', input.lockPath, () =>
    NodeFSP.open(input.lockPath, 'wx', 0o600),
  ).pipe(
    Effect.map(Option.some),
    Effect.catchIf(ioErrorHasCode('EEXIST'), () => Effect.succeed(Option.none())),
  )
  if (Option.isNone(handle)) return false

  const written = yield* io('write-lock', input.lockPath, async () =>
  {
    try
    {
      await handle.value.writeFile(`${JSON.stringify(input.owner)}\n`, 'utf8')
      await handle.value.sync()
    }
    finally
    {
      await handle.value.close()
    }
  }).pipe(Effect.result)
  if (written._tag === 'Failure')
  {
    yield* io('release-lock', input.lockPath, () =>
      NodeFSP.rm(input.lockPath, { force: true }),
    ).pipe(Effect.ignore)
    return yield* written.failure
  }
  return true
})

const acquireOwner = Effect.fn('ServerStorageLease.acquireOwner')(function* (input: {
  readonly canonicalBaseDir: string
  readonly lockPath: string
  readonly recoveryGraceMs: number
  readonly owner: ServerStorageLeaseOwner
})
{
  const quarantinePaths: Array<string> = []
  for (let attempt = 0; attempt < 8; attempt += 1)
  {
    if (yield* writeOwnerFile({ lockPath: input.lockPath, owner: input.owner }))
    {
      yield* Effect.forEach(
        quarantinePaths,
        (path) =>
          io('release-lock', path, () => NodeFSP.rm(path, { force: true })).pipe(Effect.ignore),
        { discard: true },
      )
      return
    }

    const inspection = yield* inspectIncumbent(input)
    if (inspection.disposition === 'retry') continue
    if (inspection.disposition === 'conflict') return yield* inspection.conflict

    const quarantinePath = `${input.lockPath}.stale-${input.owner.token}-${attempt}`
    const quarantined = yield* io('quarantine-lock', input.lockPath, () =>
      NodeFSP.rename(input.lockPath, quarantinePath),
    ).pipe(
      Effect.as(true),
      Effect.catchIf(ioErrorHasCode('ENOENT'), () => Effect.succeed(false)),
    )
    if (quarantined) quarantinePaths.push(quarantinePath)
  }

  return yield* new ServerStorageLeaseConflictError({
    canonicalBaseDir: input.canonicalBaseDir,
    lockPath: input.lockPath,
    reason: 'recent-unreadable-owner',
  })
})

const releaseOwner = Effect.fn('ServerStorageLease.releaseOwner')(function* (
  lease: ServerStorageLeaseService,
)
{
  const raw = yield* io('read-lock', lease.lockPath, () =>
    NodeFSP.readFile(lease.lockPath, 'utf8'),
  ).pipe(
    Effect.map(Option.some),
    Effect.catchIf(ioErrorHasCode('ENOENT'), () => Effect.succeed(Option.none())),
  )
  if (Option.isNone(raw)) return

  const incumbent = decodeOwner(raw.value)
  if (Option.isNone(incumbent) || incumbent.value.token !== lease.owner.token)
  {
    yield* Effect.logWarning('Skipped server storage lease release because ownership changed').pipe(
      Effect.annotateLogs({
        canonicalBaseDir: lease.canonicalBaseDir,
        lockPath: lease.lockPath,
        expectedToken: lease.owner.token,
        actualToken: Option.isSome(incumbent) ? incumbent.value.token : 'unreadable',
      }),
    )
    return
  }

  yield* io('release-lock', lease.lockPath, () => NodeFSP.rm(lease.lockPath)).pipe(
    Effect.catchIf(ioErrorHasCode('ENOENT'), () => Effect.void),
  )
})

export const acquireServerStorageLease = (
  baseDir: string,
  options: AcquireServerStorageLeaseOptions = {},
) =>
  Effect.acquireRelease(
    Effect.gen(function* ()
    {
      const unresolvedLockPath = NodePath.join(NodePath.resolve(baseDir), SERVER_STORAGE_LEASE_FILE)
      yield* io('create-parent', unresolvedLockPath, () =>
        NodeFSP.mkdir(baseDir, { recursive: true }),
      )
      const canonicalBaseDir = yield* io('canonicalize-parent', unresolvedLockPath, () =>
        NodeFSP.realpath(baseDir),
      )
      const lockPath = NodePath.join(canonicalBaseDir, SERVER_STORAGE_LEASE_FILE)
      const mutexPath = NodePath.join(canonicalBaseDir, SERVER_STORAGE_LEASE_MUTEX_FILE)
      const mutex = yield* openStorageMutex(mutexPath)
      if (mutex === null)
      {
        const inspection = yield* inspectIncumbent({
          canonicalBaseDir,
          lockPath,
          recoveryGraceMs: options.recoveryGraceMs ?? SERVER_STORAGE_LEASE_RECOVERY_GRACE_MS,
        })
        if (inspection.disposition === 'conflict') return yield* inspection.conflict
        return yield* new ServerStorageLeaseConflictError({
          canonicalBaseDir,
          lockPath,
          reason: 'recent-unreadable-owner',
        })
      }
      const acquiredAt = DateTime.formatIso(yield* DateTime.now)
      const owner: ServerStorageLeaseOwner = {
        version: 1,
        token: NodeCrypto.randomUUID(),
        pid: process.pid,
        hostname: NodeOS.hostname(),
        acquiredAt,
        processStartedAt: currentProcessStartedAt,
        canonicalBaseDir,
      }
      const acquired = yield* acquireOwner({
        canonicalBaseDir,
        lockPath,
        recoveryGraceMs: options.recoveryGraceMs ?? SERVER_STORAGE_LEASE_RECOVERY_GRACE_MS,
        owner,
      }).pipe(Effect.result)
      if (acquired._tag === 'Failure')
      {
        yield* releaseStorageMutex(mutexPath, mutex).pipe(Effect.ignore)
        return yield* acquired.failure
      }
      return ServerStorageLease.of({
        canonicalBaseDir,
        lockPath,
        mutexPath,
        owner,
        [storageMutexHandle]: mutex,
      })
    }),
    (lease) =>
      releaseOwner(lease).pipe(
        Effect.ensuring(
          lease[storageMutexHandle] === undefined
            ? Effect.void
            : releaseStorageMutex(lease.mutexPath, lease[storageMutexHandle]).pipe(Effect.orDie),
        ),
        Effect.orDie,
      ),
  )
