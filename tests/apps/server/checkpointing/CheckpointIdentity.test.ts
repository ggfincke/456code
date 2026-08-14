// tests/apps/server/checkpointing/CheckpointIdentity.test.ts
// verifies capture-time repository identity for checkpoint reads and restores

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import { CheckpointRef } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as Scope from 'effect/Scope'
import { expect } from 'vite-plus/test'

import * as CheckpointIdentity from '../../../../apps/server/src/checkpointing/CheckpointIdentity.ts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as GitVcsDriver from '../../../../apps/server/src/vcs/GitVcsDriver.ts'
import * as VcsProcess from '../../../../apps/server/src/vcs/VcsProcess.ts'

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: 't3-checkpoint-identity-test-',
})
const TestLayer = CheckpointIdentity.layer.pipe(
  Layer.provide(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
)
const layer = it.layer(TestLayer)

function runGit(cwd: string, args: ReadonlyArray<string>): string
{
  return NodeChildProcess.execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim()
}

function initializeRepository(cwd: string, contents = 'initial\n'): string
{
  NodeFS.mkdirSync(cwd, { recursive: true })
  runGit(cwd, ['init', '--initial-branch=main'])
  runGit(cwd, ['config', 'user.email', 'checkpoint@example.com'])
  runGit(cwd, ['config', 'user.name', 'Checkpoint Test'])
  return commitFile(cwd, contents, 'Initial')
}

function commitFile(cwd: string, contents: string, message: string): string
{
  NodeFS.writeFileSync(NodePath.join(cwd, 'README.md'), contents, 'utf8')
  runGit(cwd, ['add', 'README.md'])
  runGit(cwd, ['commit', '-m', message])
  return runGit(cwd, ['rev-parse', 'HEAD'])
}

function publishCheckpoint(cwd: string, checkpointRef: CheckpointRef, commitOid: string): void
{
  runGit(cwd, ['update-ref', checkpointRef, commitOid])
}

function makeFixtureRoot(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
>
{
  return Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: 'checkpoint-identity-' })
  })
}

