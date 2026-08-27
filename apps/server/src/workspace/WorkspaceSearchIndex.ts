// apps/server/src/workspace/WorkspaceSearchIndex.ts
// owns bounded workspace path and content indexes

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import {
  FileFinder,
  type GrepCursor,
  type Result,
  type MixedItem,
  type MixedSearchResult,
} from '@ff-labs/fff-node'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as LayerMap from 'effect/LayerMap'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'

import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from '@t3tools/contracts'

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2
const WORKSPACE_INDEX_SCAN_TIMEOUT = '15 seconds'
const WORKSPACE_INDEX_IDLE_TTL = '15 minutes'
const WORKSPACE_INDEX_SCAN_POLL_INTERVAL = '50 millis'
const CONTENT_SEARCH_BUDGET_MS = 250
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexCreateFailed>()(
  'WorkspaceSearchIndexCreateFailed',
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Failed to create the workspace search index for '${this.cwd}'.`
  }
}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedErrorClass<WorkspaceSearchIndexScanTimedOut>()(
  'WorkspaceSearchIndexScanTimedOut',
  {
    cwd: Schema.String,
    timeout: Schema.String,
  },
)
{
  override get message(): string
  {
    return `Workspace search index for '${this.cwd}' did not finish scanning within ${this.timeout}`
  }
}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexSearchFailed>()(
  'WorkspaceSearchIndexSearchFailed',
  {
    cwd: Schema.String,
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Workspace search failed for '${this.cwd}'.`
  }
}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexRefreshFailed>()(
  'WorkspaceSearchIndexRefreshFailed',
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Failed to refresh the workspace search index for '${this.cwd}'.`
  }
}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexDestroyFailed>()(
  'WorkspaceSearchIndexDestroyFailed',
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to destroy the workspace search index for '${this.cwd}'.`
  }
}

export type WorkspaceSearchIndexError =
  | WorkspaceSearchIndexCreateFailed
  | WorkspaceSearchIndexScanTimedOut
  | WorkspaceSearchIndexSearchFailed
  | WorkspaceSearchIndexRefreshFailed

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>
    readonly search: (
      query: string,
      limit: number,
      kind?: ProjectEntryKind,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>
    readonly searchContents: (
      input: Omit<ProjectSearchContentsInput, 'cwd'>,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceSearchIndexSearchFailed>
    readonly refresh: () => Effect.Effect<
      void,
      WorkspaceSearchIndexRefreshFailed | WorkspaceSearchIndexScanTimedOut
    >
  }
>()('456code/workspace/WorkspaceSearchIndex')
{}

function toPosixPath(input: string): string
{
  return input.replaceAll('\\', '/')
}

function trimDirectorySeparator(input: string): string
{
  return input.endsWith('/') ? input.slice(0, -1) : input
}

function safeRelativePath(input: string): string | null
{
  const path = trimDirectorySeparator(toPosixPath(input))
  return path.length > 0 &&
    !NodePath.posix.isAbsolute(path) &&
    !NodePath.win32.isAbsolute(path) &&
    !path.split('/').some((part) => part === '..' || part === '.')
    ? path
    : null
}

const wordCharacter = /[\p{Letter}\p{Mark}\p{Number}_]/u

function characterBefore(line: string, index: number): string
{
  if (index <= 0) return ''
  const previous = line.charCodeAt(index - 1)
  const offset = previous >= 0xdc00 && previous <= 0xdfff && index > 1 ? 2 : 1
  return String.fromCodePoint(line.codePointAt(index - offset) ?? 0)
}

function wholeWord(line: string, start: number, end: number): boolean
{
  const before = characterBefore(line, start)
  const after = String.fromCodePoint(line.codePointAt(end) ?? 0)
  const first = String.fromCodePoint(line.codePointAt(start) ?? 0)
  const last = characterBefore(line, end)
  return (
    (!wordCharacter.test(before) || !wordCharacter.test(first)) &&
    (!wordCharacter.test(after) || !wordCharacter.test(last))
  )
}

function contentRanges(
  line: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  whole: boolean,
)
{
  const bytes = Buffer.from(line)
  return ranges.flatMap(([startByte, endByte]) =>
  {
    if (
      !Number.isInteger(startByte) ||
      !Number.isInteger(endByte) ||
      startByte < 0 ||
      endByte <= startByte ||
      endByte > bytes.length ||
      (startByte < bytes.length && (bytes[startByte]! & 0xc0) === 0x80) ||
      (endByte < bytes.length && (bytes[endByte]! & 0xc0) === 0x80)
    )
      return []
    const start = bytes.subarray(0, startByte).toString('utf8').length
    const end = bytes.subarray(0, endByte).toString('utf8').length
    return !whole || wholeWord(line, start, end) ? [{ start, end }] : []
  })
}

function parentPathOf(input: string): string | undefined
{
  const separatorIndex = input.lastIndexOf('/')
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex)
}

