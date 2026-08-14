// tests/apps/server/cartographer/CurrentWorktreeArchitectureService.test.ts
// verifies prepared current-worktree replacement, leases, expiry, and deletion fences

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { expect, it } from '@effect/vitest'
import { ThreadId } from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { describe } from 'vite-plus/test'

import { make } from '../../../../apps/server/src/cartographer/CurrentWorktreeArchitectureService.ts'

const threadId = ThreadId.make('thread-current-worktree-architecture')

async function makeTemporaryRoot(prefix: string): Promise<string>
{
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))
}

function initializeRepository(root: string): void
{
  NodeChildProcess.execFileSync('git', ['init', '--quiet'], { cwd: root })
  NodeChildProcess.execFileSync('git', ['config', 'user.name', '456code Test'], { cwd: root })
  NodeChildProcess.execFileSync('git', ['config', 'user.email', '456code@example.invalid'], {
    cwd: root,
  })
  NodeChildProcess.execFileSync('git', ['add', '.'], { cwd: root })
  NodeChildProcess.execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })
}

async function writePreparedArtifacts(outDir: string): Promise<void>
{
  await NodeFSP.mkdir(outDir, { recursive: true })
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(outDir, 'graph.json'), '{}\n'),
    NodeFSP.writeFile(NodePath.join(outDir, 'atlas-index.json'), '{}\n'),
    NodeFSP.writeFile(NodePath.join(outDir, 'graph.db'), ''),
  ])
}

