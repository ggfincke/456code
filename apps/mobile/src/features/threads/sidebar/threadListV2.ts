// apps/mobile/src/features/threads/sidebar/threadListV2.ts
// resolve thread list v2 status

import { effectiveSettled, effectiveSnoozed } from '@t3tools/client-runtime/state/thread-settled'
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { activeThreadAnchorTimestampMs } from '@t3tools/client-runtime/state/thread-sort'
import type { EnvironmentId, ProjectId } from '@t3tools/contracts'

// thread List v2 model, ported from the web sidebar v2
// (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
//
// four visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state.
export type ThreadListV2Status = 'approval' | 'input' | 'working' | 'failed' | 'ready'

// settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more. Shared by the compact Home list and
// the iPad sidebar so both page identically.
export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25

export function resolveThreadListV2Status(
  thread: Pick<EnvironmentThreadShell, 'hasPendingApprovals' | 'hasPendingUserInput' | 'session'>,
  outboxFailureReason: string | null = null,
): ThreadListV2Status
{
  if (outboxFailureReason !== null)
  {
    return 'failed'
  }
  if (thread.hasPendingApprovals)
  {
    return 'approval'
  }
  if (thread.hasPendingUserInput)
  {
    return 'input'
  }
  if (thread.session?.status === 'running' || thread.session?.status === 'starting')
  {
    return 'working'
  }
  if (thread.session?.status === 'error')
  {
    return 'failed'
  }
  return 'ready'
}

export interface ThreadListV2Presentation
{
  readonly status: ThreadListV2Status
  readonly failureReason: string | null
  readonly accessibilityLabel: string
}

// retained outbox failures outrank the live provider state because the list
// row may be the only surface where a user can discover the failed delivery.
export function resolveThreadListV2Presentation(
  thread: Pick<
    EnvironmentThreadShell,
    'title' | 'hasPendingApprovals' | 'hasPendingUserInput' | 'session'
  >,
  outboxFailureReason: string | null,
  baseAccessibilityLabel: string = thread.title,
): ThreadListV2Presentation
{
  const status = resolveThreadListV2Status(thread, outboxFailureReason)
  return {
    status,
    failureReason:
      outboxFailureReason ?? (status === 'failed' ? thread.session?.lastError || null : null),
    accessibilityLabel:
      outboxFailureReason === null
        ? baseAccessibilityLabel
        : `${baseAccessibilityLabel}, failed: ${outboxFailureReason}`,
  }
}

// NaN-safe Date.parse for sort comparators: a malformed timestamp must not
// poison the whole ordering, so it sinks to the epoch instead.
function parseTimestampMs(isoDate: string): number
{
  const parsed = Date.parse(isoDate)
  return Number.isNaN(parsed) ? 0 : parsed
}

// first VALID timestamp wins: a present-yet-malformed string falls through
// to the next candidate rather than sinking the row to the epoch.
function firstValidTimestampMs(...candidates: ReadonlyArray<string | null | undefined>): number
{
  for (const candidate of candidates)
  {
    if (candidate == null) continue
    const parsed = Date.parse(candidate)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

// v2 sort: static active-list order, re-anchored only when a thread re-enters
// after settling; routine activity never moves an already-active row
export function sortThreadsForListV2<
  T extends {
    readonly id: string
    readonly createdAt: string
    readonly unsettledAt?: string | null | undefined
  },
>(threads: readonly T[]): T[]
{
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left) ||
      left.id.localeCompare(right.id),
  )
}

export interface ThreadListV2Item
{
  readonly thread: EnvironmentThreadShell
  readonly variant: 'card' | 'slim'
  // first settled row after the card block draws the SETTLED divider.
  readonly showSettledDivider: boolean
  readonly isLast: boolean
}

export interface ThreadListV2Layout
{
  readonly items: ThreadListV2Item[]
  // settled threads beyond the render limit (behind "Show more").
  readonly hiddenSettledCount: number
  // snoozed threads hidden from the list (visibility parity with web's
  // collapsed Snoozed shelf; mobile has no shelf UI yet).
  readonly snoozedCount: number
  // soonest wake time among hidden snoozed threads, or null. Callers arm
  // a timeout at this boundary so the list re-partitions the moment a
  // snooze expires instead of on the next minute tick.
  readonly nextSnoozeWakeAt: string | null
}