function toProjectEntry(item: MixedItem): ProjectEntry | null
{
  const normalizedPath = safeRelativePath(item.item.relativePath)
  if (!normalizedPath)
  {
    return null
  }

  return {
    path: normalizedPath,
    kind: item.type,
  }
}

function mapMixedSearchResult(
  result: MixedSearchResult,
  limit: number,
): { readonly entries: ProjectEntry[]; readonly truncated: boolean }
{
  const entries: ProjectEntry[] = []
  for (const item of result.items)
  {
    const entry = toProjectEntry(item)
    if (entry)
    {
      entries.push(entry)
    }
    if (entries.length >= limit)
    {
      break
    }
  }

  const rootDirectoryCount = result.items.some(
    (item) => item.type === 'directory' && item.item.relativePath.length === 0,
  )
    ? 1
    : 0
  return {
    entries,
    truncated: result.totalMatched - rootDirectoryCount > limit,
  }
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[]
{
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]))
  for (const entry of entries)
  {
    let parentPath = parentPathOf(entry.path)
    while (parentPath)
    {
      if (!entryByPath.has(parentPath))
      {
        entryByPath.set(parentPath, { path: parentPath, kind: 'directory' })
      }
      parentPath = parentPathOf(parentPath)
    }
  }
  return [...entryByPath.values()]
}

const createFinder = Effect.fn('WorkspaceSearchIndex.createFinder')(function* (
  cwd: string,
  content: boolean,
)
{
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: cwd,
        disableMmapCache: true,
        disableContentIndexing: !content,
        aiMode: false,
        enableFsRootScanning: true,
        enableHomeDirScanning: true,
      }),
    catch: (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: 'FileFinder.create threw unexpectedly.',
        cause,
      }),
  })
  if (result.ok) return result.value
  return yield* new WorkspaceSearchIndexCreateFailed({
    cwd,
    reason: result.error,
  })
})

const waitForScan = <E>(cwd: string, finder: FileFinder, onFailure: (cause: unknown) => E) =>
  Effect.try({
    try: () => finder.isScanning(),
    catch: onFailure,
  }).pipe(
    Effect.repeat({
      while: (scanning) => scanning,
      schedule: Schedule.spaced(WORKSPACE_INDEX_SCAN_POLL_INTERVAL),
    }),
    Effect.timeoutOrElse({
      duration: WORKSPACE_INDEX_SCAN_TIMEOUT,
      orElse: () =>
        new WorkspaceSearchIndexScanTimedOut({ cwd, timeout: WORKSPACE_INDEX_SCAN_TIMEOUT }),
    }),
    Effect.withSpan('WorkspaceSearchIndex.waitForScan'),
  )

