// apps/server/src/cartographer/CurrentWorktreeArchitectureService.ts
// owns prepared current-worktree architecture targets and bounded cleanup

// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off

import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import { CartographerError, type ThreadId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import * as ServerConfig from '../config.ts'
import * as CartographerAnalyzer from './CartographerAnalyzer.ts'
import { captureCurrentWorktree } from './CurrentWorktreeSnapshot.ts'

const CURRENT_WORKTREE_IDLE_TTL_MS = 8 * 60 * 60 * 1_000
const CURRENT_WORKTREE_REAPER_INTERVAL_MS = 5 * 60 * 1_000
const CURRENT_WORKTREE_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000
const ORPHAN_SWEEP_MAX_DIRECTORIES = 256
const ORPHAN_SWEEP_BUDGET_MS = 250
const ORPHAN_SWEEP_CURSOR_VERSION = 1
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/u
const TARGET_READ_LEASE_PERMITS = 1_000_000

class CurrentWorktreeArchitectureFsError extends Data.TaggedError(
  'CurrentWorktreeArchitectureFsError',
)<{
  readonly cause: unknown
}>
{}

export interface CurrentWorktreeArchitectureAnalyzer
{
  readonly prepareCurrentWorktree: (
    input: CartographerAnalyzer.CurrentWorktreeAnalysisInput,
  ) => Effect.Effect<void, CartographerError>
}

export interface PrepareCurrentWorktreeArchitectureInput
{
  readonly threadId: ThreadId
  readonly workspaceRoot: string
}

export interface RetainedCurrentWorktreeArchitectureTarget
{
  readonly sourceKind: 'current-worktree'
  readonly root: string
  readonly outDir: string
  readonly graphPath: string
  readonly liveRoot: string
}

interface MutableCurrentWorktreeArchitectureTarget extends RetainedCurrentWorktreeArchitectureTarget
{
  readonly targetId: string
  readonly threadId: ThreadId
  readonly lifecycleLock: Semaphore.Semaphore
  readonly readLeases: Semaphore.Semaphore
  readonly closeCompletion: Deferred.Deferred<void>
  lastAccessedAt: number
  closing: boolean
}

export interface CurrentWorktreeArchitectureServiceShape
{
  readonly prepare: (
    input: PrepareCurrentWorktreeArchitectureInput,
  ) => Effect.Effect<RetainedCurrentWorktreeArchitectureTarget, CartographerError>
  readonly retainThreadTarget: (
    threadId: ThreadId,
  ) => Effect.Effect<RetainedCurrentWorktreeArchitectureTarget, CartographerError, Scope.Scope>
  readonly releasePreparedTarget: (
    threadId: ThreadId,
    expectedOutDir?: string,
  ) => Effect.Effect<void>
  readonly closeThread: (threadId: ThreadId) => Effect.Effect<void>
  readonly reapExpired: Effect.Effect<number>
  readonly closeAll: Effect.Effect<void>
}

export class CurrentWorktreeArchitectureService extends Context.Service<
  CurrentWorktreeArchitectureService,
  CurrentWorktreeArchitectureServiceShape
>()('456code/cartographer/CurrentWorktreeArchitectureService')
{}

export interface CurrentWorktreeArchitectureServiceOptions
{
  readonly stateDir: string
  readonly analyzer: CurrentWorktreeArchitectureAnalyzer
  readonly disposeArchitectureArtifacts?: (root: string, outDir: string) => Promise<void>
  readonly now?: () => number
  readonly clock?: Effect.Effect<number>
  readonly idleTtlMs?: number
  readonly reaperIntervalMs?: number
}

interface OrphanSweepCursor
{
  lastScannedName: string | null
}

interface OrphanSweepOptions
{
  readonly maxDirectories?: number
  readonly budgetMs?: number
  readonly graceMs?: number
  readonly now?: () => number
  readonly cursor?: OrphanSweepCursor
  readonly protectedDirectoryNames?: ReadonlySet<string>
}

function publicError(failure: CartographerError['failure'], message: string): CartographerError
{
  return new CartographerError({ failure, message })
}

async function removeTargetDirectory(path: string): Promise<void>
{
  await NodeFSP.rm(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  })
}

