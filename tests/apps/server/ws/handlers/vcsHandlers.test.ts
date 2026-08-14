// tests/apps/server/ws/handlers/vcsHandlers.test.ts
// verifies worktree removal compensates exact availability across every failure cause

import { GitCommandError, type OrchestrateRunExecution, ThreadId, TurnId } from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Path from 'effect/Path'
import { expect } from 'vite-plus/test'

import {
  removeWorktreeWithRunExecutionAvailability,
  resolveCanonicalRunExecutionWorktreePermitPath,
} from '../../../../../apps/server/src/ws/handlers/vcsHandlers.ts'
import { withOrchestrateRunWorktreePermit } from '../../../../../apps/server/src/orchestration/runExecutionAvailability.ts'

const execution: OrchestrateRunExecution = {
  threadId: ThreadId.make('thread-removal-failure'),
  runId: 'run-removal-failure',
  planRevision: 1,
  sourceTurnId: TurnId.make('turn-removal-failure'),
  sourceSequence: 10,
  repositoryRoot: '/repo',
  repositoryCommonDir: '/repo/.git',
  baseOid: 'base-oid',
  lifecycle: 'completed',
  availability: 'available',
  integrationRoot: '/repo/worktrees/run',
  integrationCommonDir: '/repo/.git',
  integrationBranch: 'run',
  integrationOid: 'head-oid',
  observedHeadOid: 'head-oid',
  finalHeadOid: 'head-oid',
  closeReason: 'Completed.',
  current: true,
  admittedAt: '2026-08-09T04:00:00.000Z',
  updatedAt: '2026-08-09T04:01:00.000Z',
  terminalAt: '2026-08-09T04:01:00.000Z',
  jobs: [],
}

const resolveCanonicalWorktreePath = () => Effect.succeed('/repo/worktrees/run')

it.effect('compensates retirement before returning an ordinary Git removal failure', () =>
  Effect.gen(function* ()
  {
    const order: string[] = []
    const removeError = new GitCommandError({
      operation: 'vcs.removeWorktree',
      command: 'git worktree remove',
      cwd: '/repo',
      detail: 'worktree contains uncommitted changes',
    })

    const error = yield* removeWorktreeWithRunExecutionAvailability(
      { cwd: '/repo', path: '/repo/worktrees/run' },
      {
        resolveRunExecutionWorktreePermitPath: resolveCanonicalWorktreePath,
        retireRunExecutionWorktreeAvailability: () =>
          Effect.sync(() =>
          {
            order.push('retire')
            return [execution]
          }),
        removeWorktree: () =>
          Effect.sync(() => order.push('remove')).pipe(Effect.andThen(Effect.fail(removeError))),
        verifyRunExecutionWorktreePresent: (_input, retired) =>
          Effect.sync(() =>
          {
            expect(retired).toEqual([execution])
            order.push('verify')
            return true
          }),
        restoreRunExecutionWorktreeAvailability: (retired) =>
          Effect.sync(() =>
          {
            expect(retired).toEqual([execution])
            order.push('restore')
          }),
      },
    ).pipe(Effect.flip)

    expect(error).toBe(removeError)
    expect(order).toEqual(['retire', 'remove', 'verify', 'restore'])
  }),
)

it.effect('compensates retirement when an interrupt leaves the verified worktree present', () =>
  Effect.gen(function* ()
  {
    const order: string[] = []
    const exit = yield* removeWorktreeWithRunExecutionAvailability(
      { cwd: '/repo', path: '/repo/worktrees/run' },
      {
        resolveRunExecutionWorktreePermitPath: resolveCanonicalWorktreePath,
        retireRunExecutionWorktreeAvailability: () =>
          Effect.sync(() =>
          {
            order.push('retire')
            return [execution]
          }),
        removeWorktree: () =>
          Effect.sync(() => order.push('remove')).pipe(Effect.andThen(Effect.interrupt)),
        verifyRunExecutionWorktreePresent: () =>
          Effect.sync(() =>
          {
            order.push('verify')
            return true
          }),
        restoreRunExecutionWorktreeAvailability: () => Effect.sync(() => order.push('restore')),
      },
    ).pipe(Effect.exit)

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(order).toEqual(['retire', 'remove', 'verify', 'restore'])
  }),
)

