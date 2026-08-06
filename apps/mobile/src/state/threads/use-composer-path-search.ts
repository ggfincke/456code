// apps/mobile/src/state/threads/use-composer-path-search.ts
// manage composer path search through a React hook

import { type ComposerPathSearchTarget } from '@t3tools/client-runtime/state/threads'
import { useEffect, useMemo, useState } from 'react'

import { projectEnvironment } from '../projects'
import { useEnvironmentQuery } from '../query'
import { normalizeComposerPathSearchQuery } from '../queryTargets'

const COMPOSER_PATH_SEARCH_DEBOUNCE_MS = 200
const COMPOSER_PATH_SEARCH_LIMIT = 20

function useDebouncedValue<A>(value: A, delayMs: number): A
{
  const [debounced, setDebounced] = useState(value)

  useEffect(() =>
  {
    const timer = setTimeout(() =>
    {
      setDebounced(value)
    }, delayMs)
    return () =>
    {
      clearTimeout(timer)
    }
  }, [delayMs, value])

  return debounced
}

export function useComposerPathSearch(target: ComposerPathSearchTarget)
{
  const normalizedTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: normalizeComposerPathSearchQuery(target.query),
    }),
    [target.cwd, target.environmentId, target.query],
  )
  const debouncedTarget = useDebouncedValue(normalizedTarget, COMPOSER_PATH_SEARCH_DEBOUNCE_MS)
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
    entries: result.data?.entries ?? [],
    error: result.error,
    isPending: normalizedTarget.query !== debouncedTarget.query || result.isPending,
    refresh: result.refresh,
  }
}
