// tests/apps/server/workspace/WorkspaceSearchIndex.test.ts
// verify workspace search index behavior

import { FileFinder } from '@ff-labs/fff-node'
import { afterEach, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { vi } from 'vite-plus/test'

import * as WorkspaceSearchIndex from '../../../../apps/server/src/workspace/WorkspaceSearchIndex.ts'

afterEach(() =>
{
  vi.restoreAllMocks()
})

it.effect('caps native pages across one query and disposes the content index with its scope', () =>
  Effect.gen(function* ()
  {
    const fs = yield* FileSystem.FileSystem
    const cwd = yield* fs
      .makeTempDirectoryScoped({ prefix: 't3-search-cap-' })
      .pipe(Effect.flatMap(fs.realPath))
    yield* fs.writeFileString(`${cwd}/file.ts`, 'needle')
    const item = {
      relativePath: 'file.ts',
      lineNumber: 1,
      lineContent: 'needle',
      matchRanges: [[0, 6]],
    }
    const grep = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        value: {
          items: Array.from({ length: 60 }, (_, index) => ({ ...item, lineNumber: index + 1 })),
          nextCursor: { __brand: 'GrepCursor', _offset: 1 },
        },
      })
      .mockReturnValueOnce({
        ok: true,
        value: {
          items: Array.from({ length: 60 }, (_, index) => ({ ...item, lineNumber: index + 61 })),
          nextCursor: null,
        },
      })
    const destroy = vi.fn()
    const finder = {
      destroy,
      grep,
      waitForIndexReady: vi.fn(async () => ({ ok: true, value: true })),
    } as unknown as FileFinder
    vi.spyOn(FileFinder, 'create').mockReturnValueOnce({ ok: true, value: finder })
    yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const index = yield* WorkspaceSearchIndex.make(cwd, true)
        const result = yield* index.searchContents({
          query: 'needle',
          limit: 500,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        })
        expect(result.matches).toHaveLength(100)
        expect(result.truncated).toBe(true)
        expect(grep).toHaveBeenCalledTimes(2)
        for (const [, options] of grep.mock.calls)
        {
          expect(options.maxMatchesPerFile).toBe(100)
          expect(options.timeBudgetMs).toBeGreaterThan(0)
          expect(options.timeBudgetMs).toBeLessThanOrEqual(250)
        }
        expect(destroy).not.toHaveBeenCalled()
      }),
    )
    expect(destroy).toHaveBeenCalledTimes(1)
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'bounds containment work and cursor pagination within one budget and sanitizes grep failures',
  () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs
          .makeTempDirectoryScoped({ prefix: 't3-search-budget-' })
          .pipe(Effect.flatMap(fs.realPath))
        yield* fs.writeFileString(`${cwd}/first.ts`, 'needle')
        yield* fs.writeFileString(`${cwd}/slow.ts`, 'needle')
        const now = vi.spyOn(performance, 'now').mockReturnValue(0)
        const unreachablePath = vi.fn(() => 'unreached.ts')
        const grep = vi.fn(() =>
        {
          return {
            ok: true,
            value: {
              items: [
                {
                  relativePath: 'first.ts',
                  lineNumber: 1,
                  lineContent: 'needle',
                  matchRanges: [[0, 6]],
                },
                {
                  relativePath: 'slow.ts',
                  lineNumber: 1,
                  get lineContent()
                  {
                    now.mockReturnValue(251)
                    return 'needle'
                  },
                  matchRanges: [[0, 6]],
                },
                {
                  get relativePath()
                  {
                    return unreachablePath()
                  },
                  lineNumber: 1,
                  lineContent: 'needle',
                  matchRanges: [[0, 6]],
                },
              ],
              nextCursor: { __brand: 'GrepCursor', _offset: 1 },
            },
          }
        })
        const finder = {
          destroy: vi.fn(),
          grep,
          waitForIndexReady: vi.fn(async () => ({ ok: true, value: true })),
        } as unknown as FileFinder
        vi.spyOn(FileFinder, 'create').mockReturnValueOnce({ ok: true, value: finder })
        const index = yield* WorkspaceSearchIndex.make(cwd, true)
        const input = {
          query: 'private query',
          limit: 20,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        }
        const result = yield* index.searchContents(input)
        expect(result.truncated).toBe(true)
        expect(result.matches.map((match) => match.path)).toEqual(['first.ts'])
        expect(unreachablePath).not.toHaveBeenCalled()
        expect(grep).toHaveBeenCalledTimes(1)
        grep.mockImplementationOnce(() =>
        {
          throw new Error('private query native stderr')
        })
        const error = yield* Effect.flip(index.searchContents(input))
        expect(error.reason).toBe('Native workspace search failed.')
        expect(error.cause).toBeUndefined()
        expect(JSON.stringify(error)).not.toContain('private query')
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('preserves unexpected FileFinder creation failures', () =>
  Effect.gen(function* ()
  {
    const cause = new Error('native initialization failed')
    vi.spyOn(FileFinder, 'create').mockImplementationOnce(() =>
    {
      throw cause
    })

    const error = yield* Effect.flip(Effect.scoped(WorkspaceSearchIndex.make('/workspace/project')))

    expect(error).toMatchObject({
      _tag: 'WorkspaceSearchIndexCreateFailed',
      cwd: '/workspace/project',
      reason: 'FileFinder.create threw unexpectedly.',
      cause,
    })
  }),
)

