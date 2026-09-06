// apps/mobile/src/features/threads/sidebar/use-thread-list-v2-state.ts
// manage shared thread list v2 paging, capability, and wake state

import { useAtomValue } from '@effect/atom-react'
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { planActiveThreadReorder } from '@t3tools/client-runtime/state/thread-sort'
import type { EnvironmentId, ProjectId } from '@t3tools/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useNowMinute } from '../../../lib/useNowMinute'
import { environmentServerConfigsAtom } from '../../../state/server'
import { threadEnvironment } from '../../../state/threads'
import { useAtomCommand } from '../../../state/use-atom-command'
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
  const reorderActiveThread = useAtomCommand(
    threadEnvironment.reorderActive,
    'reorder active thread',
  )
  const reorderPendingRef = useRef(false)
  const [arrangementEnvironmentId, setArrangementEnvironmentId] = useState<EnvironmentId | null>(
    null,
  )
  const openArrangement = useCallback(
    (thread: EnvironmentThreadShell) => setArrangementEnvironmentId(thread.environmentId),
    [],
  )
  const closeArrangement = useCallback(() => setArrangementEnvironmentId(null), [])
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
  const clientAutoSettlementEnvironmentIds = useMemo(() =>
  {
    const legacy = new Set<EnvironmentId>()
    for (const [environmentId, config] of serverConfigs)
    {
      if (
        config.environment.capabilities.threadSettlement === true &&
        config.environment.capabilities.threadAutoSettlement !== true
      )
      {
        legacy.add(environmentId)
      }
    }
    return legacy
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
  const pinningEnvironmentIds = useMemo(() =>
  {
    const supported = new Set<EnvironmentId>()
    for (const [environmentId, config] of serverConfigs)
    {
      if (config.environment.capabilities.threadPinning === true)
      {
        supported.add(environmentId)
      }
    }
    return supported
  }, [serverConfigs])
  const layout = useMemo(() =>
  {
    return buildThreadListV2Items({
      threads: input.threads.filter((thread) => thread.archivedAt === null),
      environmentId: input.environmentId,
      projectRefs: input.projectRefs,
      searchQuery: input.searchQuery,
      matchedThreadKeys: input.matchedThreadKeys,
      changeRequestStateByKey,
      autoSettleOnMerge: input.autoSettleOnMerge,
      settlementEnvironmentIds,
      clientAutoSettlementEnvironmentIds,
      snoozeEnvironmentIds,
      settledLimit: settledVisibleCount,
      now: `${nowMinute}:00.000Z`,
      snoozeNow: new Date().toISOString(),
    })
  }, [
    changeRequestStateByKey,
    input.autoSettleOnMerge,
    input.environmentId,
    input.projectRefs,
    input.searchQuery,
    input.matchedThreadKeys,
    input.threads,
    nowMinute,
    settledVisibleCount,
    clientAutoSettlementEnvironmentIds,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    snoozeWakeTick,
  ])
  const nextSnoozeWakeAt = input.enabled ? layout.nextSnoozeWakeAt : null
  const arrangeableThreads = useMemo(
    () =>
      layout.items
        .filter((item) => item.variant === 'card' && !item.pinned)
        .map((item) => item.thread),
    [layout.items],
  )
  const reorderActiveThreads = useCallback(
    async (active: ReadonlyArray<EnvironmentThreadShell>, movedId: string) =>
    {
      const thread = active.find((candidate) => candidate.id === movedId)
      if (!thread) return
      if (
        reorderPendingRef.current ||
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadActiveReorder !==
          true
      )
        return
      const currentIds = new Set(
        arrangeableThreads
          .filter((candidate) => candidate.environmentId === thread.environmentId)
          .map((candidate) => candidate.id),
      )
      if (
        active.some(
          (candidate) =>
            candidate.environmentId !== thread.environmentId || !currentIds.has(candidate.id),
        )
      )
        return
      const changes = planActiveThreadReorder({
        orderedIds: active.map((candidate) => candidate.id),
        keysById: new Map(
          input.threads
            .filter((candidate) => candidate.environmentId === thread.environmentId)
            .map((candidate) => [candidate.id, candidate.activeOrderKey]),
        ),
        movedId,
      })
      reorderPendingRef.current = true
      try
      {
        for (const change of changes)
        {
          const target = active.find((candidate) => candidate.id === change.id)
          if (!target) return
          const result = await reorderActiveThread({
            environmentId: target.environmentId,
            input: { threadId: target.id, orderKey: change.orderKey },
          })
          if (result._tag !== 'Success') return
        }
      }
      finally
      {
        reorderPendingRef.current = false
      }
    },
    [arrangeableThreads, input.threads, reorderActiveThread, serverConfigs],
  )
  const moveActiveThread = useCallback(
    async (thread: EnvironmentThreadShell, direction: 'up' | 'down') =>
    {
      const active = arrangeableThreads.filter(
        (candidate) => candidate.environmentId === thread.environmentId,
      )
      const from = active.findIndex((candidate) => candidate.id === thread.id)
      const to = from + (direction === 'up' ? -1 : 1)
      if (from < 0 || to < 0 || to >= active.length) return
      const moved = active.splice(from, 1)[0]!
      active.splice(to, 0, moved)
      await reorderActiveThreads(active, thread.id)
    },
    [arrangeableThreads, reorderActiveThreads],
  )
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
    moveActiveThread,
    arrangeableThreads,
    reorderActiveThreads,
    openArrangement,
    closeArrangement,
    arrangementThreads:
      arrangementEnvironmentId === null
        ? null
        : arrangeableThreads.filter((thread) => thread.environmentId === arrangementEnvironmentId),
    layout: input.enabled
      ? layout
      : { items: [], hiddenSettledCount: 0, snoozedCount: 0, nextSnoozeWakeAt: null },
    pinningEnvironmentIds,
    serverConfigs,
    settlementEnvironmentIds,
    showMoreSettled,
  }
}
