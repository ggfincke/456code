// apps/web/src/state/queries.ts
// exposes reactive client query hooks

import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { createThreadSearchAtoms } from '@t3tools/client-runtime/state/thread-search'
import {
  type CheckpointDiffTarget,
  type ComposerPathSearchTarget,
} from '@t3tools/client-runtime/state/threads'
import { type VcsRefTarget } from '@t3tools/client-runtime/state/vcs'
import type {
  EnvironmentId,
  OrchestrationThread,
  ThreadId,
  VcsListRefsResult,
  VcsRef,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Option from 'effect/Option'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { appAtomRegistry } from '../rpc/atomRegistry'
import { orchestrationEnvironment } from './orchestration'
import { isPaginatedBranchesNextPagePending } from './paginatedBranches'
import { projectEnvironment } from './projects'
import { environmentPresentations } from './presentation'
import { useEnvironmentQuery } from './query'
import { useEnvironmentThread } from './threads'
import { vcsEnvironment } from './vcs'

const COMPOSER_PATH_SEARCH_DEBOUNCE_MS = 120
const COMPOSER_PATH_SEARCH_LIMIT = 80
const PROJECT_SEARCH_DEBOUNCE_MS = 200
export const PROJECT_FILE_SEARCH_LIMIT = 200
export const PROJECT_CONTENT_SEARCH_LIMIT = 500
const VCS_REF_LIST_LIMIT = 100
const EMPTY_REFS: ReadonlyArray<VcsRef> = []
const INITIAL_BRANCH_CURSORS = [undefined] as const

const connectedSearchEnvironmentIds = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)]
    .filter(([, presentation]) => presentation.connection.phase === 'connected')
    .map(([environmentId]) => environmentId),
)

export function useThreadSearch(query: string)
{
  const [search] = useState(() =>
    createThreadSearchAtoms({
      connectedEnvironmentIds: connectedSearchEnvironmentIds,
      getSearchAtom: (environmentId, query) =>
        orchestrationEnvironment.searchThreads({
          environmentId,
          input: { query, limit: 50 },
        }),
      labelPrefix: 'web:palette-thread-search',
    }),
  )
  const setQuery = useAtomSet(search.query)
  const atomQuery = useAtomValue(search.query)
  const result = useAtomValue(search.results)
  useEffect(() =>
  {
    setQuery(query)
  }, [query, setQuery])
  // a prop change must hide previous results before the effect updates the shared atom
  const isCurrent = atomQuery === query
  return {
    matches: isCurrent && !result.isLoading ? result.matches : [],
    isPending: !isCurrent || result.isLoading,
  }
}

export interface ThreadDetailView
{
  readonly data: OrchestrationThread | null
  readonly error: string | null
  readonly isPending: boolean
  readonly isDeleted: boolean
}

function useDebouncedValue<A>(value: A, delayMs: number): A
{
  const [debounced, setDebounced] = useState(value)

  useEffect(() =>
  {
    const timer = window.setTimeout(() =>
    {
      setDebounced(value)
    }, delayMs)
    return () =>
    {
      window.clearTimeout(timer)
    }
  }, [delayMs, value])

  return debounced
}

export function useProjectFileSearch(target: {
  readonly environmentId: EnvironmentId
  readonly cwd: string
  readonly query: string
})
{
  const current = useMemo(
    () => ({ environmentId: target.environmentId, cwd: target.cwd, query: target.query.trim() }),
    [target.environmentId, target.cwd, target.query],
  )
  const debounced = useDebouncedValue(current, PROJECT_SEARCH_DEBOUNCE_MS)
  const isDebouncing = current !== debounced
  const tooLong = current.query.length > 256
  const result = useEnvironmentQuery(
    isDebouncing || tooLong
      ? null
      : projectEnvironment.searchEntries({
          environmentId: current.environmentId,
          input: {
            cwd: current.cwd,
            query: current.query,
            limit: PROJECT_FILE_SEARCH_LIMIT,
            kind: 'file',
          },
        }),
  )
  const isPending = !tooLong && (isDebouncing || result.isPending)
  return {
    entries:
      isPending || tooLong
        ? []
        : (result.data?.entries ?? []).filter((entry) => entry.kind === 'file'),
    error: tooLong ? 'Search is limited to 256 characters.' : result.error,
    isPending,
    truncated: !isPending && (result.data?.truncated ?? false),
  }
}

