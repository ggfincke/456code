// tests/apps/server/cartographer/CurrentWorktreeSnapshot.test.ts
// verifies exact isolated and cancellable current-worktree snapshots

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodePerfHooks from 'node:perf_hooks'
import * as NodeTimersPromises from 'node:timers/promises'
import * as NodeUtil from 'node:util'

import { it } from '@effect/vitest'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect } from 'vite-plus/test'

import { captureCurrentWorktree } from '../../../../apps/server/src/cartographer/CurrentWorktreeSnapshot.ts'

const execFile = NodeUtil.promisify(NodeChildProcess.execFile)
const temporaryRoots = new Set<string>()

async function makeTemporaryRoot(prefix: string): Promise<string>
{
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))
  temporaryRoots.add(root)
  return root
}

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string>
{
  const result = await execFile('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return result.stdout.trim()
}

async function gitBytes(cwd: string, args: ReadonlyArray<string>): Promise<Buffer>
{
  return await new Promise((resolve, reject) =>
  {
    NodeChildProcess.execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'buffer',
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) =>
      {
        if (error)
        {
          reject(error)
        }
        else
        {
          resolve(stdout)
        }
      },
    )
  })
}

async function initializeRepository(): Promise<string>
{
  const workspaceRoot = await makeTemporaryRoot('456code-current-snapshot-workspace-')
  await git(workspaceRoot, ['init'])
  await git(workspaceRoot, ['config', 'user.email', 'snapshot-test@example.com'])
  await git(workspaceRoot, ['config', 'user.name', 'Snapshot Test'])
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, '.gitattributes'), '*.txt text eol=crlf\n')
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, '.gitignore'), 'ignored.txt\n')
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, 'tracked.txt'), 'committed\n')
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, 'executable.sh'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  })
  await NodeFSP.symlink('tracked.txt', NodePath.join(workspaceRoot, 'tracked-link'))
  await git(workspaceRoot, ['add', '.'])
  await git(workspaceRoot, ['commit', '-m', 'initial'])
  return workspaceRoot
}

