// apps/mobile/src/lib/thread-activity/feed.ts
// groups and folds mobile thread feed entries
import type {
  OrchestrationLatestTurn,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'
import { formatDuration } from '@t3tools/shared/orchestrationTiming'

import * as Arr from 'effect/Array'
import * as Order from 'effect/Order'
import {
  buildWorkEntryExpandedBody,
  deriveWorkLogEntries,
  memoizeValue,
  workEntryHasExpandedBody,
  workEntryHeading,
  workEntryIcon,
  workEntryPreview,
  workEntryStatus,
  workLogEntryIsToolLike,
  type ThreadFeedActivity,
} from './worklog'
type RawThreadFeedEntry =
  | {
      readonly type: 'message'
      readonly id: string
      readonly createdAt: string
      readonly message: OrchestrationThread['messages'][number]
    }
  | {
      readonly type: 'activity'
      readonly id: string
      readonly createdAt: string
      readonly turnId: TurnId | null
      readonly activity: ThreadFeedActivity
    }

export type ThreadFeedEntry =
  | Extract<RawThreadFeedEntry, { type: 'message' }>
  | {
      readonly type: 'working'
      readonly id: string
      readonly createdAt: string
    }
  | {
      readonly type: 'activity-group'
      readonly id: string
      readonly createdAt: string
      readonly turnId: TurnId | null
      readonly activities: ReadonlyArray<ThreadFeedActivity>
    }
  | {
      readonly type: 'work-toggle'
      readonly id: string
      readonly createdAt: string
      readonly turnId: TurnId | null
      readonly groupId: string
      readonly hiddenCount: number
      readonly expanded: boolean
      readonly onlyToolActivities: boolean
    }
  | {
      readonly type: 'turn-fold'
      readonly id: string
      readonly createdAt: string
      readonly turnId: TurnId
      readonly label: string
      readonly expanded: boolean
    }

export type ThreadFeedLatestTurn = Pick<
  OrchestrationLatestTurn,
  'turnId' | 'state' | 'startedAt' | 'completedAt'
>

type ThreadFeedActivityGroup = Extract<ThreadFeedEntry, { readonly type: 'activity-group' }>
type RawThreadFeedActivityEntry = Extract<RawThreadFeedEntry, { readonly type: 'activity' }>
type RawThreadFeedMessageEntry = Extract<RawThreadFeedEntry, { readonly type: 'message' }>
type DerivedWorkLogEntry = ReturnType<typeof deriveWorkLogEntries>[number]

// weak caches retain only immutable source owners and the presentation inputs
// that can change the corresponding row
const activityEntriesCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReadonlyArray<RawThreadFeedActivityEntry>
>()
const messageEntriesCache = new WeakMap<
  OrchestrationThread['messages'][number],
  RawThreadFeedMessageEntry
>()
const activityGroupsCache = new WeakMap<ThreadFeedActivity, ThreadFeedActivityGroup>()
const presentedActivityGroupsCache = new WeakMap<
  ThreadFeedActivityGroup,
  { readonly expanded: boolean; readonly rows: ReadonlyArray<ThreadFeedEntry> }
>()
const turnFoldRowsCache = new WeakMap<
  ThreadFeedEntry,
  Extract<ThreadFeedEntry, { readonly type: 'turn-fold' }>
>()

const MAX_VISIBLE_WORK_LOG_ENTRIES = 1

function isEmptyMessage(entry: RawThreadFeedEntry): boolean
{
  if (entry.type !== 'message')
  {
    return false
  }
  const hasText = entry.message.text.trim().length > 0
  const hasAttachments = (entry.message.attachments ?? []).length > 0
  return !hasText && !hasAttachments
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[]
{
  const grouped: ThreadFeedEntry[] = []
  let firstActivityEntry: RawThreadFeedActivityEntry | null = null
  let openGroupActivities: ThreadFeedActivity[] = []
  const flushGroup = () =>
  {
    if (firstActivityEntry === null)
    {
      return
    }
    const cached = activityGroupsCache.get(firstActivityEntry.activity)
    if (
      cached &&
      cached.activities.length === openGroupActivities.length &&
      cached.activities.every((activity, index) => activity === openGroupActivities[index])
    )
    {
      grouped.push(cached)
    }
    else
    {
      const group: ThreadFeedActivityGroup = {
        type: 'activity-group',
        id: firstActivityEntry.id,
        createdAt: firstActivityEntry.createdAt,
        turnId: firstActivityEntry.turnId,
        activities: openGroupActivities,
      }
      activityGroupsCache.set(firstActivityEntry.activity, group)
      grouped.push(group)
    }
    firstActivityEntry = null
    openGroupActivities = []
  }

  for (const entry of entries)
  {
    // skip empty messages so they do not break activity grouping
    if (isEmptyMessage(entry))
    {
      continue
    }

    if (entry.type !== 'activity')
    {
      flushGroup()
      grouped.push(entry)
      continue
    }

    if (firstActivityEntry !== null && firstActivityEntry.turnId !== entry.turnId)
    {
      flushGroup()
    }
    firstActivityEntry ??= entry
    openGroupActivities.push(entry.activity)
  }

  flushGroup()
  return grouped
}

function computeElapsedMs(startIso: string, endIso: string): number | null
{
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end))
  {
    return null
  }
  return Math.max(0, end - start)
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null
{
  if (a === null) return b
  if (b === null) return a
  const aMs = Date.parse(a)
  const bMs = Date.parse(b)
  if (!Number.isFinite(aMs)) return b
  if (!Number.isFinite(bMs)) return a
  return bMs > aMs ? b : a
}

function deriveUnsettledTurnId(latestTurn: ThreadFeedLatestTurn | null): TurnId | null
{
  if (!latestTurn)
  {
    return null
  }
  const settled = latestTurn.completedAt !== null && latestTurn.state !== 'running'
  return settled ? null : latestTurn.turnId
}

interface ThreadFeedTurnFold
{
  readonly turnId: TurnId
  readonly createdAt: string
  readonly hiddenEntryIds: ReadonlySet<string>
  readonly label: string
}

function deriveThreadFeedTurnFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
): ReadonlyMap<string, ThreadFeedTurnFold>
{
  const firstAssistantMessageIdByTurn = new Map<TurnId, string>()
  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>()
  for (const entry of feed)
  {
    if (entry.type === 'message' && entry.message.role === 'assistant' && entry.message.turnId)
    {
      if (!firstAssistantMessageIdByTurn.has(entry.message.turnId))
      {
        firstAssistantMessageIdByTurn.set(entry.message.turnId, entry.id)
      }
      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id)
    }
  }

  interface TurnGroup
  {
    readonly entries: ThreadFeedEntry[]
    readonly startBoundary: string | null
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>()
  let pendingUserBoundary: string | null = null
  for (const entry of feed)
  {
    if (entry.type === 'message' && entry.message.role === 'user')
    {
      pendingUserBoundary = entry.message.createdAt
      continue
    }
    const turnId =
      entry.type === 'message' && entry.message.role === 'assistant'
        ? entry.message.turnId
        : entry.type === 'activity-group'
          ? entry.turnId
          : null
    if (!turnId)
    {
      continue
    }
    let group = groupsByTurnId.get(turnId)
    if (!group)
    {
      group = {
        entries: [],
        startBoundary: pendingUserBoundary,
      }
      pendingUserBoundary = null
      groupsByTurnId.set(turnId, group)
    }
    group.entries.push(entry)
  }

  const unsettledTurnId = deriveUnsettledTurnId(latestTurn)
  const foldsByAnchorId = new Map<string, ThreadFeedTurnFold>()
  for (const [turnId, group] of groupsByTurnId)
  {
    const { entries } = group
    if (turnId === unsettledTurnId)
    {
      continue
    }
    if (entries.some((entry) => entry.type === 'message' && entry.message.streaming))
    {
      continue
    }

    const firstAssistantMessageId = firstAssistantMessageIdByTurn.get(turnId)
    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId)
    const hiddenEntryIds = new Set(
      entries
        .filter(
          (entry) =>
            entry.id !== firstAssistantMessageId && entry.id !== terminalAssistantMessageId,
        )
        .map((entry) => entry.id),
    )
    if (hiddenEntryIds.size === 0)
    {
      continue
    }

    const firstEntry = entries[0]
    const firstHiddenEntry = entries.find((entry) => hiddenEntryIds.has(entry.id))
    const lastEntry = entries.at(-1)
    if (!firstEntry || !firstHiddenEntry || !lastEntry)
    {
      continue
    }
    const terminalEntry = terminalAssistantMessageId
      ? entries.find((entry) => entry.id === terminalAssistantMessageId)
      : null
    const latestTurnMatches = latestTurn?.turnId === turnId
    const lastEntryEnd =
      lastEntry.type === 'message' ? lastEntry.message.updatedAt : lastEntry.createdAt
    const elapsedMs =
      latestTurnMatches && latestTurn.startedAt && latestTurn.completedAt
        ? computeElapsedMs(latestTurn.startedAt, latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(
              terminalEntry?.type === 'message' ? terminalEntry.message.updatedAt : null,
              lastEntryEnd,
            ) ?? lastEntryEnd,
          )
    const duration = elapsedMs === null ? null : formatDuration(elapsedMs)
    const interrupted = latestTurnMatches && latestTurn.state === 'interrupted'
    const label = interrupted
      ? duration
        ? `You stopped after ${duration}`
        : 'You stopped this response'
      : duration
        ? `Worked for ${duration}`
        : 'Worked'

    foldsByAnchorId.set(firstHiddenEntry.id, {
      turnId,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label,
    })
  }
  return foldsByAnchorId
}

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
  expandedTurnIds: ReadonlySet<TurnId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
): ThreadFeedEntry[]
{
  const sourceFeed = feed.filter(
    (entry) =>
      entry.type !== 'turn-fold' && entry.type !== 'work-toggle' && entry.type !== 'working',
  )
  const foldsByAnchorId = deriveThreadFeedTurnFolds(sourceFeed, latestTurn)
  const collapsedEntryIds = new Set<string>()
  for (const fold of foldsByAnchorId.values())
  {
    if (!expandedTurnIds.has(fold.turnId))
    {
      for (const entryId of fold.hiddenEntryIds)
      {
        collapsedEntryIds.add(entryId)
      }
    }
  }

  const result: ThreadFeedEntry[] = []
  for (const entry of sourceFeed)
  {
    const fold = foldsByAnchorId.get(entry.id)
    if (fold)
    {
      const expanded = expandedTurnIds.has(fold.turnId)
      let row = turnFoldRowsCache.get(entry)
      if (
        !row ||
        row.turnId !== fold.turnId ||
        row.createdAt !== fold.createdAt ||
        row.label !== fold.label ||
        row.expanded !== expanded
      )
      {
        row = {
          type: 'turn-fold',
          id: `turn-fold:${fold.turnId}`,
          createdAt: fold.createdAt,
          turnId: fold.turnId,
          label: fold.label,
          expanded,
        }
        turnFoldRowsCache.set(entry, row)
      }
      result.push(row)
    }
    if (!collapsedEntryIds.has(entry.id))
    {
      appendPresentedFeedEntry(result, entry, expandedWorkGroupIds)
    }
  }
  if (activeWorkStartedAt !== null)
  {
    result.push({
      type: 'working',
      id: 'working-indicator-row',
      createdAt: activeWorkStartedAt,
    })
  }
  return result
}