export const make = Effect.fn('WorkspaceSearchIndex.make')(function* (
  cwd: string,
  content = false,
)
{
  const finder = yield* Effect.acquireRelease(createFinder(cwd, content), (finder) =>
    Effect.try({
      try: () => finder.destroy(),
      catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.orDie),
  )
  const waitForReady = <E>(onFailure: (cause: unknown) => E) =>
    content
      ? Effect.tryPromise({ try: () => finder.waitForIndexReady(15_000), catch: onFailure }).pipe(
          Effect.flatMap((result) =>
            result.ok && result.value
              ? Effect.void
              : Effect.fail(
                  new WorkspaceSearchIndexScanTimedOut({
                    cwd,
                    timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
                  }),
                ),
          ),
        )
      : waitForScan(cwd, finder, onFailure)
  yield* waitForReady(
    (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: 'FileFinder.isScanning threw while creating the index.',
        cause,
      }),
  )

  const runSearch = <A>(query: string, pageSize: number, execute: () => Result<A>) =>
    Effect.try({
      try: execute,
      catch: () =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: 'Native workspace search failed.',
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.value)
          : Effect.fail(
              new WorkspaceSearchIndexSearchFailed({
                cwd,
                queryLength: query.length,
                pageSize,
                reason: 'Native workspace search failed.',
              }),
            ),
      ),
    )

  const searchContents: WorkspaceSearchIndex['Service']['searchContents'] = Effect.fn(
    'WorkspaceSearchIndex.searchContents',
  )(function* (input)
  {
    const deadline = performance.now() + CONTENT_SEARCH_BUDGET_MS
    let query = input.caseSensitive
      ? input.query
      : input.useRegex
        ? `(?i)${input.query}`
        : input.query.toLowerCase()
    let regexMode = input.useRegex
    const matches: Array<ProjectSearchContentsResult['matches'][number]> = []
    const allowedPaths = new Map<string, boolean>()
    const perFileCount = new Map<string, number>()
    let cursor: GrepCursor | null = null
    let regexFallback = false
    let cappedFile = false
    let budgetExhausted = false
    do
    {
      const grep = () =>
        finder.grep(query, {
          mode: regexMode ? 'regex' : 'plain',
          smartCase: !input.caseSensitive && !regexMode,
          maxMatchesPerFile: CONTENT_SEARCH_MAX_MATCHES_PER_FILE,
          pageSize: Math.max(input.limit + 1, CONTENT_SEARCH_MAX_MATCHES_PER_FILE),
          cursor,
          timeBudgetMs: Math.max(1, Math.ceil(deadline - performance.now())),
        } as const)
      let result = yield* runSearch(input.query, input.limit, grep)
      if (result.regexFallbackError !== undefined && regexMode)
      {
        regexFallback = true
        regexMode = false
        query = input.caseSensitive ? input.query : input.query.toLowerCase()
        // retry the original literal, not the case-insensitive regex prefix
        if (performance.now() >= deadline)
        {
          budgetExhausted = true
          break
        }
        result = yield* runSearch(input.query, input.limit, grep)
      }
      for (const item of result.items)
      {
        if (performance.now() >= deadline)
        {
          budgetExhausted = true
          break
        }
        const relativePath = safeRelativePath(item.relativePath)
        if (relativePath === null || !Number.isInteger(item.lineNumber) || item.lineNumber < 1)
          continue
        const count = (perFileCount.get(relativePath) ?? 0) + 1
        perFileCount.set(relativePath, count)
        cappedFile ||= count >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE
        if (count > CONTENT_SEARCH_MAX_MATCHES_PER_FILE) continue
        const matchRanges = contentRanges(item.lineContent, item.matchRanges, input.wholeWord)
        if (matchRanges.length === 0) continue
        if (!allowedPaths.has(relativePath))
        {
          // native indexes are not a containment boundary; reject resolved symlink escapes
          const resolved = yield* Effect.tryPromise({
            try: () => NodeFSP.realpath(NodePath.resolve(cwd, relativePath)),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null))
          const relative = resolved === null ? null : NodePath.relative(cwd, resolved)
          allowedPaths.set(relativePath, relative !== null && safeRelativePath(relative) !== null)
        }
        if (performance.now() >= deadline)
        {
          budgetExhausted = true
          break
        }
        if (!allowedPaths.get(relativePath)) continue
        matches.push({
          path: relativePath,
          lineNumber: item.lineNumber,
          lineContent: item.lineContent,
          matchRanges,
        })
      }
      regexFallback ||= result.regexFallbackError !== undefined
      if (budgetExhausted) break
      const previousOffset = cursor?._offset
      cursor = result.nextCursor
      if (cursor !== null && cursor._offset === previousOffset) break
    } while (matches.length <= input.limit && cursor !== null && performance.now() < deadline)
    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || cursor !== null || cappedFile || budgetExhausted,
      ...(regexFallback
        ? { regexFallbackError: 'Invalid regular expression; showing literal matches instead.' }
        : {}),
    }
  })

  const runMixedSearch = Effect.fn('WorkspaceSearchIndex.runMixedSearch')(function* (
    query: string,
    pageSize: number,
  )
  {
    const result = yield* Effect.try({
      try: () => finder.mixedSearch(query, { pageSize }),
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: 'FileFinder.mixedSearch threw unexpectedly.',
          cause,
        }),
    })
    if (!result.ok)
    {
      return yield* new WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      })
    }
    return result.value
  })

  const refresh: WorkspaceSearchIndex['Service']['refresh'] = Effect.fn(
    'WorkspaceSearchIndex.refresh',
  )(function* ()
  {
    const result = yield* Effect.try({
      try: () => finder.scanFiles(),
      catch: (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: 'FileFinder.scanFiles threw unexpectedly.',
          cause,
        }),
    })
    if (!result.ok)
    {
      return yield* new WorkspaceSearchIndexRefreshFailed({
        cwd,
        reason: result.error,
      })
    }
    yield* waitForReady(
      (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: 'FileFinder.isScanning threw while refreshing the index.',
          cause,
        }),
    )
  })

  const list: WorkspaceSearchIndex['Service']['list'] = Effect.fn('WorkspaceSearchIndex.list')(
    function* ()
    {
      const result = yield* runMixedSearch('', WORKSPACE_INDEX_PAGE_SIZE)
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES)
      const sortedEntries = withDirectoryAncestors(mapped.entries).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      )
      const entries = sortedEntries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES)
      return {
        entries,
        truncated: mapped.truncated || entries.length < sortedEntries.length,
      }
    },
  )

  const search: WorkspaceSearchIndex['Service']['search'] = Effect.fn(
    'WorkspaceSearchIndex.search',
  )(function* (query, limit, kind)
  {
    if (kind !== undefined)
    {
      const result = yield* runSearch<{
        items: ReadonlyArray<{ relativePath: string }>
        totalMatched: number
      }>(query, limit + 1, () =>
        kind === 'file'
          ? finder.fileSearch(query, { pageSize: limit + 1 })
          : finder.directorySearch(query, { pageSize: limit + 1 }),
      )
      const entries = result.items.flatMap((item) =>
      {
        const path = safeRelativePath(item.relativePath)
        return path === null ? [] : [{ path, kind }]
      })
      return { entries: entries.slice(0, limit), truncated: result.totalMatched > limit }
    }
    const result = yield* runMixedSearch(query, Math.max(1, limit + 1))
    return mapMixedSearchResult(result, limit)
  })

  return WorkspaceSearchIndex.of({ list, refresh, search, searchContents })
})

// a layer factory is required because every index is scoped to a concrete
// workspace root. WorkspaceSearchIndexMap owns memoization and idle cleanup;
// using a default cwd here would mix resources from different workspaces.
export const layer = (cwd: string) => Layer.effect(WorkspaceSearchIndex, make(cwd))

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  '456code/workspace/WorkspaceSearchIndexMap',
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
)
{}

export class WorkspaceContentSearchIndexMap extends LayerMap.Service<WorkspaceContentSearchIndexMap>()(
  '456code/workspace/WorkspaceContentSearchIndexMap',
  {
    lookup: (cwd: string) => Layer.effect(WorkspaceSearchIndex, make(cwd, true)),
    idleTimeToLive: '5 minutes',
  },
)
{}