async function readOrphanSweepCursor(path: string): Promise<OrphanSweepCursor>
{
  try
  {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, 'utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== ORPHAN_SWEEP_CURSOR_VERSION ||
      !('lastScannedName' in parsed) ||
      (parsed.lastScannedName !== null &&
        (typeof parsed.lastScannedName !== 'string' ||
          !TARGET_ID_PATTERN.test(parsed.lastScannedName)))
    )
    {
      return { lastScannedName: null }
    }
    return { lastScannedName: parsed.lastScannedName }
  }
  catch
  {
    return { lastScannedName: null }
  }
}

async function persistOrphanSweepCursor(path: string, cursor: OrphanSweepCursor): Promise<void>
{
  const parent = NodePath.dirname(path)
  const temporaryPath = NodePath.join(
    parent,
    `.${NodePath.basename(path)}.${NodeCrypto.randomBytes(8).toString('hex')}.tmp`,
  )
  await NodeFSP.mkdir(parent, { recursive: true })
  try
  {
    await NodeFSP.writeFile(
      temporaryPath,
      `${JSON.stringify({
        version: ORPHAN_SWEEP_CURSOR_VERSION,
        lastScannedName: cursor.lastScannedName,
      })}\n`,
      { flag: 'wx' },
    )
    await NodeFSP.rename(temporaryPath, path)
  }
  finally
  {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function sweepOrphanedTargetDirectories(
  targetsRoot: string,
  options: OrphanSweepOptions = {},
): Promise<number>
{
  const maxDirectories = options.maxDirectories ?? ORPHAN_SWEEP_MAX_DIRECTORIES
  const budgetMs = options.budgetMs ?? ORPHAN_SWEEP_BUDGET_MS
  const graceMs = options.graceMs ?? CURRENT_WORKTREE_ORPHAN_GRACE_MS
  const now = options.now ?? Date.now
  await NodeFSP.mkdir(targetsRoot, { recursive: true })
  const entries = (await NodeFSP.readdir(targetsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && TARGET_ID_PATTERN.test(entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  if (entries.length === 0)
  {
    if (options.cursor !== undefined) options.cursor.lastScannedName = null
    return 0
  }
  const lastScannedName = options.cursor?.lastScannedName ?? null
  const nextIndex =
    lastScannedName === null
      ? 0
      : entries.findIndex((entry) => entry.name.localeCompare(lastScannedName) > 0)
  const startIndex = nextIndex < 0 ? 0 : nextIndex
  const sweepEntries =
    startIndex === 0 ? entries : [...entries.slice(startIndex), ...entries.slice(0, startIndex)]
  const startedAt = now()
  let removed = 0
  let scanned = 0
  for (const entry of sweepEntries)
  {
    if (scanned >= maxDirectories || now() - startedAt >= budgetMs) break
    scanned += 1
    if (options.cursor !== undefined) options.cursor.lastScannedName = entry.name
    if (options.protectedDirectoryNames?.has(entry.name) === true) continue
    const candidate = NodePath.join(targetsRoot, entry.name)
    const age = await NodeFSP.lstat(candidate).then(
      (stat) => now() - stat.mtimeMs,
      () => null,
    )
    if (age === null || age < graceMs) continue
    await removeTargetDirectory(candidate)
    removed += 1
  }
  return removed
}

async function finalizePreparedArtifacts(outDir: string): Promise<void>
{
  await NodeFSP.rm(NodePath.join(outDir, 'graph.db'), { force: true })
  for (const name of ['graph.json', 'atlas-index.json'] as const)
  {
    const path = NodePath.join(outDir, name)
    const stat = await NodeFSP.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink())
    {
      throw new Error(`${name} is not a regular prepared artifact`)
    }
  }
}

export const make = Effect.fn('CurrentWorktreeArchitectureService.make')(function* (
  options: CurrentWorktreeArchitectureServiceOptions,
)
{
  const now = options.now ?? Date.now
  const currentTime = options.clock ?? Effect.sync(now)
  const idleTtlMs = options.idleTtlMs ?? CURRENT_WORKTREE_IDLE_TTL_MS
  const reaperIntervalMs = options.reaperIntervalMs ?? CURRENT_WORKTREE_REAPER_INTERVAL_MS
  const targetsRoot = NodePath.join(options.stateDir, 'cartographer', 'current-worktrees')
  const legacyTargetsRoot = NodePath.join(options.stateDir, 'cartographer', 'contexts')
  const orphanSweepCursorPath = NodePath.join(
    options.stateDir,
    'cartographer',
    'current-worktree-orphan-sweep-cursor.json',
  )
  const legacyOrphanSweepCursorPath = NodePath.join(
    options.stateDir,
    'cartographer',
    'legacy-context-orphan-sweep-cursor.json',
  )
  const targets = new Map<ThreadId, MutableCurrentWorktreeArchitectureTarget>()
  const threadLocks = new Map<ThreadId, Semaphore.Semaphore>()
  const pendingPreparations = new Map<ThreadId, AbortController>()
  const pendingTargetIds = new Set<string>()
  const closingTargetIds = new Set<string>()
  const closedThreads = new Set<ThreadId>()
  const orphanSweepCursor = yield* Effect.promise(() =>
    readOrphanSweepCursor(orphanSweepCursorPath),
  )
  const legacyOrphanSweepCursor = yield* Effect.promise(() =>
    readOrphanSweepCursor(legacyOrphanSweepCursorPath),
  )
  const orphanSweepLock = yield* Semaphore.make(1)
  let closed = false

  const disposeArchitectureArtifacts =
    options.disposeArchitectureArtifacts ??
    (async (root: string, outDir: string) =>
    {
      const core = await import('@t3tools/cartographer-core/server')
      await core.disposeAtlasArtifacts(root, outDir)
    })

  const lockForThread = Effect.fn('CurrentWorktreeArchitectureService.lockForThread')(function* (
    threadId: ThreadId,
  )
  {
    const existing = threadLocks.get(threadId)
    if (existing !== undefined) return existing
    const created = yield* Semaphore.make(1)
    const raced = threadLocks.get(threadId)
    if (raced !== undefined) return raced
    threadLocks.set(threadId, created)
    return created
  })

  const sweepOrphanedTargets = orphanSweepLock.withPermit(
    Effect.tryPromise({
      try: async () =>
      {
        const protectedDirectoryNames = new Set([
          ...pendingTargetIds,
          ...closingTargetIds,
          ...[...targets.values()].map((target) => target.targetId),
        ])
        try
        {
          const [currentRemoved, legacyRemoved] = await Promise.all([
            sweepOrphanedTargetDirectories(targetsRoot, {
              now,
              cursor: orphanSweepCursor,
              protectedDirectoryNames,
            }),
            sweepOrphanedTargetDirectories(legacyTargetsRoot, {
              now,
              cursor: legacyOrphanSweepCursor,
            }),
          ])
          return currentRemoved + legacyRemoved
        }
        finally
        {
          await Promise.all([
            persistOrphanSweepCursor(orphanSweepCursorPath, orphanSweepCursor),
            persistOrphanSweepCursor(legacyOrphanSweepCursorPath, legacyOrphanSweepCursor),
          ])
        }
      },
      catch: (cause) => new CurrentWorktreeArchitectureFsError({ cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning('current-worktree architecture orphan sweep failed', {
          cause,
          targetsRoot,
        }),
      ),
    ),
  )

  yield* sweepOrphanedTargets

  const closeTarget = Effect.fn('CurrentWorktreeArchitectureService.closeTarget')(function* (
    target: MutableCurrentWorktreeArchitectureTarget,
  )
  {
    const firstCloser = yield* target.lifecycleLock.withPermit(
      Effect.sync(() =>
      {
        if (target.closing) return false
        target.closing = true
        closingTargetIds.add(target.targetId)
        if (targets.get(target.threadId) === target) targets.delete(target.threadId)
        return true
      }),
    )
    if (!firstCloser)
    {
      yield* Deferred.await(target.closeCompletion)
      return
    }
    yield* Effect.uninterruptible(
      target.readLeases
        .withPermits(TARGET_READ_LEASE_PERMITS)(
          Effect.gen(function* ()
          {
            yield* Effect.tryPromise({
              try: () => disposeArchitectureArtifacts(target.root, target.outDir),
              catch: (cause) => new CurrentWorktreeArchitectureFsError({ cause }),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning('current-worktree architecture disposal failed', {
                  cause,
                  targetId: target.targetId,
                }),
              ),
            )
            yield* Effect.tryPromise({
              try: () => removeTargetDirectory(NodePath.dirname(target.outDir)),
              catch: (cause) => new CurrentWorktreeArchitectureFsError({ cause }),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning('current-worktree architecture cleanup failed', {
                  cause,
                  targetId: target.targetId,
                }),
              ),
            )
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => closingTargetIds.delete(target.targetId)).pipe(
              Effect.andThen(Deferred.succeed(target.closeCompletion, undefined)),
            ),
          ),
        ),
    )
  })

  const prepare: CurrentWorktreeArchitectureServiceShape['prepare'] = (input) =>
    Effect.gen(function* ()
    {
      if (closed || closedThreads.has(input.threadId))
      {
        return yield* publicError(
          'context_start_failed',
          'Current-worktree architecture is no longer available.',
        )
      }
      pendingPreparations.get(input.threadId)?.abort()
      const controller = new AbortController()
      pendingPreparations.set(input.threadId, controller)
      const targetId = NodeCrypto.randomBytes(18).toString('base64url')
      pendingTargetIds.add(targetId)
      const targetRoot = NodePath.join(targetsRoot, targetId)
      const outDir = NodePath.join(targetRoot, 'artifacts')
      let published = false

      return yield* Effect.gen(function* ()
      {
        const liveRoot = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(input.workspaceRoot),
          catch: () =>
            publicError('snapshot_failed', 'Cartographer could not resolve the current worktree.'),
        })
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(outDir, { recursive: true }),
          catch: () =>
            publicError(
              'context_start_failed',
              'Current-worktree architecture storage could not be created.',
            ),
        })
        const snapshot = yield* captureCurrentWorktree({
          workspaceRoot: liveRoot,
          artifactRoot: targetRoot,
          signal: controller.signal,
        }).pipe(
          Effect.mapError(() =>
            publicError('snapshot_failed', 'Cartographer could not capture the current worktree.'),
          ),
        )
        yield* options.analyzer.prepareCurrentWorktree({
          root: snapshot.rootPath,
          outDir,
          signal: controller.signal,
        })
        yield* Effect.tryPromise({
          try: () => finalizePreparedArtifacts(outDir),
          catch: () =>
            publicError(
              'context_start_failed',
              'Current-worktree architecture artifacts were not fully prepared.',
            ),
        })
        const createdAt = yield* currentTime
        const target: MutableCurrentWorktreeArchitectureTarget = {
          targetId,
          sourceKind: 'current-worktree',
          threadId: input.threadId,
          root: snapshot.rootPath,
          outDir,
          graphPath: NodePath.join(outDir, 'graph.json'),
          liveRoot,
          lifecycleLock: yield* Semaphore.make(1),
          readLeases: yield* Semaphore.make(TARGET_READ_LEASE_PERMITS),
          closeCompletion: yield* Deferred.make<void>(),
          lastAccessedAt: createdAt,
          closing: false,
        }
        const lock = yield* lockForThread(input.threadId)
        return yield* lock.withPermit(
          Effect.gen(function* ()
          {
            if (
              closed ||
              closedThreads.has(input.threadId) ||
              controller.signal.aborted ||
              pendingPreparations.get(input.threadId) !== controller
            )
            {
              return yield* publicError(
                'context_start_failed',
                'Current-worktree architecture is no longer available.',
              )
            }
            const previous = targets.get(input.threadId)
            targets.set(input.threadId, target)
            published = true
            if (previous !== undefined) yield* closeTarget(previous)
            return target
          }),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
          {
            controller.abort()
            if (pendingPreparations.get(input.threadId) === controller)
            {
              pendingPreparations.delete(input.threadId)
            }
            pendingTargetIds.delete(targetId)
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                published
                  ? Effect.void
                  : Effect.tryPromise({
                      try: () => removeTargetDirectory(targetRoot),
                      catch: (cause) => new CurrentWorktreeArchitectureFsError({ cause }),
                    }).pipe(Effect.ignore),
              ),
            ),
          ),
        ),
      )
    })

  const retainThreadTarget: CurrentWorktreeArchitectureServiceShape['retainThreadTarget'] = (
    threadId,
  ) =>
    Effect.acquireRelease(
      Effect.gen(function* ()
      {
        const target = targets.get(threadId)
        if (target === undefined)
        {
          return yield* publicError(
            'context_not_found',
            'Current-worktree architecture is not prepared.',
          )
        }
        return yield* target.lifecycleLock.withPermit(
          Effect.gen(function* ()
          {
            if (target.closing || targets.get(threadId) !== target)
            {
              return yield* publicError(
                'context_not_found',
                'Current-worktree architecture is no longer available.',
              )
            }
            yield* target.readLeases.take(1)
            target.lastAccessedAt = yield* currentTime
            return target
          }),
        )
      }),
      (target) => target.readLeases.release(1).pipe(Effect.asVoid),
    )

  const releasePreparedTarget: CurrentWorktreeArchitectureServiceShape['releasePreparedTarget'] = (
    threadId,
    expectedOutDir,
  ) =>
    Effect.flatMap(lockForThread(threadId), (lock) =>
      lock.withPermit(
        Effect.suspend(() =>
        {
          const target = targets.get(threadId)
          if (
            target === undefined ||
            (expectedOutDir !== undefined && target.outDir !== expectedOutDir)
          )
          {
            return Effect.void
          }
          return closeTarget(target)
        }),
      ),
    )

  const closeThread: CurrentWorktreeArchitectureServiceShape['closeThread'] = (threadId) =>
    Effect.gen(function* ()
    {
      closedThreads.add(threadId)
      pendingPreparations.get(threadId)?.abort()
      yield* releasePreparedTarget(threadId)
    })

  const reapExpired: CurrentWorktreeArchitectureServiceShape['reapExpired'] = Effect.gen(
    function* ()
    {
      const accessedAt = yield* currentTime
      const expired = [...targets.entries()].filter(
        ([, target]) => accessedAt - target.lastAccessedAt >= idleTtlMs,
      )
      const reaped = yield* Effect.forEach(
        expired,
        ([threadId, target]) =>
          Effect.flatMap(lockForThread(threadId), (lock) =>
            lock.withPermit(
              Effect.gen(function* ()
              {
                if (
                  targets.get(threadId) !== target ||
                  accessedAt - target.lastAccessedAt < idleTtlMs
                )
                {
                  return false
                }
                yield* closeTarget(target)
                return true
              }),
            ),
          ),
        { concurrency: 'unbounded' },
      )
      yield* sweepOrphanedTargets
      yield* Effect.tryPromise({
        try: async () =>
        {
          const stamp = new Date(now())
          await Promise.all(
            [...targets.values()].map((target) =>
              NodeFSP.utimes(NodePath.dirname(target.outDir), stamp, stamp).catch(() => undefined),
            ),
          )
        },
        catch: (cause) => new CurrentWorktreeArchitectureFsError({ cause }),
      }).pipe(Effect.ignore)
      return reaped.filter(Boolean).length
    },
  )

  const closeAll: CurrentWorktreeArchitectureServiceShape['closeAll'] = Effect.gen(function* ()
  {
    closed = true
    for (const controller of pendingPreparations.values()) controller.abort()
    yield* Effect.forEach([...targets.values()], closeTarget, {
      concurrency: 'unbounded',
      discard: true,
    })
    pendingPreparations.clear()
    pendingTargetIds.clear()
    closingTargetIds.clear()
    threadLocks.clear()
  })

  if (reaperIntervalMs > 0)
  {
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(reaperIntervalMs).pipe(Effect.andThen(reapExpired))),
    )
  }

  return CurrentWorktreeArchitectureService.of({
    prepare,
    retainThreadTarget,
    releasePreparedTarget,
    closeThread,
    reapExpired,
    closeAll,
  })
})

export const layer = Layer.effect(
  CurrentWorktreeArchitectureService,
  Effect.gen(function* ()
  {
    const config = yield* ServerConfig.ServerConfig
    const analyzer = yield* CartographerAnalyzer.CartographerAnalyzer
    return yield* Effect.acquireRelease(
      make({ stateDir: config.stateDir, analyzer }),
      (service) => service.closeAll,
    )
  }),
)