function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<ThreadFeedEntry, { readonly type: 'turn-fold' | 'work-toggle' | 'working' }>,
  expandedWorkGroupIds: ReadonlySet<string>,
): void
{
  if (entry.type !== 'activity-group')
  {
    result.push(entry)
    return
  }

  const expanded = expandedWorkGroupIds.has(entry.id)
  let cached = presentedActivityGroupsCache.get(entry)
  if (!cached || cached.expanded !== expanded)
  {
    cached = { expanded, rows: buildPresentedActivityGroupRows(entry, expanded) }
    presentedActivityGroupsCache.set(entry, cached)
  }
  result.push(...cached.rows)
}

function buildPresentedActivityGroupRows(
  entry: ThreadFeedActivityGroup,
  expanded: boolean,
): ReadonlyArray<ThreadFeedEntry>
{
  const result: ThreadFeedEntry[] = []

  const activities = entry.activities.filter(
    (activity) => !(activity.toolLike && activity.status === 'neutral'),
  )
  if (activities.length === 0)
  {
    return result
  }
  if (activities.length <= MAX_VISIBLE_WORK_LOG_ENTRIES)
  {
    result.push({
      ...entry,
      activities,
    })
    return result
  }

  const groupId = entry.id
  const hiddenCount = activities.length - MAX_VISIBLE_WORK_LOG_ENTRIES
  const visibleActivities = expanded ? activities : activities.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)

  for (const activity of visibleActivities)
  {
    result.push({
      type: 'activity-group',
      id: activity.id,
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      activities: [activity],
    })
  }
  result.push({
    type: 'work-toggle',
    id: `work-toggle:${groupId}`,
    createdAt: entry.createdAt,
    turnId: entry.turnId,
    groupId,
    hiddenCount,
    expanded,
    onlyToolActivities: activities.every((activity) => activity.toolLike),
  })
  return result
}

