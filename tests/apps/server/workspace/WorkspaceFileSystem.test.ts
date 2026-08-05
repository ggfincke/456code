// tests/apps/server/workspace/WorkspaceFileSystem.test.ts
// verifies contained workspace file reads, writes, and text validation

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from 'node:fs/promises'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it, describe, expect } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { afterEach, vi } from 'vite-plus/test'

import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as VcsDriverRegistry from '../../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../../../../apps/server/src/vcs/VcsProcess.ts'
import * as WorkspaceEntries from '../../../../apps/server/src/workspace/WorkspaceEntries.ts'
import * as WorkspaceFileSystem from '../../../../apps/server/src/workspace/WorkspaceFileSystem.ts'
import * as WorkspacePaths from '../../../../apps/server/src/workspace/WorkspacePaths.ts'

const openInterceptor = vi.hoisted(() => ({
  beforeOpen: null as null | ((path: string) => Promise<void>),
  afterFirstRead: null as null | ((path: string) => Promise<void>),
}))

vi.mock('node:fs/promises', async (importOriginal) =>
{
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) =>
    {
      const filePath = String(args[0])
      await openInterceptor.beforeOpen?.(filePath)
      const handle = await Reflect.apply(actual.open, actual, args)
      if (openInterceptor.afterFirstRead === null)
      {
        return handle
      }

      let firstRead = true
      return new Proxy(handle, {
        get(target, property)
        {
          if (property === 'read')
          {
            return async (...readArgs: Parameters<typeof target.read>) =>
            {
              const result = await Reflect.apply(target.read, target, readArgs)
              if (firstRead)
              {
                firstRead = false
                await openInterceptor.afterFirstRead?.(filePath)
              }
              return result
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }),
  }
})

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
)

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: 't3-workspace-files-test-',
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
)

const makeTempDir = Effect.gen(function* ()
{
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: 't3code-workspace-files-',
  })
})

const writeTextFile = Effect.fn('writeTextFile')(function* (
  cwd: string,
  relativePath: string,
  contents = '',
)
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absolutePath = path.join(cwd, relativePath)
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie)
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie)
})

afterEach(() =>
{
  openInterceptor.beforeOpen = null
  openInterceptor.afterFirstRead = null
  vi.clearAllMocks()
})