export function useProjectContentSearch(target: {
  readonly environmentId: EnvironmentId
  readonly cwd: string
  readonly query: string
  readonly caseSensitive: boolean
  readonly wholeWord: boolean
  readonly useRegex: boolean
})
{
  const current = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: target.query,
      caseSensitive: target.caseSensitive,
      wholeWord: target.wholeWord,
      useRegex: target.useRegex,
    }),
    [
      target.environmentId,
      target.cwd,
      target.query,
      target.caseSensitive,
      target.wholeWord,
      target.useRegex,
    ],
  )
  const debounced = useDebouncedValue(current, PROJECT_SEARCH_DEBOUNCE_MS)
  const isDebouncing = current !== debounced
  const hasQuery = current.query.length > 0
  const tooLong = current.query.length > 256
  const result = useEnvironmentQuery(
    !hasQuery || tooLong || isDebouncing
      ? null
      : projectEnvironment.searchContents({
          environmentId: current.environmentId,
          input: {
            cwd: current.cwd,
            query: current.query,
            caseSensitive: current.caseSensitive,
            wholeWord: current.wholeWord,
            useRegex: current.useRegex,
            limit: PROJECT_CONTENT_SEARCH_LIMIT,
          },
        }),
  )
  const isPending = hasQuery && !tooLong && (isDebouncing || result.isPending)
  return {
    matches: isPending || !hasQuery || tooLong ? [] : (result.data?.matches ?? []),
    error: tooLong ? 'Search is limited to 256 characters.' : result.error,
    isPending,
    hasQuery,
    truncated: !isPending && (result.data?.truncated ?? false),
    regexFallbackError: !isPending ? (result.data?.regexFallbackError ?? null) : null,
  }
}

export function useThreadDetail(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ThreadDetailView
{
  const state = useEnvironmentThread(environmentId, threadId)
  return {
    data: Option.getOrNull(state.data),
    error: Option.getOrNull(state.error),
    isPending: state.status === 'synchronizing',
    isDeleted: state.status === 'deleted',
  }
}

export function useBranches(target: VcsRefTarget)
{
  const query = target.query?.trim() ?? ''
  return useEnvironmentQuery(
    target.environmentId !== null && target.cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            ...(query.length > 0 ? { query } : {}),
            limit: VCS_REF_LIST_LIMIT,
          },
        })
      : null,
  )
}