// sort once for consumers that share lifecycle ordering
export function sortThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity>
{
  return [...activities].sort(compareOrchestrationThreadActivities)
}
export function buildThreadFeed(
  thread: Pick<OrchestrationThread, 'messages' | 'activities'>,
  options?: {
    readonly loadedMessages?: ReadonlyArray<OrchestrationThread['messages'][number]>
  },
): ThreadFeedEntry[]
{
  const loadedMessages = options?.loadedMessages ?? thread.messages
  const oldestLoadedMessageCreatedAt =
    options?.loadedMessages !== undefined ? (loadedMessages[0]?.createdAt ?? null) : null
  const workLogEntries = getThreadFeedActivityEntries(thread.activities)
  const entries = Arr.sortWith(
    [
      ...loadedMessages.map<RawThreadFeedEntry>((message) =>
      {
        let entry = messageEntriesCache.get(message)
        if (!entry)
        {
          entry = {
            type: 'message',
            id: message.id,
            createdAt: message.createdAt,
            message,
          }
          messageEntriesCache.set(message, entry)
        }
        return entry
      }),
      ...workLogEntries
        .filter((entry) =>
        {
          if (options?.loadedMessages === undefined)
          {
            return true
          }
          return (
            oldestLoadedMessageCreatedAt === null || entry.createdAt >= oldestLoadedMessageCreatedAt
          )
        })
        .map<RawThreadFeedEntry>((entry) => entry),
    ],
    (s) => new Date(s.createdAt),
    Order.Date,
  )

  return groupAdjacentActivities(entries)
}

function getThreadFeedActivityEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<RawThreadFeedActivityEntry>
{
  const cached = activityEntriesCache.get(activities)
  if (cached)
  {
    return cached
  }
  const entries = deriveWorkLogEntries(activities).map(toThreadFeedActivityEntry)
  activityEntriesCache.set(activities, entries)
  return entries
}

function toThreadFeedActivityEntry(entry: DerivedWorkLogEntry): RawThreadFeedActivityEntry
{
  const summary = workEntryHeading(entry)
  const detail = workEntryPreview(entry)
  const getFullDetail = memoizeValue(() => buildWorkEntryExpandedBody(entry))
  const getCopyText = memoizeValue(() =>
    [summary, detail, getFullDetail()]
      .filter((value, index, values): value is string =>
      {
        return Boolean(value) && values.indexOf(value) === index
      })
      .join('\n'),
  )
  return {
    type: 'activity',
    id: entry.id,
    createdAt: entry.createdAt,
    turnId: entry.turnId,
    activity: {
      id: entry.id,
      createdAt: entry.createdAt,
      turnId: entry.turnId,
      summary,
      detail,
      canExpand: workEntryHasExpandedBody(entry),
      getFullDetail,
      getCopyText,
      icon: workEntryIcon(entry),
      toolLike: workLogEntryIsToolLike(entry),
      status: workEntryStatus(entry),
    },
  }
}