async function waitForPath(path: string): Promise<void>
{
  const deadline = NodePerfHooks.performance.now() + 5_000
  while (NodePerfHooks.performance.now() < deadline)
  {
    const exists = await NodeFSP.access(path).then(
      () => true,
      () => false,
    )
    if (exists) return
    await NodeTimersPromises.setTimeout(10)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function useEnvironment(values: Readonly<Record<string, string>>)
{
  return Effect.acquireRelease(
    Effect.sync(() =>
    {
      const previous = new Map<string, string | undefined>()
      for (const [name, value] of Object.entries(values))
      {
        previous.set(name, process.env[name])
        process.env[name] = value
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() =>
      {
        for (const [name, value] of previous)
        {
          if (value === undefined)
          {
            delete process.env[name]
          }
          else
          {
            process.env[name] = value
          }
        }
      }),
  )
}

afterEach(async () =>
{
  await Promise.all(
    [...temporaryRoots].map((root) =>
      NodeFSP.rm(root, { force: true, recursive: true }).catch(() => undefined),
    ),
  )
  temporaryRoots.clear()
})

describe('captureCurrentWorktree', () =>
{
  it.effect('captures raw tracked and untracked bytes without filters or user-index changes', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = yield* Effect.promise(initializeRepository)
      const artifactRoot = yield* Effect.promise(() =>
        makeTemporaryRoot('456code-current-snapshot-artifacts-'),
      )
      const canonicalArtifactRoot = yield* Effect.promise(() => NodeFSP.realpath(artifactRoot))

      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspaceRoot, 'tracked.txt'), 'staged\n'),
      )
      yield* Effect.promise(() => git(workspaceRoot, ['add', 'tracked.txt']))
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspaceRoot, 'tracked.txt'), 'captured\n'),
      )
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspaceRoot, 'untracked.txt'), 'untracked captured\n'),
      )
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspaceRoot, 'ignored.txt'), 'must stay ignored\n'),
      )
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(workspaceRoot, 'executable.sh'),
          '#!/bin/sh\necho captured\n',
          { mode: 0o755 },
        ),
      )

      const indexPath = NodePath.join(workspaceRoot, '.git', 'index')
      const indexBefore = yield* Effect.promise(() => NodeFSP.readFile(indexPath))
      const controller = new AbortController()
      const snapshot = yield* captureCurrentWorktree({
        workspaceRoot,
        artifactRoot,
        signal: controller.signal,
      })
      const indexAfter = yield* Effect.promise(() => NodeFSP.readFile(indexPath))

      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspaceRoot, 'tracked.txt'), 'later mutation\n'),
      )
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspaceRoot, 'untracked.txt'), 'later mutation\n'),
      )
      yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(workspaceRoot, 'tracked-link')))
      yield* Effect.promise(() =>
        NodeFSP.symlink('untracked.txt', NodePath.join(workspaceRoot, 'tracked-link')),
      )

      const capturedTracked = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(snapshot.rootPath, 'tracked.txt')),
      )
      const retainedTracked = yield* Effect.promise(() =>
        gitBytes(workspaceRoot, ['cat-file', 'blob', `${snapshot.treeOid}:tracked.txt`]),
      )
      const capturedUntracked = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(snapshot.rootPath, 'untracked.txt'), 'utf8'),
      )
      const capturedLink = yield* Effect.promise(() =>
        NodeFSP.readlink(NodePath.join(snapshot.rootPath, 'tracked-link')),
      )
      const ignoredMissing = yield* Effect.promise(() =>
        NodeFSP.access(NodePath.join(snapshot.rootPath, 'ignored.txt')).then(
          () => false,
          () => true,
        ),
      )
      const executableMode = (yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(snapshot.rootPath, 'executable.sh')),
      )).mode
      const artifacts = yield* Effect.promise(() => NodeFSP.readdir(artifactRoot))

      expect(capturedTracked).toEqual(Buffer.from('captured\n'))
      expect(capturedTracked).toEqual(retainedTracked)
      expect(capturedUntracked).toBe('untracked captured\n')
      expect(capturedLink).toBe('tracked.txt')
      expect(ignoredMissing).toBe(true)
      expect(executableMode & 0o111).not.toBe(0)
      expect(indexAfter).toEqual(indexBefore)
      expect(snapshot.entryCount).toBe(6)
      expect(snapshot.byteCount).toBeGreaterThan(0)
      expect(snapshot.rootPath.startsWith(`${canonicalArtifactRoot}${NodePath.sep}`)).toBe(true)
      expect(snapshot.treeOid).toMatch(/^[0-9a-f]{40,64}$/u)
      expect(artifacts).not.toEqual(expect.arrayContaining([expect.stringContaining('index')]))
    }),
  )

  it.effect('cancels an in-flight Git capture and removes its temporary index', () =>
    Effect.gen(function* ()
    {
      if ((yield* HostProcessPlatform) === 'win32') return

      const workspaceRoot = yield* Effect.promise(initializeRepository)
      const artifactRoot = yield* Effect.promise(() =>
        makeTemporaryRoot('456code-current-snapshot-cancel-artifacts-'),
      )
      const wrapperRoot = yield* Effect.promise(() =>
        makeTemporaryRoot('456code-current-snapshot-git-wrapper-'),
      )
      const markerPath = NodePath.join(wrapperRoot, 'fast-import-started')
      const gitPath = yield* Effect.promise(async () =>
        (
          await execFile('which', ['git'], {
            encoding: 'utf8',
          })
        ).stdout.trim(),
      )
      const wrapperPath = NodePath.join(wrapperRoot, 'git')
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          wrapperPath,
          [
            '#!/bin/sh',
            'if [ "$3" = "fast-import" ]; then',
            '  : > "$T3_SNAPSHOT_MARKER"',
            '  exec sleep 60',
            'fi',
            'exec "$T3_SNAPSHOT_REAL_GIT" "$@"',
            '',
          ].join('\n'),
          { mode: 0o755 },
        ),
      )
      yield* useEnvironment({
        PATH: `${wrapperRoot}${NodePath.delimiter}${process.env.PATH ?? ''}`,
        T3_SNAPSHOT_REAL_GIT: gitPath,
        T3_SNAPSHOT_MARKER: markerPath,
      })

      const controller = new AbortController()
      const captureFiber = yield* captureCurrentWorktree({
        workspaceRoot,
        artifactRoot,
        signal: controller.signal,
      }).pipe(Effect.forkScoped)
      yield* Effect.promise(() => waitForPath(markerPath))
      controller.abort()

      const error = yield* Fiber.join(captureFiber).pipe(Effect.flip)
      const artifacts = yield* Effect.promise(() => NodeFSP.readdir(artifactRoot))
      expect(error).toMatchObject({
        _tag: 'CartographerEmbedError',
        failure: 'start_failed',
        message: 'Cartographer current-worktree capture was cancelled.',
      })
      expect(artifacts).toEqual([])
    }),
  )
})
