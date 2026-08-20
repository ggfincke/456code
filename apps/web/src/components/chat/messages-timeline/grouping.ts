// apps/web/src/components/chat/messages-timeline/grouping.ts
// derives stable timeline rows from session entries

import {
  type MessageId,
  type OrchestratePlanRevision,
  type OrchestrationLatestTurn,
  type TurnId,
} from '@t3tools/contracts'
import {
  normalizeCompactToolLabel,
  toolCallIdentityKey,
} from '@t3tools/client-runtime/thread-activity'
import * as Equal from 'effect/Equal'
import { type ProviderSwitchTimelineEvent } from '../../../providerSwitchPresentation'
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from '../../../session-logic'
import {
  workEntryDisplayIndicatesToolFailure,
  type WorkerVerdictEntry,
} from '../../../session/worklog'
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from '../../../types'

// timeline consumers reach the shared label normalizer through this module
export { normalizeCompactToolLabel, toolCallIdentityKey }

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean
{
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === 'inProgress' ||
        entry.sourceActivityKind === 'task.progress')) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  )
}

type ToolGroupAction = 'read' | 'edit' | 'command' | 'code-search' | 'search' | 'other'
type ToolGroupSummaryKind = ToolGroupAction | 'dynamic-tool' | 'agent-tool' | 'tone-tool' | 'mixed'

export function workLogEntryIsLocalCodeSearch(entry: WorkLogEntry): boolean
{
  return (
    entry.itemType === 'repository_search' ||
    (entry.itemType === 'web_search' &&
      /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label)))
  )
}

