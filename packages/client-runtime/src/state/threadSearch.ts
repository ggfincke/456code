// packages/client-runtime/src/state/threadSearch.ts
// debounces connected-environment conversation searches and isolates stale results

import {
  type EnvironmentId,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
  THREAD_SEARCH_QUERY_MAX_CHARS,
  THREAD_SEARCH_QUERY_MIN_CHARS,
} from '@t3tools/contracts'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch
{
  readonly environmentId: EnvironmentId
}

export interface ThreadSearchResultsState
{
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>
  readonly isLoading: boolean
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, 'environmentId' | 'threadId'>,
): string
{
  return JSON.stringify([match.environmentId, match.threadId])
}

export function createThreadSearchAtoms<E>(options: {
  readonly connectedEnvironmentIds: Atom.Atom<ReadonlyArray<EnvironmentId>>
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>
  readonly labelPrefix?: string
})
{
  const label = options.labelPrefix ?? 'thread-search'
  const query = Atom.make('').pipe(Atom.withLabel(`${label}:query`))
  const normalizedQuery = Atom.map(query, (value) => value.trim())
  const debouncedQuery = Atom.debounce(normalizedQuery, '200 millis')
  const results = Atom.make<ThreadSearchResultsState>((get) =>
  {
    const current = get(normalizedQuery)
    const debounced = get(debouncedQuery)
    const environmentIds = get(options.connectedEnvironmentIds)
    const valid =
      current.length >= THREAD_SEARCH_QUERY_MIN_CHARS &&
      current.length <= THREAD_SEARCH_QUERY_MAX_CHARS
    if (!valid || current !== debounced)
    {
      return { matches: [], isLoading: valid && environmentIds.length > 0 }
    }
    const matches: EnvironmentThreadSearchMatch[] = []
    let isLoading = false
    for (const environmentId of new Set(environmentIds))
    {
      const result = get(options.getSearchAtom(environmentId, current))
      isLoading ||= result.waiting || AsyncResult.isInitial(result)
      if (AsyncResult.isSuccess(result))
      {
        matches.push(...result.value.matches.map((match) => ({ ...match, environmentId })))
      }
    }
    matches.sort(
      (left, right) =>
        (left.source === 'user' ? 0 : 1) - (right.source === 'user' ? 0 : 1) ||
        (right.messageCreatedAt ?? '').localeCompare(left.messageCreatedAt ?? '') ||
        left.environmentId.localeCompare(right.environmentId) ||
        left.threadId.localeCompare(right.threadId),
    )
    return { matches, isLoading }
  }).pipe(Atom.withLabel(`${label}:results`))
  return { query, results }
}