it.effect('compensates retirement when a defect leaves the verified worktree present', () =>
  Effect.gen(function* ()
  {
    const order: string[] = []
    const exit = yield* removeWorktreeWithRunExecutionAvailability(
      { cwd: '/repo', path: '/repo/worktrees/run' },
      {
        resolveRunExecutionWorktreePermitPath: resolveCanonicalWorktreePath,
        retireRunExecutionWorktreeAvailability: () =>
          Effect.sync(() =>
          {
            order.push('retire')
            return [execution]
          }),
        removeWorktree: () =>
          Effect.sync(() => order.push('remove')).pipe(
            Effect.andThen(Effect.die(new Error('simulated removal defect'))),
          ),
        verifyRunExecutionWorktreePresent: () =>
          Effect.sync(() =>
          {
            order.push('verify')
            return true
          }),
        restoreRunExecutionWorktreeAvailability: () => Effect.sync(() => order.push('restore')),
      },
    ).pipe(Effect.exit)

    expect(Exit.hasDies(exit)).toBe(true)
    expect(order).toEqual(['retire', 'remove', 'verify', 'restore'])
  }),
)

it.effect('does not compensate a defect after the worktree was actually removed', () =>
  Effect.gen(function* ()
  {
    const order: string[] = []
    let worktreePresent = true
    const exit = yield* removeWorktreeWithRunExecutionAvailability(
      { cwd: '/repo', path: '/repo/worktrees/run' },
      {
        resolveRunExecutionWorktreePermitPath: resolveCanonicalWorktreePath,
        retireRunExecutionWorktreeAvailability: () =>
          Effect.sync(() =>
          {
            order.push('retire')
            return [execution]
          }),
        removeWorktree: () =>
          Effect.sync(() =>
          {
            order.push('remove')
            worktreePresent = false
          }).pipe(Effect.andThen(Effect.die(new Error('post-removal defect')))),
        verifyRunExecutionWorktreePresent: () =>
          Effect.sync(() =>
          {
            order.push('verify')
            return worktreePresent
          }),
        restoreRunExecutionWorktreeAvailability: () => Effect.sync(() => order.push('restore')),
      },
    ).pipe(Effect.exit)

    expect(Exit.hasDies(exit)).toBe(true)
    expect(order).toEqual(['retire', 'remove', 'verify'])
  }),
)

it.effect('canonicalizes an aliased removal behind the exact execution permit', () =>
  Effect.gen(function* ()
  {
    const updateEntered = yield* Deferred.make<void>()
    const releaseUpdate = yield* Deferred.make<void>()
    const order: string[] = []
    const updateFiber = yield* withOrchestrateRunWorktreePermit(
      '/repo/worktrees/run',
      Effect.gen(function* ()
      {
        order.push('update-enter')
        yield* Deferred.succeed(updateEntered, undefined)
        yield* Deferred.await(releaseUpdate)
        order.push('update-exit')
      }),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(updateEntered)
    const removalFiber = yield* removeWorktreeWithRunExecutionAvailability(
      { cwd: '/repo', path: '/repo/worktrees/run-alias' },
      {
        resolveRunExecutionWorktreePermitPath: (input) =>
          Effect.sync(() =>
          {
            expect(input.path).toBe('/repo/worktrees/run-alias')
            return '/repo/worktrees/run'
          }),
        retireRunExecutionWorktreeAvailability: (input) =>
          Effect.sync(() =>
          {
            expect(input.path).toBe('/repo/worktrees/run')
            order.push('retire')
            return []
          }),
        removeWorktree: (input) =>
          Effect.sync(() =>
          {
            expect(input.path).toBe('/repo/worktrees/run')
            order.push('remove')
          }),
        verifyRunExecutionWorktreePresent: () => Effect.succeed(false),
        restoreRunExecutionWorktreeAvailability: () => Effect.void,
      },
    ).pipe(Effect.forkChild)

    yield* Effect.yieldNow
    expect(order).toEqual(['update-enter'])
    yield* Deferred.succeed(releaseUpdate, undefined)
    yield* Fiber.join(updateFiber)
    yield* Fiber.join(removalFiber)
    expect(order).toEqual(['update-enter', 'update-exit', 'retire', 'remove'])
  }),
)

it.effect('canonicalizes a missing forced-removal path through its existing parent', () =>
  Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: '456code-worktree-permit-',
    })
    const canonicalParent = path.join(root, 'canonical')
    const aliasedParent = path.join(root, 'alias')
    yield* fileSystem.makeDirectory(canonicalParent)
    yield* fileSystem.symlink(canonicalParent, aliasedParent)
    const canonicalParentRealPath = yield* fileSystem.realPath(canonicalParent)

    const resolved = yield* resolveCanonicalRunExecutionWorktreePermitPath(
      {
        cwd: root,
        path: path.join(aliasedParent, 'removed', 'worktree'),
        force: true,
      },
      { fileSystem, path },
    )

    expect(resolved).toBe(path.join(canonicalParentRealPath, 'removed', 'worktree'))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