it.effect('keeps returned FileFinder creation diagnostics out of the cause chain', () =>
  Effect.gen(function* ()
  {
    vi.spyOn(FileFinder, 'create').mockReturnValueOnce({
      ok: false,
      error: 'native index rejected the directory',
    })

    const error = yield* Effect.flip(Effect.scoped(WorkspaceSearchIndex.make('/workspace/project')))

    expect(error).toMatchObject({
      _tag: 'WorkspaceSearchIndexCreateFailed',
      cwd: '/workspace/project',
      reason: 'native index rejected the directory',
    })
    expect(error.cause).toBeUndefined()
  }),
)

it.effect('preserves FileFinder destroy failures as structured defects', () =>
  Effect.gen(function* ()
  {
    const cause = new Error('native destroy failed')
    const finder = {
      destroy: vi.fn(() =>
      {
        throw cause
      }),
      isScanning: vi.fn(() => false),
    } as unknown as FileFinder
    vi.spyOn(FileFinder, 'create').mockReturnValueOnce({ ok: true, value: finder })

    const exit = yield* Effect.scoped(WorkspaceSearchIndex.make('/workspace/project')).pipe(
      Effect.exit,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
    {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexDestroyFailed)
      expect(error).toMatchObject({
        _tag: 'WorkspaceSearchIndexDestroyFailed',
        cwd: '/workspace/project',
        cause,
      })
    }
  }),
)

it.effect('preserves search and refresh failures with operation context', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const searchCause = new Error('native search failed')
      const refreshCause = new Error('native scan failed')
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() =>
        {
          throw searchCause
        }),
        scanFiles: vi.fn(() =>
        {
          throw refreshCause
        }),
      } as unknown as FileFinder
      vi.spyOn(FileFinder, 'create').mockReturnValueOnce({ ok: true, value: finder })

      const searchIndex = yield* WorkspaceSearchIndex.make('/workspace/project')
      const query = 'authorization: Bearer secret-token'
      const searchError = yield* Effect.flip(searchIndex.search(query, 3))
      const refreshError = yield* Effect.flip(searchIndex.refresh())

      expect(searchError).toMatchObject({
        _tag: 'WorkspaceSearchIndexSearchFailed',
        cwd: '/workspace/project',
        queryLength: query.length,
        pageSize: 4,
        reason: 'FileFinder.mixedSearch threw unexpectedly.',
        cause: searchCause,
      })
      expect(searchError).not.toHaveProperty('query')
      expect(searchError.message).not.toMatch(/Bearer|secret-token/)
      expect(refreshError).toMatchObject({
        _tag: 'WorkspaceSearchIndexRefreshFailed',
        cwd: '/workspace/project',
        reason: 'FileFinder.scanFiles threw unexpectedly.',
        cause: refreshCause,
      })
    }),
  ),
)

it.effect('keeps returned search diagnostics out of the cause chain', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() => ({ ok: false, error: 'native query rejected' })),
        scanFiles: vi.fn(() => ({ ok: false, error: 'native refresh rejected' })),
      } as unknown as FileFinder
      vi.spyOn(FileFinder, 'create').mockReturnValueOnce({ ok: true, value: finder })

      const searchIndex = yield* WorkspaceSearchIndex.make('/workspace/project')
      const query = 'authorization: Bearer secret-token'
      const searchError = yield* Effect.flip(searchIndex.search(query, 3))
      const refreshError = yield* Effect.flip(searchIndex.refresh())

      expect(searchError).toMatchObject({
        _tag: 'WorkspaceSearchIndexSearchFailed',
        cwd: '/workspace/project',
        queryLength: query.length,
        pageSize: 4,
        reason: 'native query rejected',
      })
      expect(searchError).not.toHaveProperty('query')
      expect(searchError.message).not.toMatch(/Bearer|secret-token/)
      expect(searchError.cause).toBeUndefined()
      expect(refreshError).toMatchObject({
        _tag: 'WorkspaceSearchIndexRefreshFailed',
        cwd: '/workspace/project',
        reason: 'native refresh rejected',
      })
      expect(refreshError.cause).toBeUndefined()
    }),
  ),
)