it.layer(TestLayer, { excludeTestServices: true })('WorkspaceFileSystemLive', (it) =>
{
  describe('readFile', () =>
  {
    it.effect('reads UTF-8 files relative to the workspace root', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const cwd = yield* makeTempDir
        yield* writeTextFile(cwd, 'src/index.ts', 'export const answer = 42;\n')

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: 'src/index.ts',
        })

        expect(result).toEqual({
          relativePath: 'src/index.ts',
          contents: 'export const answer = 42;\n',
          byteLength: 26,
          truncated: false,
        })
      }),
    )

    it.effect('rejects reads outside the workspace root', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const cwd = yield* makeTempDir

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: '../escape.md' })
          .pipe(Effect.flip)

        expect(error.message).toContain(
          'Workspace file path must be relative to the project root: ../escape.md',
        )
      }),
    )

    it.effect('rejects symlinks that resolve outside the workspace root', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        const outsideDir = yield* makeTempDir
        yield* writeTextFile(outsideDir, 'secret.txt', 'outside\n')
        yield* fileSystem.symlink(
          path.join(outsideDir, 'secret.txt'),
          path.join(cwd, 'linked-secret.txt'),
        )

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: 'linked-secret.txt' })
          .pipe(Effect.flip)
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd)
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, 'secret.txt'))

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError)
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: 'linked-secret.txt',
          resolvedWorkspaceRoot,
          resolvedPath,
        })
        expect('cause' in error).toBe(false)
      }),
    )

    it.effect('rejects directories without manufacturing an I/O cause', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        yield* fileSystem.makeDirectory(path.join(cwd, 'src'))

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: 'src' })
          .pipe(Effect.flip)
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, 'src'))

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError)
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: 'src',
          resolvedPath,
        })
        expect('cause' in error).toBe(false)
      }),
    )

    it.effect('rejects binary files without leaking their contents into the error', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        const absolutePath = path.join(cwd, 'asset.bin')
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]))

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: 'asset.bin' })
          .pipe(Effect.flip)
        const resolvedPath = yield* fileSystem.realPath(absolutePath)

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError)
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: 'asset.bin',
          resolvedPath,
        })
        expect('cause' in error).toBe(false)
        expect('contents' in error).toBe(false)
      }),
    )

    it.effect('rejects invalid UTF-8 without replacing malformed bytes', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        const absolutePath = path.join(cwd, 'malformed.md')
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x66, 0x6f, 0x80]))

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: 'malformed.md' })
          .pipe(Effect.flip)
        const resolvedPath = yield* fileSystem.realPath(absolutePath)

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError)
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: 'malformed.md',
          resolvedPath,
        })
      }),
    )

    it.effect('returns a valid truncated prefix when the byte boundary splits UTF-8', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        const prefix = Buffer.alloc(1024 * 1024 - 1, 0x61)
        const contents = Buffer.concat([prefix, Buffer.from('💡')])
        yield* fileSystem.writeFile(path.join(cwd, 'large.mdx'), contents)

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: 'large.mdx',
        })

        expect(result.truncated).toBe(true)
        expect(result.byteLength).toBe(contents.byteLength)
        expect(Buffer.byteLength(result.contents)).toBe(prefix.byteLength)
        expect(result.contents).not.toContain('\uFFFD')
      }),
    )

    it.effect('rejects a target replaced with an outside symlink before open', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        const outsideDir = yield* makeTempDir
        const targetPath = path.join(cwd, 'inside.txt')
        const outsidePath = path.join(outsideDir, 'secret.txt')
        yield* fileSystem.writeFileString(targetPath, 'inside\n')
        yield* fileSystem.writeFileString(outsidePath, 'OUTSIDE_SENTINEL\n')
        const canonicalTargetPath = yield* Effect.promise(() => NodeFSP.realpath(targetPath))
        openInterceptor.beforeOpen = async (openedPath) =>
        {
          if (openedPath !== canonicalTargetPath) return
          openInterceptor.beforeOpen = null
          await NodeFSP.rename(canonicalTargetPath, `${canonicalTargetPath}.authorized`)
          await NodeFSP.symlink(outsidePath, canonicalTargetPath)
        }

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: 'inside.txt' })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError)
        if (error._tag !== 'WorkspaceFileSystemOperationError')
        {
          throw new Error('Expected a workspace file operation error.')
        }
        expect(['open', 'read']).toContain(error.operation)
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.stringify(error)).not.toContain('OUTSIDE_SENTINEL')
      }),
    )

    it.effect('rejects a file mutated while its open handle is being read', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        const targetPath = path.join(cwd, 'changing.txt')
        yield* fileSystem.writeFileString(targetPath, 'initial\n')
        const canonicalTargetPath = yield* Effect.promise(() => NodeFSP.realpath(targetPath))
        openInterceptor.afterFirstRead = async (openedPath) =>
        {
          if (openedPath !== canonicalTargetPath) return
          openInterceptor.afterFirstRead = null
          await NodeFSP.appendFile(canonicalTargetPath, 'changed\n')
        }

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: 'changing.txt' })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError)
        expect(error).toMatchObject({ operation: 'read' })
        expect(error.message).not.toContain('initial')
        expect(error.message).not.toContain('changed')
      }),
    )

    it.effect('preserves the real cause and path for I/O failures', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDir
        const resolvedPath = path.join(cwd, 'missing.txt')

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: 'missing.txt' })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError)
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: 'missing.txt',
          resolvedPath,
          operationPath: resolvedPath,
          operation: 'realpath-target',
        })
        expect(error.cause).toBeInstanceOf(Error)
        expect((error.cause as NodeJS.ErrnoException).code).toBe('ENOENT')
      }),
    )
  })

  describe('writeFile', () =>
  {
    it.effect('writes files relative to the workspace root', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const cwd = yield* makeTempDir
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: 'plans/effect-rpc.md',
          contents: '# Plan\n',
        })
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, 'plans/effect-rpc.md'))
          .pipe(Effect.orDie)

        expect(result).toEqual({ relativePath: 'plans/effect-rpc.md' })
        expect(saved).toBe('# Plan\n')
      }),
    )

    it.effect('invalidates workspace entry search cache after writes', () =>
      Effect.gen(function* ()
      {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const cwd = yield* makeTempDir
        yield* writeTextFile(cwd, 'src/existing.ts', 'export {};\n')

        const beforeWrite = yield* workspaceEntries.list({ cwd })
        expect(beforeWrite.entries.some((entry) => entry.path === 'plans/effect-rpc.md')).toBe(
          false,
        )

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: 'plans/effect-rpc.md',
          contents: '# Plan\n',
        })

        const afterWrite = yield* workspaceEntries.list({ cwd })
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: 'plans/effect-rpc.md' })]),
        )
        expect(afterWrite.truncated).toBe(false)
      }),
    )

    it.effect('rejects writes outside the workspace root', () =>
      Effect.gen(function* ()
      {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
        const cwd = yield* makeTempDir
        const path = yield* Path.Path
        const fileSystem = yield* FileSystem.FileSystem

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: '../escape.md',
            contents: '# nope\n',
          })
          .pipe(Effect.flip)

        expect(error.message).toContain(
          'Workspace file path must be relative to the project root: ../escape.md',
        )

        const escapedPath = path.resolve(cwd, '..', 'escape.md')
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null))
        expect(escapedStat).toBeNull()
      }),
    )
  })
})
