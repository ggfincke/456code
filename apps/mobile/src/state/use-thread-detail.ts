// apps/mobile/src/state/use-thread-detail.ts
// manage thread detail target through a React hook

import type { EnvironmentId, ThreadId } from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { useMemo } from 'react'

import { mergeThreadDetailWithShell } from './thread-shell-fallback'
import { useEnvironmentThread } from './threads'
import { useThreadSelection } from './use-thread-selection'

export interface ThreadDetailTarget
{
  readonly environmentId: EnvironmentId | null
  readonly threadId: ThreadId | null
}

export function useThreadDetail(target: ThreadDetailTarget)
{
  return useEnvironmentThread(target.environmentId, target.threadId)
}

export function useSelectedThreadDetailState()
{
  const { selectedThreadRef, selectedThread } = useThreadSelection()
  const state = useThreadDetail({
    environmentId: selectedThreadRef?.environmentId ?? null,
    threadId: selectedThreadRef?.threadId ?? null,
  })
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