export function usePaginatedBranches(target: VcsRefTarget)
{
  const query = target.query?.trim() ?? ''
  const targetKey =
    target.environmentId !== null && target.cwd !== null
      ? JSON.stringify([target.environmentId, target.cwd, query])
      : null
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null
    readonly cursors: ReadonlyArray<number | undefined>
  }>({
    targetKey,
    cursors: INITIAL_BRANCH_CURSORS,
  })
  const cursors = pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BRANCH_CURSORS
  const pageAtoms = useMemo(
    () =>
      target.environmentId !== null && target.cwd !== null
        ? cursors.map((cursor) =>
            vcsEnvironment.listRefs({
              environmentId: target.environmentId!,
              input: {
                cwd: target.cwd!,
                ...(query.length > 0 ? { query } : {}),
                ...(cursor === undefined ? {} : { cursor }),
                limit: VCS_REF_LIST_LIMIT,
              },
            }),
          )
        : [],
    [cursors, query, target.cwd, target.environmentId],
  )
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:vcs-ref-pages:${targetKey ?? 'empty'}`),
      ),
    [pageAtoms, targetKey],
  )
  const results = useAtomValue(pagesAtom)
  const values = results.flatMap((result) =>
  {
    const value = Option.getOrNull(AsyncResult.value(result))
    return value === null ? [] : [value]
  })
  const refs = new Map<string, VcsRef>()
  for (const value of values)
  {
    for (const ref of value.refs)
    {
      refs.set(ref.name, ref)
    }
  }
  const first = values[0] ?? null
  const last = values.at(-1) ?? null
  const data: VcsListRefsResult | null =
    first === null || last === null
      ? null
      : {
          refs: [...refs.values()],
          isRepo: first.isRepo,
          hasPrimaryRemote: first.hasPrimaryRemote,
          nextCursor: last.nextCursor,
          totalCount: Math.max(...values.map((value) => value.totalCount)),
        }
  const failed = results.find((result) => result._tag === 'Failure')
  const isFetchingNextPage = isPaginatedBranchesNextPagePending(results)
  const error =
    failed?._tag === 'Failure'
      ? (() =>
        {
          const cause = Cause.squash(failed.cause)
          return cause instanceof Error && cause.message.trim().length > 0
            ? cause.message
            : 'Failed to load refs.'
        })()
      : null
  const refresh = useCallback(() =>
  {
    const firstPage = pageAtoms[0]
    setPagination({ targetKey, cursors: INITIAL_BRANCH_CURSORS })
    if (firstPage !== undefined)
    {
      appAtomRegistry.refresh(firstPage)
    }
  }, [pageAtoms, targetKey])
  const loadNext = useCallback(() =>
  {
    if (targetKey === null || data?.nextCursor === null || data?.nextCursor === undefined)
    {
      return
    }
    setPagination((current) =>
    {
      const currentCursors =
        current.targetKey === targetKey ? current.cursors : INITIAL_BRANCH_CURSORS
      return currentCursors.includes(data.nextCursor!)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, data.nextCursor!] }
    })
  }, [data?.nextCursor, targetKey])

  return {
    data,
    refs: data?.refs ?? EMPTY_REFS,
    error,
    isPending: results.some((result) => result.waiting),
    isFetchingNextPage,
    refresh,
    loadNext,
  }
}

export function useComposerPathSearch(target: ComposerPathSearchTarget)
{
  const normalizedTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: target.query?.trim() ?? '',
    }),
    [target.cwd, target.environmentId, target.query],
  )
  const debouncedTarget = useDebouncedValue(normalizedTarget, COMPOSER_PATH_SEARCH_DEBOUNCE_MS)
  const targetIsDebouncing =
    normalizedTarget.environmentId !== debouncedTarget.environmentId ||
    normalizedTarget.cwd !== debouncedTarget.cwd ||
    normalizedTarget.query !== debouncedTarget.query
  const result = useEnvironmentQuery(
    debouncedTarget.environmentId !== null &&
      debouncedTarget.cwd !== null &&
      debouncedTarget.query.length > 0
      ? projectEnvironment.searchEntries({
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: debouncedTarget.query,
            limit: COMPOSER_PATH_SEARCH_LIMIT,
          },
        })
      : null,
  )

  return {
    entries: targetIsDebouncing ? [] : (result.data?.entries ?? []),
    error: result.error,
    isPending: targetIsDebouncing || result.isPending,
    refresh: result.refresh,
  }
}

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
)
{
  const enabled =
    options?.enabled !== false &&
    target.environmentId !== null &&
    target.threadId !== null &&
    target.fromTurnCount !== null &&
    target.toTurnCount !== null
  const fullThreadTarget =
    enabled && target.fromTurnCount === 0
      ? {
          environmentId: target.environmentId!,
          input: {
            threadId: target.threadId!,
            toTurnCount: target.toTurnCount!,
            ignoreWhitespace: target.ignoreWhitespace,
          },
        }
      : null
  const turnTarget =
    enabled && target.fromTurnCount !== 0
      ? {
          environmentId: target.environmentId!,
          input: {
            threadId: target.threadId!,
            fromTurnCount: target.fromTurnCount!,
            toTurnCount: target.toTurnCount!,
            ignoreWhitespace: target.ignoreWhitespace,
          },
        }
      : null
  const fullThread = useEnvironmentQuery(
    fullThreadTarget === null ? null : orchestrationEnvironment.fullThreadDiff(fullThreadTarget),
  )
  const turn = useEnvironmentQuery(
    turnTarget === null ? null : orchestrationEnvironment.turnDiff(turnTarget),
  )
  return fullThreadTarget === null ? turn : fullThread
}
