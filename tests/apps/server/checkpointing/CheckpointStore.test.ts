// tests/apps/server/checkpointing/CheckpointStore.test.ts
// verifies checkpoint capture and exact diff behavior across VCS drivers

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import { ThreadId, type VcsError } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as Scope from 'effect/Scope'
import { describe, expect } from 'vite-plus/test'

import { checkpointRefForThreadTurn } from '../../../../apps/server/src/checkpointing/Utils.ts'
import * as CheckpointStore from '../../../../apps/server/src/checkpointing/CheckpointStore.ts'
import * as VcsDriverRegistry from '../../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../../../../apps/server/src/vcs/VcsProcess.ts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: 't3-checkpoint-store-test-',
})
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer))
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
)
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
)

function makeTmpDir(
  prefix = 'checkpoint-store-test-',
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope>
{
  return Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.makeTempDirectoryScoped({ prefix })
  })
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>
{
  return Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.writeFileString(filePath, contents)
  })
}

function writeBytes(
  filePath: string,
  contents: Uint8Array,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>
{
  return Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.writeFile(filePath, contents)
  })
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess>
{
  return Effect.gen(function* ()
  {
    const process = yield* VcsProcess.VcsProcess
    const result = yield* process.run({
      operation: 'CheckpointStore.test.git',
      command: 'git',
      cwd,
      args,
      timeoutMs: 10_000,
    })
    return result.stdout.trim()
  })
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
>
{
  return Effect.gen(function* ()
  {
    yield* git(cwd, ['init'])
    yield* git(cwd, ['config', 'user.email', 'test@test.com'])
    yield* git(cwd, ['config', 'user.name', 'Test'])
    yield* writeTextFile(NodePath.join(cwd, 'README.md'), '# test\n')
    yield* git(cwd, ['add', '.'])
    yield* git(cwd, ['commit', '-m', 'initial commit'])
  })
}

function buildLargeText(lineCount = 5_000): string
{
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, '0')}`)
    .join('\n')
    .concat('\n')
}

it.layer(TestLayer)('CheckpointStore.layer', (it) =>
{
  describe('isGitRepository', () =>
  {
    it.effect('returns false when no Git repository is detected', () =>
      Effect.gen(function* ()
      {
        const tmp = yield* makeTmpDir()
        const checkpointStore = yield* CheckpointStore.CheckpointStore

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false)
      }),
    )

    it.effect('returns true when a Git repository is detected', () =>
      Effect.gen(function* ()
      {
        const tmp = yield* makeTmpDir()
        yield* initRepoWithCommit(tmp)
        const checkpointStore = yield* CheckpointStore.CheckpointStore

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true)
      }),
    )
  })

  describe('captureCheckpoint', () =>
  {
    it.effect('keeps the winning ref when a stale expected-absent capture loses the CAS', () =>
      Effect.gen(function* ()
      {
        const tmp = yield* makeTmpDir()
        yield* initRepoWithCommit(tmp)
        const checkpointStore = yield* CheckpointStore.CheckpointStore
        const checkpointRef = checkpointRefForThreadTurn(ThreadId.make('thread-checkpoint-cas'), 0)

        yield* writeTextFile(NodePath.join(tmp, 'README.md'), 'winning baseline\n')
        const winner = yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef,
          expected: { kind: 'absent' },
        })
        expect(winner.outcome).toBe('published')

        yield* writeTextFile(NodePath.join(tmp, 'README.md'), 'stale contender\n')
        const stale = yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef,
          expected: { kind: 'absent' },
        })

        expect(stale.outcome).toBe('lost-race')
        expect(yield* git(tmp, ['rev-parse', checkpointRef])).toBe(winner.commitOid)
        expect(yield* git(tmp, ['show', `${checkpointRef}:README.md`])).toBe('winning baseline')
      }),
    )

    it.effect('captures raw working-tree bytes without invoking required Git filters', () =>
      Effect.gen(function* ()
      {
        const tmp = yield* makeTmpDir()
        yield* initRepoWithCommit(tmp)
        const checkpointStore = yield* CheckpointStore.CheckpointStore
        const fileSystem = yield* FileSystem.FileSystem
        const filteredPath = NodePath.join(tmp, 'filtered.txt')

        yield* writeTextFile(
          NodePath.join(tmp, '.gitattributes'),
          'filtered.txt filter=sentinel text eol=crlf\n',
        )
        yield* writeTextFile(NodePath.join(tmp, '.gitignore'), 'preserved.ignored\n')
        yield* writeTextFile(filteredPath, 'committed\n')
        yield* git(tmp, ['add', '.gitattributes', '.gitignore', 'filtered.txt'])
        yield* git(tmp, ['commit', '-m', 'add filtered fixture'])
        yield* git(tmp, ['config', 'filter.sentinel.clean', 'false'])
        yield* git(tmp, ['config', 'filter.sentinel.smudge', 'false'])
        yield* git(tmp, ['config', 'filter.sentinel.required', 'true'])
        yield* writeBytes(filteredPath, Buffer.from('working\r\nbytes\r\n'))

        const indexPath = NodePath.join(tmp, '.git', 'index')
        const indexBefore = yield* fileSystem.readFile(indexPath)
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make('thread-checkpoint-raw-bytes'),
          1,
        )
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef,
        })

        expect(yield* git(tmp, ['rev-parse', `${checkpointRef}:filtered.txt`])).toBe(
          yield* git(tmp, ['hash-object', '--no-filters', 'filtered.txt']),
        )
        expect(yield* fileSystem.readFile(indexPath)).toEqual(indexBefore)

        yield* writeBytes(filteredPath, Buffer.from('later\r\nmutation\r\n'))
        yield* writeTextFile(NodePath.join(tmp, 'remove-me.txt'), 'untracked\n')
        yield* writeTextFile(NodePath.join(tmp, 'preserved.ignored'), 'ignored state\n')
        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(true)
        expect(yield* fileSystem.readFile(filteredPath)).toEqual(
          Buffer.from('working\r\nbytes\r\n'),
        )
        expect(yield* fileSystem.exists(NodePath.join(tmp, 'remove-me.txt'))).toBe(false)
        expect(yield* fileSystem.readFileString(NodePath.join(tmp, 'preserved.ignored'))).toBe(
          'ignored state\n',
        )
        expect(yield* git(tmp, ['diff', '--cached', '--no-ext-diff', '--no-textconv'])).toBe('')
      }),
    )
  })

  describe('restoreCheckpoint', () =>
  {
    it.effect('falls back to HEAD only when requested for a missing checkpoint', () =>
      Effect.gen(function* ()
      {
        const tmp = yield* makeTmpDir()
        yield* initRepoWithCommit(tmp)
        const checkpointStore = yield* CheckpointStore.CheckpointStore
        const fileSystem = yield* FileSystem.FileSystem
        const readmePath = NodePath.join(tmp, 'README.md')
        const untrackedPath = NodePath.join(tmp, 'untracked.txt')
        const missingCheckpointRef = checkpointRefForThreadTurn(
          ThreadId.make('thread-missing-checkpoint'),
          1,
        )

        yield* writeTextFile(readmePath, '# tracked mutation\n')
        yield* writeTextFile(untrackedPath, 'untracked mutation\n')

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: missingCheckpointRef,
            fallbackToHead: false,
          }),
        ).toBe(false)
        expect(yield* fileSystem.readFileString(readmePath)).toBe('# tracked mutation\n')

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: missingCheckpointRef,
            fallbackToHead: true,
          }),
        ).toBe(true)
        expect(yield* fileSystem.readFileString(readmePath)).toBe('# test\n')
        expect(yield* fileSystem.exists(untrackedPath)).toBe(false)
        expect(yield* git(tmp, ['status', '--porcelain'])).toBe('')
      }),
    )
  })

  describe('staged restore', () =>
  {
    it.effect(
      'stages, preflights without mutation, converges partial work, and detects corruption',
      () =>
        Effect.gen(function* ()
        {
          const tmp = yield* makeTmpDir('checkpoint-staged-worktree-')
          const stagePath = yield* makeTmpDir('checkpoint-staged-tree-')
          yield* initRepoWithCommit(tmp)
          const checkpointStore = yield* CheckpointStore.CheckpointStore
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.make('thread-checkpoint-staged'),
            1,
          )
          const readmePath = NodePath.join(tmp, 'README.md')
          const nestedPath = NodePath.join(tmp, 'nested', 'target.txt')
          yield* writeTextFile(readmePath, '# checkpoint target\n')
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.dirname(nestedPath), { recursive: true }),
          )
          yield* writeTextFile(nestedPath, 'nested checkpoint target\n')
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef })

          const staged = yield* checkpointStore.stageCheckpointTree({
            cwd: tmp,
            ref: checkpointRef,
            stagePath,
          })
          expect(staged.verified).toBe(true)
          expect(staged.fileCount).toBeGreaterThanOrEqual(2)
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(stagePath, 'README.md'), 'utf8'),
            ),
          ).toBe('# checkpoint target\n')

          yield* writeTextFile(readmePath, '# live mutation\n')
          yield* writeTextFile(NodePath.join(tmp, 'extra.txt'), 'remove during restore\n')
          const statusBefore = yield* git(tmp, ['status', '--porcelain=v1'])
          const readmeBefore = yield* Effect.promise(() => NodeFSP.readFile(readmePath, 'utf8'))
          const preflight = yield* checkpointStore.verifyRestorePreconditions({
            cwd: tmp,
            ref: checkpointRef,
          })
          expect(preflight.fileCount).toBe(staged.fileCount)
          expect(yield* git(tmp, ['status', '--porcelain=v1'])).toBe(statusBefore)
          expect(yield* Effect.promise(() => NodeFSP.readFile(readmePath, 'utf8'))).toBe(
            readmeBefore,
          )

          yield* Effect.promise(() => NodeFSP.rm(readmePath))
          const stagedNested = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(stagePath, 'nested', 'target.txt')),
          )
          yield* Effect.promise(() => NodeFSP.writeFile(nestedPath, stagedNested))
          yield* checkpointStore.applyStagedRestore({
            cwd: tmp,
            ref: checkpointRef,
            stagePath,
          })
          const verified = yield* checkpointStore.postVerifyRestore({
            cwd: tmp,
            ref: checkpointRef,
          })
          expect(verified.verified).toBe(true)
          expect(yield* Effect.promise(() => NodeFSP.readFile(readmePath, 'utf8'))).toBe(
            '# checkpoint target\n',
          )
          const fileSystem = yield* FileSystem.FileSystem
          expect(yield* fileSystem.exists(NodePath.join(tmp, 'extra.txt'))).toBe(false)

          yield* Effect.promise(() => NodeFSP.writeFile(readmePath, '# corrupted after restore\n'))
          const corrupted = yield* Effect.result(
            checkpointStore.postVerifyRestore({ cwd: tmp, ref: checkpointRef }),
          )
          expect(corrupted._tag).toBe('Failure')
        }),
    )
  })

  describe('diffCheckpoints', () =>
  {
    it.effect('returns full oversized checkpoint diffs without truncation', () =>
      Effect.gen(function* ()
      {
        const tmp = yield* makeTmpDir()
        yield* initRepoWithCommit(tmp)
        const checkpointStore = yield* CheckpointStore.CheckpointStore
        const threadId = ThreadId.make('thread-checkpoint-store')
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0)
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1)

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        })
        yield* writeTextFile(NodePath.join(tmp, 'README.md'), buildLargeText())
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        })

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        })

        expect(diff).toContain('diff --git')
        expect(diff).not.toContain('[truncated]')
        expect(diff).toContain('+line 04999')
      }),
    )

    it.effect('can hide indentation churn when changes wrap existing lines', () =>
      Effect.gen(function* ()
      {
        const tmp = yield* makeTmpDir()
        yield* initRepoWithCommit(tmp)
        const checkpointStore = yield* CheckpointStore.CheckpointStore
        const threadId = ThreadId.make('thread-checkpoint-store-whitespace')
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0)
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1)

        const componentPath = NodePath.join(tmp, 'Component.tsx')
        yield* writeTextFile(
          componentPath,
          [
            'export function View() {',
            '  return (',
            '    <section>',
            '      <h1>Title</h1>',
            '      <p>Body</p>',
            '    </section>',
            '  );',
            '}',
            '',
          ].join('\n'),
        )
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        })
        yield* writeTextFile(
          componentPath,
          [
            'export function View() {',
            '  return (',
            '    <section>',
            '      {isReady ? (',
            '        <div>',
            '          <h1>Title</h1>',
            '          <p>Body</p>',
            '        </div>',
            '      ) : null}',
            '    </section>',
            '  );',
            '}',
            '',
          ].join('\n'),
        )
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        })

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        })
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        })

        expect(normalDiff).toContain('diff --git')
        expect(normalDiff).toContain('-      <h1>Title</h1>')
        expect(normalDiff).toContain('+          <h1>Title</h1>')
        expect(whitespaceIgnoredDiff).toContain('diff --git')
        expect(whitespaceIgnoredDiff).toContain('+      {isReady ? (')
        expect(whitespaceIgnoredDiff).toContain('+        <div>')
        expect(whitespaceIgnoredDiff).not.toContain('-      <h1>Title</h1>')
        expect(whitespaceIgnoredDiff).not.toContain('+          <h1>Title</h1>')
      }),
    )
  })
})
