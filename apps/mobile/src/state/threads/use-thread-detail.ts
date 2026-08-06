// apps/mobile/src/state/threads/use-thread-detail.ts
// manage thread detail target through a React hook

import * as Option from 'effect/Option'
import { useMemo } from 'react'

import { mergeThreadDetailWithShell } from './thread-shell-fallback'
import { useEnvironmentThread } from './threads'
import { useThreadSelection } from './use-thread-selection'

export function useSelectedThreadDetailState()
{
  const { selectedThreadRef, selectedThread } = useThreadSelection()
  const state = useEnvironmentThread(
    selectedThreadRef?.environmentId ?? null,
    selectedThreadRef?.threadId ?? null,
  )
  return useMemo(() =>
  {
    if (selectedThreadRef === null)
    {
      return state
    }
    const detail = Option.getOrNull(state.data)
    const merged = mergeThreadDetailWithShell(
      selectedThreadRef.environmentId,
      detail,
      selectedThread,
    )
    return { ...state, data: Option.fromNullishOr(merged) }
  }, [selectedThread, selectedThreadRef, state])
}

export function useSelectedThreadDetail()
{
  return Option.getOrNull(useSelectedThreadDetailState().data)
}
