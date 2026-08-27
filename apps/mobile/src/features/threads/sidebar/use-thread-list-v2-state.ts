// apps/mobile/src/features/threads/sidebar/use-thread-list-v2-state.ts
// manage shared thread list v2 paging, capability, and wake state

import { useAtomValue } from '@effect/atom-react'
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import type { EnvironmentId, ProjectId } from '@t3tools/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useNowMinute } from '../../../lib/useNowMinute'
import { environmentServerConfigsAtom } from '../../../state/server'
import {
  buildThreadListV2Items,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
} from './threadListV2'

type ChangeRequestState = 'open' | 'closed' | 'merged'

export function useThreadListV2State(input: {
  readonly enabled: boolean
  readonly threads: ReadonlyArray<EnvironmentThreadShell>
  readonly environmentId: EnvironmentId | null
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId
    readonly projectId: ProjectId
  }> | null
  readonly projectScopeKey: string | null
  readonly searchQuery: string
  readonly matchedThreadKeys?: ReadonlySet<string>
  readonly autoSettleOnMerge: boolean
})
{
  const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<
    ReadonlyMap<string, ChangeRequestState>
  >(() => new Map())
  const handleChangeRequestState = useCallback(
    (threadKey: string, state: ChangeRequestState | null) =>
    {
      setChangeRequestStateByKey((current) =>
      {
        if ((current.get(threadKey) ?? null) === state) return current
        const next = new Map(current)
        if (state === null) next.delete(threadKey)
        else next.set(threadKey, state)
        return next
      })
    },
    [],
  )
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  )
  const settledResetKey = `${input.environmentId ?? 'all'}:${input.projectScopeKey ?? 'all'}:${input.searchQuery.trim()}`
  const lastSettledResetKeyRef = useRef(settledResetKey)
  if (lastSettledResetKeyRef.current !== settledResetKey)
  {
    lastSettledResetKeyRef.current = settledResetKey
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT)
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  )
  // the shared module clock replaces a per-hook interval: every surface that
  // resolves a minute-quantized state now ticks off the same timer, so a list
  // and a row can never disagree about which minute it is.
  const nowMinute = useNowMinute()
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0)

  const serverConfigs = useAtomValue(environmentServerConfigsAtom)
  const settlementEnvironmentIds = useMemo(() =>
  {
    const supported = new Set<EnvironmentId>()
    for (const [environmentId, config] of serverConfigs)
    {
      if (config.environment.capabilities.threadSettlement === true)
      {
        supported.add(environmentId)
      }
    }
    return supported
  }, [serverConfigs])
  const snoozeEnvironmentIds = useMemo(() =>
  {
    const supported = new Set<EnvironmentId>()
    for (const [environmentId, config] of serverConfigs)
    {
      if (config.environment.capabilities.threadSnooze === true)
      {
        supported.add(environmentId)
      }
    }
    return supported
  }, [serverConfigs])
  const layout = useMemo(() =>
  {
    if (!input.enabled)
    {
      return { items: [], hiddenSettledCount: 0, snoozedCount: 0, nextSnoozeWakeAt: null }
    }
    return buildThreadListV2Items({
      threads: input.threads.filter((thread) => thread.archivedAt === null),
      environmentId: input.environmentId,
      projectRefs: input.projectRefs,
      searchQuery: input.searchQuery,
      matchedThreadKeys: input.matchedThreadKeys,
      changeRequestStateByKey,
      autoSettleOnMerge: input.autoSettleOnMerge,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      settledLimit: settledVisibleCount,
      now: `${nowMinute}:00.000Z`,
      snoozeNow: new Date().toISOString(),
    })
  }, [
    changeRequestStateByKey,
    input.enabled,
    input.autoSettleOnMerge,
    input.environmentId,
    input.projectRefs,
    input.searchQuery,
    input.matchedThreadKeys,
    input.threads,
    nowMinute,
    settledVisibleCount,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    snoozeWakeTick,
  ])
  const nextSnoozeWakeAt = layout.nextSnoozeWakeAt
  useEffect(() =>
  {
    if (nextSnoozeWakeAt === null) return
    const wakeAtMs = Date.parse(nextSnoozeWakeAt)
    if (Number.isNaN(wakeAtMs)) return
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647)
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs)
    return () => clearTimeout(id)
  }, [nextSnoozeWakeAt, snoozeWakeTick])

  return {
    handleChangeRequestState,
    layout,
    serverConfigs,
    settlementEnvironmentIds,
    showMoreSettled,
  }
}