export function toolGroupAction(entry: WorkLogEntry): ToolGroupAction
{
  if (
    entry.requestKind === 'file-read' ||
    entry.itemType === 'image_view' ||
    (entry.itemType === 'dynamic_tool_call' && entry.toolTitle === 'Read File')
  )
  {
    return 'read'
  }
  if (
    entry.requestKind === 'file-change' ||
    entry.itemType === 'file_change' ||
    (entry.changedFiles?.length ?? 0) > 0
  )
  {
    return 'edit'
  }
  if (entry.requestKind === 'command' || entry.itemType === 'command_execution' || entry.command)
  {
    return 'command'
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return 'code-search'
  if (entry.itemType === 'web_search') return 'search'
  return 'other'
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogEntry>,
): number
{
  if (action !== 'edit') return entries.length

  const changedFiles = new Set<string>()
  let editsWithoutFileDetails = 0
  for (const entry of entries)
  {
    if (!entry.changedFiles || entry.changedFiles.length === 0)
    {
      editsWithoutFileDetails += 1
      continue
    }
    for (const file of entry.changedFiles) changedFiles.add(file)
  }
  return changedFiles.size + editsWithoutFileDetails
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string
{
  switch (action)
  {
    case 'read':
      return `Read ${count} ${count === 1 ? 'file' : 'files'}`
    case 'edit':
      return `Changed ${count} ${count === 1 ? 'file' : 'files'}`
    case 'command':
      return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`
    case 'search':
      return `Searched the web ${count} ${count === 1 ? 'time' : 'times'}`
    case 'code-search':
      return `Searched code ${count} ${count === 1 ? 'time' : 'times'}`
    case 'other':
      return `Used ${count} ${count === 1 ? 'tool' : 'tools'}`
  }
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogEntry>): string
{
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry)
  const groupedEntries = new Map<ToolGroupAction, WorkLogEntry[]>()
  for (const entry of summaryEntries)
  {
    const action = toolGroupAction(entry)
    const group = groupedEntries.get(action)
    if (group) group.push(entry)
    else groupedEntries.set(action, [entry])
  }
  const labels = [...groupedEntries].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries)),
  )
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  )
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? ''
  if (sentenceLabels.length === 2) return sentenceLabels.join(' and ')
  return `${sentenceLabels.slice(0, -1).join(', ')}, and ${sentenceLabels.at(-1)}`
}

function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogEntry,
): T[]
{
  const laterTerminalIdentities = new Set<string>()
  const reversedEntries: T[] = []

  for (let index = entries.length - 1; index >= 0; index -= 1)
  {
    const entry = entries[index]!
    const workEntry = workEntryFor(entry)
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label)
    const identity = [
      workEntry.turnId ?? 'no-turn',
      workEntry.itemType ?? '',
      normalizedLabel,
    ].join('\u001f')
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (workEntry.sourceActivityKind === 'tool.started' ||
        workEntry.sourceActivityKind === 'tool.updated')
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue

    reversedEntries.push(entry)
    if (
      workEntry.sourceActivityKind === 'tool.completed' ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== 'inProgress')
    )
    {
      laterTerminalIdentities.add(identity)
    }
  }

  return reversedEntries.toReversed()
}

function toolGroupSummaryKind(entries: ReadonlyArray<WorkLogEntry>): ToolGroupSummaryKind
{
  const actions = new Set(entries.map(toolGroupAction))
  if (actions.size !== 1) return 'mixed'

  const action = actions.values().next().value!
  if (action !== 'other') return action

  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind =>
    {
      if (entry.itemType === 'mcp_tool_call') return 'other'
      if (entry.itemType === 'dynamic_tool_call') return 'dynamic-tool'
      if (entry.itemType === 'collab_agent_tool_call' || entry.taskId) return 'agent-tool'
      if (entry.tone === 'thinking') return 'agent-tool'
      if (entry.tone === 'tool') return 'tone-tool'
      return 'other'
    }),
  )
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : 'mixed'
}

function workGroupIdentity(timelineEntryId: string, entry: WorkLogEntry): string
{
  return entry.toolCallId
    ? `tool:${toolCallIdentityKey(entry.turnId ?? null, entry.toolCallId)}`
    : timelineEntryId
}

function workGroupId(timelineEntryId: string, entry: WorkLogEntry): string
{
  return `work-group:${workGroupIdentity(timelineEntryId, entry)}`
}

function computeElapsedMs(startIso: string, endIso: string): number | null
{
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
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

export interface TimelineDurationMessage
{
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string
  updatedAt: string
  streaming: boolean
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  'turnId' | 'state' | 'startedAt' | 'completedAt'
>

export type MessagesTimelineRow =
  | {
      kind: 'work'
      id: string
      createdAt: string
      groupedEntries: WorkLogEntry[]
      isExpandedToolGroupEntry: boolean
      isLastExpandedToolGroupEntry: boolean
    }
  | {
      kind: 'work-live'
      id: string
      createdAt: string
      entry: WorkLogEntry
      groupedEntries: WorkLogEntry[]
      groupId: string
      expanded: boolean
      hasFailure: boolean
    }
  | {
      kind: 'work-toggle'
      id: string
      createdAt: string
      groupId: string
      hiddenCount: number
      expanded: boolean
      onlyToolEntries: boolean
      summary: string | null
      summaryKind: ToolGroupSummaryKind | null
      hasFailure: boolean
    }
  | {
      kind: 'turn-fold'
      id: string
      createdAt: string
      turnId: TurnId
      label: string
      expanded: boolean
    }
  | {
      kind: 'message'
      id: string
      createdAt: string
      message: ChatMessage
      durationStart: string
      showAssistantMeta: boolean
      showAssistantCopyButton: boolean
      assistantCopyStreaming: boolean
      assistantTurnDiffSummary?: TurnDiffSummary | undefined
      revertTurnCount?: number | undefined
    }
  | {
      kind: 'proposed-plan'
      id: string
      createdAt: string
      proposedPlan: ProposedPlan
    }
  | {
      kind: 'orchestrate-plan'
      id: string
      createdAt: string
      revision: OrchestratePlanRevision
    }
  | {
      kind: 'provider-switch'
      id: string
      createdAt: string
      event: ProviderSwitchTimelineEvent
    }
  | {
      kind: 'worker-verdict'
      id: string
      createdAt: string
      workerVerdict: WorkerVerdictEntry
    }
  | { kind: 'working'; id: string; createdAt: string | null; showThinking: boolean }

export interface StableMessagesTimelineRowsState
{
  byId: Map<string, MessagesTimelineRow>
  result: MessagesTimelineRow[]
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string>
{
  const result = new Map<string, string>()
  let lastBoundary: string | null = null

  for (const message of messages)
  {
    if (message.role === 'user')
    {
      lastBoundary = message.createdAt
    }
    result.set(message.id, lastBoundary ?? message.createdAt)
    if (message.role === 'assistant' && !message.streaming)
    {
      lastBoundary = message.updatedAt
    }
  }

  return result
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null
  showCopyButton: boolean
  streaming: boolean
})
{
  const hasText = text !== null && text.trim().length > 0
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  }
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>)
{
  const lastAssistantMessageIdByResponseKey = new Map<string, string>()
  let nullTurnResponseIndex = 0

  for (const timelineEntry of timelineEntries)
  {
    if (timelineEntry.kind !== 'message')
    {
      continue
    }
    const { message } = timelineEntry
    if (message.role === 'user')
    {
      nullTurnResponseIndex += 1
      continue
    }
    if (message.role !== 'assistant')
    {
      continue
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id)
  }

  return new Set(lastAssistantMessageIdByResponseKey.values())
}

interface TurnFold
{
  turnId: TurnId
  anchorEntryId: string
  createdAt: string
  hiddenEntryIds: ReadonlySet<string>
  label: string
}

// the session's running turn is authoritative when latestTurn briefly lags or
// regresses behind it. Otherwise, the latest turn counts as unsettled while it
// is still running (or has not recorded a completion). This is deliberately
// keyed on turn lifecycle rather than transient working state: right after the
// user sends a message, the previous turn is still the "active" one until the
// server creates the new turn, and folding must not flicker through that window.
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null
{
  if (runningTurnId !== null)
  {
    return runningTurnId
  }
  if (!latestTurn)
  {
    return null
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== 'running'
  return isSettled ? null : latestTurn.turnId
}

function lastUserMessageIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number
{
  return timelineEntries.findLastIndex(
    (entry) => entry.kind === 'message' && entry.message.role === 'user',
  )
}

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null
{
  switch (entry.kind)
  {
    case 'message':
      return entry.message.role === 'assistant' ? (entry.message.turnId ?? null) : null
    case 'proposed-plan':
      return entry.proposedPlan.turnId
    case 'orchestrate-plan':
      return entry.revision.turnId
    case 'provider-switch':
      return entry.providerSwitch.turnId
    case 'work':
      return entry.entry.turnId ?? null
    case 'worker-verdict':
      return null
  }
}

// settled turns fold their commentary and tool activity behind a
// "Worked for ..." row anchored at the turn's first foldable entry; the
// terminal assistant message stays visible below the fold.
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>
  terminalAssistantMessageIds: ReadonlySet<string>
  latestTurn: TimelineLatestTurn | null
  unsettledTurnId: TurnId | null
}): ReadonlyMap<string, TurnFold>
{
  interface TurnGroup
  {
    entries: Array<TimelineEntry>
    terminalEntry: Extract<TimelineEntry, { kind: 'message' }> | null
    hasStreamingMessage: boolean
    // the user message that kicked the turn off. Entry timestamps alone
    // undercount the duration (the first entry appears only once the
    // provider starts producing output), and a turn cut short by a steer may
    // hold a single instantaneous commentary message.
    startBoundary: string | null
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>()

  let pendingUserBoundary: string | null = null
  for (const entry of input.timelineEntries)
  {
    if (entry.kind === 'message' && entry.message.role === 'user')
    {
      pendingUserBoundary = entry.message.createdAt
      continue
    }
    const turnId =
      entry.kind === 'message' && entry.message.role === 'assistant'
        ? (entry.message.turnId ?? null)
        : entry.kind === 'work'
          ? (entry.entry.turnId ?? null)
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
        terminalEntry: null,
        hasStreamingMessage: false,
        // each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      }
      pendingUserBoundary = null
      groupsByTurnId.set(turnId, group)
    }
    group.entries.push(entry)
    if (entry.kind === 'message')
    {
      if (input.terminalAssistantMessageIds.has(entry.message.id))
      {
        group.terminalEntry = entry
      }
      if (entry.message.streaming)
      {
        group.hasStreamingMessage = true
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>()
  for (const [turnId, group] of groupsByTurnId)
  {
    if (turnId === input.unsettledTurnId)
    {
      continue
    }
    if (group.hasStreamingMessage)
    {
      continue
    }
    const hiddenEntryIds = new Set<string>()
    for (const entry of group.entries)
    {
      const isForkTaskRow = entry.kind === 'work' && entry.entry.taskId !== undefined
      if (entry.id !== group.terminalEntry?.id && !isForkTaskRow)
      {
        hiddenEntryIds.add(entry.id)
      }
    }
    if (hiddenEntryIds.size === 0)
    {
      continue
    }

    const firstEntry = group.entries[0]
    const lastEntry = group.entries.at(-1)
    if (!firstEntry || !lastEntry)
    {
      continue
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === 'interrupted'
    // a turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === 'message' ? lastEntry.message.updatedAt : lastEntry.createdAt
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          )
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : 'You stopped this response'
      : duration
        ? `Worked for ${duration}`
        : 'Worked'

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    })
  }
  return foldsByAnchorEntryId
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>
  latestTurn?: TimelineLatestTurn | null
  runningTurnId?: TurnId | null
  expandedTurnIds?: ReadonlySet<TurnId>
  expandedWorkGroupIds?: ReadonlySet<string>
  isWorking: boolean
  activeTurnStartedAt: string | null
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>
}): MessagesTimelineRow[]
{
  const nextRows: MessagesTimelineRow[] = []
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === 'message' ? [entry.message] : [])),
  )
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries)
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  )
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  })
  const collapsedEntryIds = new Set<string>()
  for (const fold of foldsByAnchorEntryId.values())
  {
    if (!input.expandedTurnIds?.has(fold.turnId))
    {
      for (const entryId of fold.hiddenEntryIds)
      {
        collapsedEntryIds.add(entryId)
      }
    }
  }

  let activeTurnHeaderIndex = input.timelineEntries.length
  if (input.isWorking)
  {
    const latestUserMessageIndex = lastUserMessageIndex(input.timelineEntries)
    const firstOwnedAfterUser =
      unsettledTurnId === null
        ? -1
        : input.timelineEntries.findIndex(
            (entry, index) =>
              index > latestUserMessageIndex && timelineEntryTurnId(entry) === unsettledTurnId,
          )
    activeTurnHeaderIndex =
      firstOwnedAfterUser >= 0 ? firstOwnedAfterUser : latestUserMessageIndex + 1
  }
  const entryBelongsToActiveTurn = (entry: TimelineEntry, index: number) =>
    input.isWorking &&
    index >= activeTurnHeaderIndex &&
    (unsettledTurnId === null || timelineEntryTurnId(entry) === unsettledTurnId)
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    unsettledTurnId !== null &&
    entry.toolLifecycleStatus === 'inProgress' &&
    entry.turnId === unsettledTurnId
  const isVisibleActiveToolEntry = (entry: WorkLogEntry) =>
    entry.taskId === undefined &&
    workLogEntryIsToolLike(entry) &&
    workEntryIsVisibleInGroup(entry, true)
  const activeEntries = input.isWorking
    ? input.timelineEntries.filter((entry, index) => entryBelongsToActiveTurn(entry, index))
    : []
  const activeTurnHasVisibleContent = activeEntries.some((entry) =>
  {
    if (entry.kind === 'message')
    {
      return entry.message.role === 'assistant' && (entry.message.text?.trim().length ?? 0) > 0
    }
    if (entry.kind === 'work')
    {
      return (
        entry.entry.taskId === undefined &&
        workLogEntryIsToolLike(entry.entry) &&
        entry.entry.toolLifecycleStatus === 'inProgress'
      )
    }
    return (
      entry.kind === 'proposed-plan' ||
      entry.kind === 'orchestrate-plan' ||
      entry.kind === 'provider-switch' ||
      entry.kind === 'worker-verdict'
    )
  })

  const activeToolEntries: Array<Extract<TimelineEntry, { kind: 'work' }>> = []
  for (let index = input.timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1)
  {
    const entry = input.timelineEntries[index]!
    if (
      !entryBelongsToActiveTurn(entry, index) ||
      entry.kind !== 'work' ||
      entry.entry.taskId !== undefined ||
      entry.entry.tone === 'error' ||
      !workLogEntryIsToolLike(entry.entry)
    )
    {
      break
    }
    activeToolEntries.unshift(entry)
  }
  const activeWorkEntryIds = new Set(activeToolEntries.map((entry) => entry.id))
  const visibleActiveToolEntries = omitSupersededLifecycleMarkers(
    activeToolEntries.filter((entry) => isVisibleActiveToolEntry(entry.entry)),
    (entry) => entry.entry,
  )
  const activeWorkAnchor = activeToolEntries[0]
  const latestActiveToolEntry = visibleActiveToolEntries.at(-1)
  const activeWorkPlacementEntryId = latestActiveToolEntry?.id
  const activeWorkRow =
    activeWorkAnchor && latestActiveToolEntry
      ? (() =>
        {
          const groupId = workGroupId(activeWorkAnchor.id, activeWorkAnchor.entry)
          return {
            kind: 'work-live' as const,
            id: `work-live:${workGroupIdentity(activeWorkAnchor.id, activeWorkAnchor.entry)}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: latestActiveToolEntry.entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            hasFailure: visibleActiveToolEntries.some((entry) =>
              workEntryDisplayIndicatesToolFailure(entry.entry),
            ),
          }
        })()
      : null
  const appendWorkingRow = () =>
  {
    nextRows.push({
      kind: 'working',
      id: 'working-indicator-row',
      createdAt: input.activeTurnStartedAt,
      showThinking: activeWorkRow === null && !activeTurnHasVisibleContent,
    })
  }
  const appendActiveWorkRows = () =>
  {
    if (activeWorkRow === null) return
    nextRows.push(activeWorkRow)
    if (!activeWorkRow.expanded) return
    for (const [entryIndex, workEntry] of activeWorkRow.groupedEntries.entries())
    {
      nextRows.push({
        kind: 'work',
        id: workEntry.id,
        createdAt: workEntry.createdAt,
        groupedEntries: [workEntry],
        isExpandedToolGroupEntry: true,
        isLastExpandedToolGroupEntry: entryIndex === activeWorkRow.groupedEntries.length - 1,
      })
    }
  }

  for (let index = 0; index < input.timelineEntries.length; index += 1)
  {
    const timelineEntry = input.timelineEntries[index]
    if (!timelineEntry)
    {
      continue
    }

    if (input.isWorking && index === activeTurnHeaderIndex)
    {
      appendWorkingRow()
    }

    if (timelineEntry.id === activeWorkPlacementEntryId)
    {
      appendActiveWorkRows()
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id)
    if (turnFold)
    {
      nextRows.push({
        kind: 'turn-fold',
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      })
    }

    if (collapsedEntryIds.has(timelineEntry.id))
    {
      continue
    }

    if (activeWorkEntryIds.has(timelineEntry.id))
    {
      continue
    }

    if (timelineEntry.kind === 'work')
    {
      const groupedEntries = [timelineEntry.entry]
      let cursor = index + 1
      while (cursor < input.timelineEntries.length)
      {
        const nextEntry = input.timelineEntries[cursor]
        if (
          !nextEntry ||
          nextEntry.kind !== 'work' ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        )
        {
          break
        }
        groupedEntries.push(nextEntry.entry)
        cursor += 1
      }
      const visibleGroupedEntries = omitSupersededLifecycleMarkers(
        groupedEntries.filter((entry) =>
          workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
        ),
        (entry) => entry,
      )
      if (visibleGroupedEntries.length > 0)
      {
        const onlyToolEntries = visibleGroupedEntries.every(
          (entry) =>
            entry.taskId === undefined && entry.tone !== 'error' && workLogEntryIsToolLike(entry),
        )
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun)
        if (onlyToolEntries && activeInProgressToolEntries.length > 0)
        {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry)
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false
          const latestActiveEntry = activeInProgressToolEntries.at(-1)!
          nextRows.push({
            kind: 'work-live',
            id: `work-live:${workGroupIdentity(timelineEntry.id, timelineEntry.entry)}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            hasFailure: visibleGroupedEntries.some(workEntryDisplayIndicatesToolFailure),
          })
          if (expanded)
          {
            for (const [entryIndex, workEntry] of visibleGroupedEntries.entries())
            {
              nextRows.push({
                kind: 'work',
                id: workEntry.id,
                createdAt: workEntry.createdAt,
                groupedEntries: [workEntry],
                isExpandedToolGroupEntry: true,
                isLastExpandedToolGroupEntry: entryIndex === visibleGroupedEntries.length - 1,
              })
            }
          }
        }
        else if (onlyToolEntries)
        {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry)
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false
          nextRows.push({
            kind: 'work-toggle',
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            onlyToolEntries: true,
            summary: summarizeToolGroup(visibleGroupedEntries),
            summaryKind: toolGroupSummaryKind(visibleGroupedEntries),
            hasFailure: visibleGroupedEntries.some(workEntryDisplayIndicatesToolFailure),
          })
          if (expanded)
          {
            for (const [entryIndex, workEntry] of visibleGroupedEntries.entries())
            {
              nextRows.push({
                kind: 'work',
                id: workEntry.id,
                createdAt: workEntry.createdAt,
                groupedEntries: [workEntry],
                isExpandedToolGroupEntry: true,
                isLastExpandedToolGroupEntry: entryIndex === visibleGroupedEntries.length - 1,
              })
            }
          }
        }
        else if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES)
        {
          nextRows.push({
            kind: 'work',
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroupEntry: false,
            isLastExpandedToolGroupEntry: false,
          })
        }
        else
        {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry)
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES)
          const visibleEntries = visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
          const renderedEntries = expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries

          for (const workEntry of renderedEntries)
          {
            nextRows.push({
              kind: 'work',
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
              isExpandedToolGroupEntry: false,
              isLastExpandedToolGroupEntry: false,
            })
          }

          nextRows.push({
            kind: 'work-toggle',
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: hiddenEntries.length,
            expanded,
            onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry)),
            summary: null,
            summaryKind: null,
            hasFailure: hiddenEntries.some(workEntryDisplayIndicatesToolFailure),
          })
        }
      }
      index = cursor - 1
      continue
    }

    if (timelineEntry.kind === 'proposed-plan')
    {
      nextRows.push({
        kind: 'proposed-plan',
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      })
      continue
    }

    if (timelineEntry.kind === 'orchestrate-plan')
    {
      nextRows.push({
        kind: 'orchestrate-plan',
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        revision: timelineEntry.revision,
      })
      continue
    }

    if (timelineEntry.kind === 'provider-switch')
    {
      nextRows.push({
        kind: 'provider-switch',
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        event: timelineEntry.providerSwitch,
      })
      continue
    }

    if (timelineEntry.kind === 'worker-verdict')
    {
      nextRows.push({
        kind: 'worker-verdict',
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        workerVerdict: timelineEntry.workerVerdict,
      })
      continue
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === 'assistant' &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt

    // while the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === 'assistant' &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress

    nextRows.push({
      kind: 'message',
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === 'assistant'
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === 'user'
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    })
  }

  if (input.isWorking && activeTurnHeaderIndex === input.timelineEntries.length)
  {
    appendWorkingRow()
  }

  return nextRows
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState
{
  const next = new Map<string, MessagesTimelineRow>()
  let anyChanged = rows.length !== previous.byId.size

  const result = rows.map((row, index) =>
  {
    const prevRow = previous.byId.get(row.id)
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row
    next.set(row.id, nextRow)
    if (!anyChanged && previous.result[index] !== nextRow)
    {
      anyChanged = true
    }
    return nextRow
  })

  return anyChanged ? { byId: next, result } : previous
}

// shallow field comparison per row variant — avoids deep equality cost.
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean
{
  if (a.kind !== b.kind || a.id !== b.id) return false

  switch (a.kind)
  {
    case 'working':
      return (
        a.createdAt === (b as typeof a).createdAt && a.showThinking === (b as typeof a).showThinking
      )

    case 'turn-fold':
    {
      const bf = b as typeof a
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded
    }

    case 'proposed-plan':
      return a.proposedPlan === (b as typeof a).proposedPlan

    case 'orchestrate-plan':
      return a.revision === (b as typeof a).revision

    case 'provider-switch':
      return a.event === (b as typeof a).event

    case 'worker-verdict':
      return a.workerVerdict === (b as typeof a).workerVerdict

    case 'work':
    {
      const bw = b as typeof a
      return (
        a.isExpandedToolGroupEntry === bw.isExpandedToolGroupEntry &&
        a.isLastExpandedToolGroupEntry === bw.isLastExpandedToolGroupEntry &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      )
    }

    case 'work-live':
    {
      const bw = b as typeof a
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.hasFailure === bw.hasFailure &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      )
    }

    case 'work-toggle':
    {
      const bw = b as typeof a
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.hasFailure === bw.hasFailure
      )
    }

    case 'message':
    {
      const bm = b as typeof a
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      )
    }
  }
}