describe('CurrentWorktreeArchitectureService', () =>
{
  it.effect('replaces one prepared target only after existing read leases drain', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-current-architecture-state-'),
        )
        const workspaceRoot = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-current-architecture-workspace-'),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all([
              NodeFSP.rm(stateDir, { recursive: true, force: true }),
              NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            ]),
          ).pipe(Effect.asVoid),
        )
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspaceRoot, 'entry.ts'), 'v1\n'),
        )
        yield* Effect.sync(() => initializeRepository(workspaceRoot))

        let preparations = 0
        const secondPrepared = yield* Deferred.make<void>()
        const service = yield* make({
          stateDir,
          reaperIntervalMs: 0,
          disposeArchitectureArtifacts: async () => undefined,
          analyzer: {
            prepareCurrentWorktree: ({ outDir }) =>
              Effect.gen(function* ()
              {
                preparations += 1
                yield* Effect.promise(() => writePreparedArtifacts(outDir))
                if (preparations === 2) yield* Deferred.succeed(secondPrepared, undefined)
              }),
          },
        })
        yield* Effect.addFinalizer(() => service.closeAll)

        const first = yield* service.prepare({ threadId, workspaceRoot })
        const leaseScope = yield* Scope.make('sequential')
        const retained = yield* service
          .retainThreadTarget(threadId)
          .pipe(Effect.provideService(Scope.Scope, leaseScope))
        expect(retained.outDir).toBe(first.outDir)

        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspaceRoot, 'entry.ts'), 'v2\n'),
        )
        const replacementFiber = yield* service
          .prepare({ threadId, workspaceRoot })
          .pipe(Effect.forkChild)
        yield* Deferred.await(secondPrepared)
        expect(replacementFiber.pollUnsafe()).toBeUndefined()

        yield* Scope.close(leaseScope, Exit.void)
        const replacement = yield* Fiber.join(replacementFiber)
        expect(replacement.outDir).not.toBe(first.outDir)
        expect(yield* Effect.promise(() => NodeFSP.stat(first.outDir).catch(() => null))).toBeNull()
        expect((yield* Effect.promise(() => NodeFSP.stat(replacement.graphPath))).isFile()).toBe(
          true,
        )
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(replacement.outDir, 'graph.db')).catch(() => null),
          ),
        ).toBeNull()

        yield* service.closeThread(threadId)
        expect(
          yield* Effect.promise(() => NodeFSP.stat(replacement.outDir).catch(() => null)),
        ).toBeNull()
        const closed = yield* service.prepare({ threadId, workspaceRoot }).pipe(Effect.flip)
        expect(closed.failure).toBe('context_start_failed')
      }),
    ),
  )

  it.effect('cancels and fences an older overlapping preparation', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-current-architecture-overlap-state-'),
        )
        const workspaceRoot = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-current-architecture-overlap-workspace-'),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all([
              NodeFSP.rm(stateDir, { recursive: true, force: true }),
              NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            ]),
          ).pipe(Effect.asVoid),
        )
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspaceRoot, 'entry.ts'), 'overlap\n'),
        )
        yield* Effect.sync(() => initializeRepository(workspaceRoot))

        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        let firstSignal: AbortSignal | undefined
        let preparations = 0
        const service = yield* make({
          stateDir,
          reaperIntervalMs: 0,
          disposeArchitectureArtifacts: async () => undefined,
          analyzer: {
            prepareCurrentWorktree: ({ outDir, signal }) =>
              Effect.gen(function* ()
              {
                preparations += 1
                if (preparations === 1)
                {
                  firstSignal = signal
                  yield* Deferred.succeed(firstStarted, undefined)
                  yield* Deferred.await(releaseFirst)
                }
                yield* Effect.promise(() => writePreparedArtifacts(outDir))
              }),
          },
        })
        yield* Effect.addFinalizer(() => service.closeAll)

        const firstFiber = yield* service
          .prepare({ threadId, workspaceRoot })
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const secondFiber = yield* service
          .prepare({ threadId, workspaceRoot })
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(firstSignal?.aborted).toBe(true)
        yield* Deferred.succeed(releaseFirst, undefined)
        const firstExit = yield* Fiber.await(firstFiber)
        const replacement = yield* Fiber.join(secondFiber)
        const retained = yield* service.retainThreadTarget(threadId)

        expect(Exit.isFailure(firstExit)).toBe(true)
        expect(preparations).toBe(2)
        expect(retained.outDir).toBe(replacement.outDir)
      }),
    ),
  )

  it.effect('expires an idle prepared target without marking the thread deleted', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-current-architecture-expiry-state-'),
        )
        const workspaceRoot = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-current-architecture-expiry-workspace-'),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all([
              NodeFSP.rm(stateDir, { recursive: true, force: true }),
              NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            ]),
          ).pipe(Effect.asVoid),
        )
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspaceRoot, 'entry.ts'), 'v1\n'),
        )
        yield* Effect.sync(() => initializeRepository(workspaceRoot))

        let now = 0
        let disposalAttempts = 0
        const service = yield* make({
          stateDir,
          reaperIntervalMs: 0,
          idleTtlMs: 10,
          clock: Effect.sync(() => now),
          disposeArchitectureArtifacts: async () =>
          {
            disposalAttempts += 1
            if (disposalAttempts === 1) throw new Error('expected disposal failure')
          },
          analyzer: {
            prepareCurrentWorktree: ({ outDir }) =>
              Effect.promise(() => writePreparedArtifacts(outDir)),
          },
        })
        yield* Effect.addFinalizer(() => service.closeAll)
        const first = yield* service.prepare({ threadId, workspaceRoot })
        now = 11
        expect(yield* service.reapExpired).toBe(1)
        expect(disposalAttempts).toBe(1)
        expect(yield* Effect.promise(() => NodeFSP.stat(first.outDir).catch(() => null))).toBeNull()
        const replacement = yield* service.prepare({ threadId, workspaceRoot })
        expect((yield* Effect.promise(() => NodeFSP.stat(replacement.graphPath))).isFile()).toBe(
          true,
        )
      }),
    ),
  )

  it.effect('sweeps aged current and legacy targets without deleting fresh directories', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const stateDir = yield* Effect.promise(() =>
          makeTemporaryRoot('456code-current-architecture-orphan-state-'),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(stateDir, { recursive: true, force: true })),
        )
        const now = Date.UTC(2026, 7, 9, 12)
        const currentRoot = NodePath.join(stateDir, 'cartographer', 'current-worktrees')
        const legacyRoot = NodePath.join(stateDir, 'cartographer', 'contexts')
        const oldCurrent = NodePath.join(currentRoot, 'a'.repeat(24))
        const freshCurrent = NodePath.join(currentRoot, 'b'.repeat(24))
        const oldLegacy = NodePath.join(legacyRoot, 'c'.repeat(24))
        const freshLegacy = NodePath.join(legacyRoot, 'd'.repeat(24))
        yield* Effect.promise(async () =>
        {
          await Promise.all(
            [oldCurrent, freshCurrent, oldLegacy, freshLegacy].map((path) =>
              NodeFSP.mkdir(path, { recursive: true }),
            ),
          )
          const oldStamp = (now - 24 * 60 * 60 * 1_000 - 1) / 1_000
          await Promise.all([
            NodeFSP.utimes(oldCurrent, oldStamp, oldStamp),
            NodeFSP.utimes(oldLegacy, oldStamp, oldStamp),
          ])
        })

        const service = yield* make({
          stateDir,
          now: () => now,
          reaperIntervalMs: 0,
          disposeArchitectureArtifacts: async () => undefined,
          analyzer: { prepareCurrentWorktree: () => Effect.void },
        })
        yield* Effect.addFinalizer(() => service.closeAll)

        expect(yield* Effect.promise(() => NodeFSP.stat(oldCurrent).catch(() => null))).toBeNull()
        expect(yield* Effect.promise(() => NodeFSP.stat(oldLegacy).catch(() => null))).toBeNull()
        expect((yield* Effect.promise(() => NodeFSP.stat(freshCurrent))).isDirectory()).toBe(true)
        expect((yield* Effect.promise(() => NodeFSP.stat(freshLegacy))).isDirectory()).toBe(true)
      }),
    ),
  )
})