layer('CheckpointIdentityResolver', (it) =>
{
  it.effect('captures canonical turn-zero identity and admits the exact selected root', () =>
    Effect.gen(function* ()
    {
      const fixtureRoot = yield* makeFixtureRoot()
      const repositoryRoot = NodePath.join(fixtureRoot, 'repository')
      const commitOid = initializeRepository(repositoryRoot)
      const checkpointRef = CheckpointRef.make('refs/t3/checkpoint/thread/0')
      publishCheckpoint(repositoryRoot, checkpointRef, commitOid)
      const alias = NodePath.join(fixtureRoot, 'repository-alias')
      NodeFS.symlinkSync(repositoryRoot, alias, 'dir')
      NodeFS.mkdirSync(NodePath.join(repositoryRoot, 'nested'))

      const resolver = yield* CheckpointIdentity.CheckpointIdentityResolver
      const captured = yield* resolver.resolveCapture({
        cwd: NodePath.join(alias, 'nested'),
        checkpointRef,
        checkpointTurnCount: 0,
        expectedCommitOid: commitOid,
      })
      const restore = yield* resolver.resolveDestructive({
        record: captured,
        restoreRoot: alias,
      })

      expect(captured).toMatchObject({
        cwd: NodeFS.realpathSync(repositoryRoot),
        checkpointTurnCount: 0,
        checkpointCaptureRoot: NodeFS.realpathSync(repositoryRoot),
        checkpointCommitOid: commitOid,
        legacyMode: 'none',
      })
      expect(captured.checkpointRepositoryCommonDir).toBe(
        NodeFS.realpathSync(NodePath.join(repositoryRoot, '.git')),
      )
      expect(restore.cwd).toBe(NodeFS.realpathSync(repositoryRoot))
      expect(restore.checkpointCommitOid).toBe(commitOid)
    }),
  )

  it.effect('reads through a surviving sibling worktree and rejects a cross-repository range', () =>
    Effect.gen(function* ()
    {
      const fixtureRoot = yield* makeFixtureRoot()
      const repositoryRoot = NodePath.join(fixtureRoot, 'repository')
      const captureWorktree = NodePath.join(fixtureRoot, 'captured-worktree')
      const otherRepository = NodePath.join(fixtureRoot, 'other-repository')
      const commitOid = initializeRepository(repositoryRoot)
      const otherCommitOid = initializeRepository(otherRepository, 'other\n')
      runGit(repositoryRoot, ['branch', 'capture'])
      runGit(repositoryRoot, ['worktree', 'add', captureWorktree, 'capture'])
      const checkpointRef = CheckpointRef.make('refs/t3/checkpoint/thread/1')
      const otherCheckpointRef = CheckpointRef.make('refs/t3/checkpoint/other/1')
      publishCheckpoint(captureWorktree, checkpointRef, commitOid)
      publishCheckpoint(otherRepository, otherCheckpointRef, otherCommitOid)

      const resolver = yield* CheckpointIdentity.CheckpointIdentityResolver
      const captured = yield* resolver.resolveCapture({
        cwd: captureWorktree,
        checkpointRef,
        checkpointTurnCount: 1,
        expectedCommitOid: commitOid,
      })
      const other = yield* resolver.resolveCapture({
        cwd: otherRepository,
        checkpointRef: otherCheckpointRef,
        checkpointTurnCount: 1,
        expectedCommitOid: otherCommitOid,
      })
      runGit(repositoryRoot, ['worktree', 'remove', '--force', captureWorktree])

      const siblingRead = yield* resolver.resolveRead({
        record: captured,
        currentRoot: repositoryRoot,
      })
      const mismatch = yield* resolver
        .resolveReadRange({
          from: captured,
          to: other,
          currentRoot: repositoryRoot,
        })
        .pipe(Effect.flip)

      expect(siblingRead.cwd).toBe(NodeFS.realpathSync(repositoryRoot))
      expect(siblingRead.checkpointCommitOid).toBe(commitOid)
      expect(mismatch).toBeInstanceOf(CheckpointIdentity.CheckpointRepositoryMismatchError)
    }),
  )

  it.effect('rejects path reuse, moved refs, unavailable roots, and partial identity', () =>
    Effect.gen(function* ()
    {
      const fixtureRoot = yield* makeFixtureRoot()
      const reusedRoot = NodePath.join(fixtureRoot, 'reused')
      const checkpointRef = CheckpointRef.make('refs/t3/checkpoint/reused/1')
      const originalOid = initializeRepository(reusedRoot, 'original\n')
      publishCheckpoint(reusedRoot, checkpointRef, originalOid)

      const resolver = yield* CheckpointIdentity.CheckpointIdentityResolver
      const captured = yield* resolver.resolveCapture({
        cwd: reusedRoot,
        checkpointRef,
        checkpointTurnCount: 1,
        expectedCommitOid: originalOid,
      })
      NodeFS.rmSync(reusedRoot, { recursive: true, force: true })
      const replacementOid = initializeRepository(reusedRoot, 'replacement\n')
      publishCheckpoint(reusedRoot, checkpointRef, replacementOid)
      const reusedError = yield* resolver
        .resolveRead({ record: captured, currentRoot: reusedRoot })
        .pipe(Effect.flip)

      const movedRoot = NodePath.join(fixtureRoot, 'moved-ref')
      const firstOid = initializeRepository(movedRoot, 'first\n')
      publishCheckpoint(movedRoot, checkpointRef, firstOid)
      const movedCapture = yield* resolver.resolveCapture({
        cwd: movedRoot,
        checkpointRef,
        checkpointTurnCount: 1,
        expectedCommitOid: firstOid,
      })
      const secondOid = commitFile(movedRoot, 'second\n', 'Second')
      publishCheckpoint(movedRoot, checkpointRef, secondOid)
      const movedError = yield* resolver
        .resolveRead({ record: movedCapture, currentRoot: movedRoot })
        .pipe(Effect.flip)

      const unavailableRoot = NodePath.join(fixtureRoot, 'unavailable')
      const unavailableOid = initializeRepository(unavailableRoot)
      publishCheckpoint(unavailableRoot, checkpointRef, unavailableOid)
      const unavailableCapture = yield* resolver.resolveCapture({
        cwd: unavailableRoot,
        checkpointRef,
        checkpointTurnCount: 1,
      })
      NodeFS.rmSync(unavailableRoot, { recursive: true, force: true })
      const unavailableError = yield* resolver
        .resolveRead({ record: unavailableCapture, currentRoot: null })
        .pipe(Effect.flip)

      const incompleteError = yield* resolver
        .resolveRead({
          record: {
            checkpointRef,
            checkpointTurnCount: 1,
            checkpointCaptureRoot: null,
            checkpointRepositoryCommonDir: captured.checkpointRepositoryCommonDir,
            checkpointCommitOid: null,
          },
          currentRoot: reusedRoot,
        })
        .pipe(Effect.flip)

      expect(reusedError).toBeInstanceOf(CheckpointIdentity.CheckpointRefOidMismatchError)
      expect(movedError).toBeInstanceOf(CheckpointIdentity.CheckpointRefOidMismatchError)
      expect(unavailableError).toBeInstanceOf(
        CheckpointIdentity.CheckpointCaptureRootUnavailableError,
      )
      expect(incompleteError).toBeInstanceOf(
        CheckpointIdentity.CheckpointCaptureIdentityMissingError,
      )
    }),
  )

  it.effect('keeps both legacy modes read-only and refuses destructive restore', () =>
    Effect.gen(function* ()
    {
      const fixtureRoot = yield* makeFixtureRoot()
      const repositoryRoot = NodePath.join(fixtureRoot, 'repository')
      const commitOid = initializeRepository(repositoryRoot)
      const checkpointRef = CheckpointRef.make('refs/t3/checkpoint/legacy/1')
      publishCheckpoint(repositoryRoot, checkpointRef, commitOid)
      const resolver = yield* CheckpointIdentity.CheckpointIdentityResolver

      const nullRootRecord: CheckpointIdentity.RecordedCheckpointIdentity = {
        checkpointRef,
        checkpointTurnCount: 1,
        checkpointCaptureRoot: null,
        checkpointRepositoryCommonDir: null,
        checkpointCommitOid: null,
      }
      const preOidRecord: CheckpointIdentity.RecordedCheckpointIdentity = {
        ...nullRootRecord,
        checkpointCaptureRoot: repositoryRoot,
      }
      const nullRootRead = yield* resolver.resolveRead({
        record: nullRootRecord,
        currentRoot: repositoryRoot,
      })
      const preOidRead = yield* resolver.resolveRead({
        record: preOidRecord,
        currentRoot: repositoryRoot,
      })
      const nullRootRevert = yield* resolver
        .resolveDestructive({ record: nullRootRecord, restoreRoot: repositoryRoot })
        .pipe(Effect.flip)
      const preOidRevert = yield* resolver
        .resolveDestructive({ record: preOidRecord, restoreRoot: repositoryRoot })
        .pipe(Effect.flip)

      expect(nullRootRead).toMatchObject({
        checkpointCommitOid: commitOid,
        legacyMode: 'null-root',
      })
      expect(preOidRead).toMatchObject({
        checkpointCommitOid: commitOid,
        legacyMode: 'pre-oid',
      })
      expect(nullRootRevert).toMatchObject({
        _tag: 'CheckpointDestructiveLegacyRefusalError',
        legacyMode: 'null-root',
      })
      expect(preOidRevert).toMatchObject({
        _tag: 'CheckpointDestructiveLegacyRefusalError',
        legacyMode: 'pre-oid',
      })
    }),
  )
})
