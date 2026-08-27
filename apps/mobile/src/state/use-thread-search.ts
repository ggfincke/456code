// apps/mobile/src/state/use-thread-search.ts
// binds mobile search inputs to shared connected-environment query atoms

import { useAtomSet, useAtomValue } from '@effect/atom-react'
import {
  createThreadSearchAtoms,
  threadSearchMatchKey,
} from '@t3tools/client-runtime/state/thread-search'
import type { EnvironmentId } from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'
import { useEffect, useMemo } from 'react'
import { orchestrationEnvironment } from './orchestration'
import { environmentPresentations } from './presentation'

export function useThreadSearch(input: {
  readonly query: string
  readonly environmentId: EnvironmentId | null
})
{
  const { environmentId } = input
  const search = useMemo(
    () =>
      createThreadSearchAtoms({
        connectedEnvironmentIds: Atom.make((get) =>
          [...get(environmentPresentations.presentationsAtom)]
            .filter(
              ([id, presentation]) =>
                presentation.connection.phase === 'connected' &&
                (environmentId === null || id === environmentId),
            )
            .map(([id]) => id),
        ),
        getSearchAtom: (id, query) =>
          orchestrationEnvironment.searchThreads({ environmentId: id, input: { query } }),
        labelPrefix: 'mobile-thread-search',
      }),
    [environmentId],
  )
  const setQuery = useAtomSet(search.query)
  const currentQuery = useAtomValue(search.query)
  const result = useAtomValue(search.results)
  useEffect(() => setQuery(input.query), [input.query, setQuery])
  const current = currentQuery === input.query
  return useMemo(() =>
  {
    const matches = current ? result.matches : []
    return {
      matchesByKey: new Map(matches.map((match) => [threadSearchMatchKey(match), match])),
      matchedThreadKeys: new Set(matches.map(threadSearchMatchKey)),
      isLoading: current ? result.isLoading : input.query.trim().length >= 2,
    }
  }, [current, input.query, result])
}