// partitions visible threads into the active card block (creation order) and
// the settled recency tail, matching the web v2 list. Mobile owns its merge
// preference locally but has no inactivity-threshold control, so
// `autoSettleAfterDays` retains the web default of 3.
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>
  readonly environmentId: EnvironmentId | null
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId
    readonly projectId: ProjectId
  }> | null
  readonly searchQuery: string
  // per-row PR state reported up by visible rows ("env:threadId" keys).
  readonly changeRequestStateByKey?: ReadonlyMap<string, 'open' | 'closed' | 'merged'>
  // environments whose server supports thread.settle/unsettle. Threads on
  // other environments never classify as settled — the user could neither
  // un-settle nor pin them. Absent = no gating (tests).
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>
  // environments whose server supports thread.snooze/unsnooze. Same
  // contract as settlementEnvironmentIds.
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>
  readonly autoSettleAfterDays?: number
  readonly autoSettleOnMerge?: boolean
  // max settled rows to render; the rest are counted, not built.
  readonly settledLimit?: number
  // injectable for tests; defaults to now.
  readonly now?: string
  // second-precise clock for snooze classification. Callers pass a
  // minute-quantized `now` for memoization; snooze wake times are
  // second-precise, so classifying with the floored minute would hold a
  // woken thread hidden for up to a minute. Defaults to `now`.
  readonly snoozeNow?: string
}): ThreadListV2Layout
{
  const now = input.now ?? new Date().toISOString()
  const snoozeNow = input.snoozeNow ?? now
  const autoSettleAfterDays = input.autoSettleAfterDays ?? 3
  const autoSettleOnMerge = input.autoSettleOnMerge ?? true
  const query = input.searchQuery.trim().toLocaleLowerCase()
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null

  const active: EnvironmentThreadShell[] = []
  const settled: EnvironmentThreadShell[] = []
  let snoozedCount = 0
  let nextSnoozeWakeAt: string | null = null
  for (const thread of input.threads)
  {
    // callers pass live (unarchived) shells; settled threads are among them
    // and partition into the tail via effectiveSettled.
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) continue
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`))
    {
      continue
    }
    if (query.length > 0 && !thread.title.toLocaleLowerCase().includes(query)) continue
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true
    const changeRequestState =
      input.changeRequestStateByKey?.get(`${thread.environmentId}:${thread.id}`) ?? null
    // visibility parity with web: a snoozed thread leaves the list until it
    // wakes (or raises its hand — effectiveSnoozed refuses blocked/failed
    // work). Snooze outranks settled classification, same as web.
    if (supportsSnooze && effectiveSnoozed(thread, { now: snoozeNow }))
    {
      snoozedCount += 1
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      )
      {
        nextSnoozeWakeAt = thread.snoozedUntil
      }
      continue
    }
    if (
      supportsSettlement &&
      effectiveSettled(thread, {
        now,
        autoSettleAfterDays,
        autoSettleOnMerge,
        changeRequestState,
      })
    )
    {
      settled.push(thread)
    }
    else
    {
      active.push(thread)
    }
  }

  const orderedActive = sortThreadsForListV2(active)
  const orderedSettled = [...settled].sort(
    (left, right) =>
      firstValidTimestampMs(right.latestUserMessageAt, right.updatedAt) -
      firstValidTimestampMs(left.latestUserMessageAt, left.updatedAt),
  )
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY
  const visibleSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled

  const items: ThreadListV2Item[] = []
  for (const thread of orderedActive)
  {
    items.push({ thread, variant: 'card', showSettledDivider: false, isLast: false })
  }
  for (const [index, thread] of visibleSettled.entries())
  {
    items.push({
      thread,
      variant: 'slim',
      showSettledDivider: index === 0,
      isLast: false,
    })
  }
  const last = items.at(-1)
  if (last)
  {
    items[items.length - 1] = { ...last, isLast: true }
  }
  return {
    items,
    hiddenSettledCount: orderedSettled.length - visibleSettled.length,
    snoozedCount,
    nextSnoozeWakeAt,
  }
}
