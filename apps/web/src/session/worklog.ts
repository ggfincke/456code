// apps/web/src/session/worklog.ts
// derives and classifies session work log entries

import {
  asRecord,
  asTrimmedString,
  extractChangedFiles,
  extractToolCommand,
  extractWorkLogRequestKind,
  normalizeCompactToolLabel,
  stripTrailingExitCode,
} from '@t3tools/client-runtime/thread-activity'
import {
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ToolLifecycleItemType,
  type TurnId,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'

import {
  PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
  PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
} from '../providerSwitchPresentation'
import type { Thread } from '../types'
import { requestKindFromRequestType, type PendingApproval } from './pending-turn'
export type WorkLogToolLifecycleStatus =
  'inProgress' | 'completed' | 'failed' | 'declined' | 'stopped'

export interface WorkLogEntry
{
  id: string
  createdAt: string
  turnId?: TurnId | null
  label: string
  detail?: string
  command?: string
  rawCommand?: string
  changedFiles?: ReadonlyArray<string>
  tone: 'thinking' | 'tool' | 'info' | 'error'
  toolTitle?: string
  toolData?: unknown
  itemType?: ToolLifecycleItemType
  requestKind?: PendingApproval['requestKind']
  // from runtime item / task payload `status` when present (e.g. tool.updated).
  toolLifecycleStatus?: WorkLogToolLifecycleStatus
  // originating orchestration activity kind (e.g. `user-input.requested`) for row chrome.
  sourceActivityKind?: OrchestrationThreadActivity['kind']
}

interface DerivedWorkLogEntry extends WorkLogEntry
{
  activityKind: OrchestrationThreadActivity['kind']
  collapseKey?: string
  toolCallId?: string
}

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean
{
  if (entry.tone === 'tool' || entry.tone === 'error')
  {
    return true
  }
  if (entry.command !== undefined && entry.command.trim().length > 0)
  {
    return true
  }
  if (entry.requestKind !== undefined)
  {
    return true
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType)
}

// heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`.
function toolDetailTextLooksLikeFailure(text: string): boolean
{
  const t = text.toLowerCase()
  if (t.includes('file not found'))
  {
    return true
  }
  if (t.includes('no files found'))
  {
    return true
  }
  if (
    t.includes('enoent') ||
    t.includes('no such file or directory') ||
    t.includes('no such file')
  )
  {
    return true
  }
  if (t.includes('cannot find path') && t.includes('because it does not exist'))
  {
    return true
  }
  if (t.includes('commandnotfoundexception'))
  {
    return true
  }
  if (t.includes('is not recognized as the name of a cmdlet'))
  {
    return true
  }
  if (t.includes('is not recognized') && t.includes("the term '"))
  {
    return true
  }
  if (t.includes('a parameter cannot be found that matches parameter name'))
  {
    return true
  }
  if (t.includes('command not found'))
  {
    return true
  }
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text))
  {
    return true
  }
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text))
  {
    return true
  }
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text))
  {
    return true
  }
  return false
}

// true when the row should show a failure affordance (explicit status/tone or error-shaped tool output).
export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean
{
  if (entry.tone === 'error')
  {
    return true
  }
  const ls = entry.toolLifecycleStatus
  if (ls === 'failed' || ls === 'declined')
  {
    return true
  }
  if (!workLogEntryIsToolLike(entry))
  {
    return false
  }
  const parts: string[] = []
  if (entry.detail)
  {
    parts.push(entry.detail)
  }
  if (entry.command)
  {
    parts.push(entry.command)
  }
  const blob = parts.join('\n')
  if (blob.length === 0)
  {
    return false
  }
  return toolDetailTextLooksLikeFailure(blob)
}

// tool/command row completed without failure (blue check affordance).
export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean
{
  if (!workLogEntryIsToolLike(entry))
  {
    return false
  }
  if (workEntryIndicatesToolFailure(entry))
  {
    return false
  }
  if (entry.tone === 'thinking')
  {
    return false
  }
  const ls = entry.toolLifecycleStatus
  if (ls === 'failed' || ls === 'declined')
  {
    return false
  }
  if (ls === 'inProgress')
  {
    return false
  }
  if (ls === 'stopped')
  {
    return false
  }
  return true
}

// tool-like row with neither clear success nor failure (empty, incomplete, in progress, etc.).
export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean
{
  if (!workLogEntryIsToolLike(entry))
  {
    return false
  }
  if (workEntryIndicatesToolFailure(entry))
  {
    return false
  }
  if (workEntryIndicatesToolSuccess(entry))
  {
    return false
  }
  return true
}

export function formatDuration(durationMs: number): string
{
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0ms'
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`
  if (durationMs < 10_000)
  {
    const tenths = Math.round(durationMs / 100) / 10
    // 9.95s+ rounds up to the next bucket — render "10s", not "10.0s".
    return tenths >= 10 ? '10s' : `${tenths.toFixed(1)}s`
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  if (seconds === 0) return `${minutes}m`
  if (seconds === 60) return `${minutes + 1}m`
  return `${minutes}m ${seconds}s`
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null
{
  if (!endIso) return null
  const startedAt = Date.parse(startIso)
  const endedAt = Date.parse(endIso)
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt)
  {
    return null
  }
  return formatDuration(endedAt - startedAt)
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, 'turnId' | 'startedAt' | 'completedAt'>
type SessionActivityState = Pick<NonNullable<Thread['session']>, 'status' | 'activeTurnId'>

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean
{
  if (!latestTurn?.startedAt) return false
  if (!latestTurn.completedAt) return false
  if (!session) return true
  if (session.status === 'running') return false
  return true
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null
{
  const runningTurnId = session?.status === 'running' ? session.activeTurnId : null
  if (runningTurnId !== null)
  {
    if (latestTurn?.turnId === runningTurnId)
    {
      return latestTurn.startedAt ?? sendStartedAt
    }
    return sendStartedAt
  }
  if (!isLatestTurnSettled(latestTurn, session))
  {
    return latestTurn?.startedAt ?? sendStartedAt
  }
  return sendStartedAt
}
export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[]
{
  const ordered = [...activities].toSorted(compareOrchestrationThreadActivities)
  const entries: DerivedWorkLogEntry[] = []
  for (const activity of ordered)
  {
    if (activity.kind === 'tool.started') continue
    if (activity.kind === 'task.started') continue
    if (activity.kind === 'context-window.updated') continue
    // switch outcomes render as timeline dividers instead of work-log rows
    if (activity.kind === PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND) continue
    if (activity.kind === PROVIDER_SWITCH_FAILED_ACTIVITY_KIND) continue
    if (activity.summary === 'Checkpoint captured') continue
    if (isPlanBoundaryToolActivity(activity)) continue
    entries.push(toDerivedWorkLogEntry(activity))
  }
  return collapseDerivedWorkLogEntries(entries).map((entry) =>
  {
    const { activityKind, collapseKey: _collapseKey, ...rest } = entry
    return Object.assign(rest, { sourceActivityKind: activityKind })
  })
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean
{
  if (activity.kind !== 'tool.updated' && activity.kind !== 'tool.completed')
  {
    return false
  }

  const payload =
    activity.payload && typeof activity.payload === 'object'
      ? (activity.payload as Record<string, unknown>)
      : null
  return typeof payload?.detail === 'string' && payload.detail.startsWith('ExitPlanMode:')
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined
{
  if (!payload)
  {
    return undefined
  }
  const s = payload.status
  if (
    s === 'inProgress' ||
    s === 'completed' ||
    s === 'failed' ||
    s === 'declined' ||
    s === 'stopped'
  )
  {
    return s
  }
  return undefined
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry
{
  const payload =
    activity.payload && typeof activity.payload === 'object'
      ? (activity.payload as Record<string, unknown>)
      : null
  const commandPreview = extractToolCommand(payload)
  const changedFiles = extractChangedFiles(payload)
  const title = extractToolTitle(payload)
  const isTaskActivity = activity.kind === 'task.progress' || activity.kind === 'task.completed'
  const taskSummary =
    isTaskActivity && typeof payload?.summary === 'string' && payload.summary.length > 0
      ? payload.summary
      : null
  const taskTextDetail =
    isTaskActivity && typeof payload?.text === 'string' && payload.text.length > 0
      ? payload.text
      : null
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    !taskTextDetail &&
    typeof payload?.detail === 'string' &&
    payload.detail.length > 0
      ? payload.detail
      : null
  const taskLabel = taskSummary || taskDetailAsLabel
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === 'string' &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : taskTextDetail
    : extractToolDetail(payload, title ?? activity.summary)
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload)
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel || activity.summary,
    tone:
      activity.kind === 'task.progress'
        ? 'thinking'
        : activity.tone === 'approval'
          ? 'info'
          : activity.tone,
    activityKind: activity.kind,
  }
  const itemType = extractWorkLogItemType(payload)
  const requestKind = extractWorkLogRequestKind(payload, requestKindFromRequestType)
  if (detail)
  {
    entry.detail = detail
  }
  if (commandPreview.command)
  {
    entry.command = commandPreview.command
  }
  if (commandPreview.rawCommand)
  {
    entry.rawCommand = commandPreview.rawCommand
  }
  if (changedFiles.length > 0)
  {
    entry.changedFiles = changedFiles
  }
  if (title)
  {
    entry.toolTitle = title
  }
  if (itemType === 'mcp_tool_call')
  {
    const data = asRecord(payload?.data)
    if (data?.item !== undefined)
    {
      entry.toolData = data.item
    }
  }
  if (itemType)
  {
    entry.itemType = itemType
  }
  if (requestKind)
  {
    entry.requestKind = requestKind
  }
  if (toolCallId)
  {
    entry.toolCallId = toolCallId
  }
  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload)
  if (!toolLifecycleStatus && activity.kind === 'tool.completed')
  {
    toolLifecycleStatus = 'completed'
  }
  if (toolLifecycleStatus)
  {
    entry.toolLifecycleStatus = toolLifecycleStatus
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry)
  if (collapseKey)
  {
    entry.collapseKey = collapseKey
  }
  return entry
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[]
{
  const collapsed: DerivedWorkLogEntry[] = []
  for (const entry of entries)
  {
    const previous = collapsed.at(-1)
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry))
    {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry)
      continue
    }
    collapsed.push(entry)
  }
  return collapsed
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean
{
  if (previous.activityKind !== 'tool.updated' && previous.activityKind !== 'tool.completed')
  {
    return false
  }
  if (next.activityKind !== 'tool.updated' && next.activityKind !== 'tool.completed')
  {
    return false
  }
  if (previous.activityKind === 'tool.completed')
  {
    return false
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey)
  {
    return true
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  )
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry
{
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles)
  const detail = next.detail ?? previous.detail
  const command = next.command ?? previous.command
  const rawCommand = next.rawCommand ?? previous.rawCommand
  const toolTitle = next.toolTitle ?? previous.toolTitle
  const itemType = next.itemType ?? previous.itemType
  const requestKind = next.requestKind ?? previous.requestKind
  const collapseKey = next.collapseKey ?? previous.collapseKey
  const toolCallId = next.toolCallId ?? previous.toolCallId
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus
  const toolData = next.toolData ?? previous.toolData
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
  }
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[]
{
  const merged = [...(previous ?? []), ...(next ?? [])]
  if (merged.length === 0)
  {
    return []
  }
  return [...new Set(merged)]
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined
{
  if (entry.activityKind !== 'tool.updated' && entry.activityKind !== 'tool.completed')
  {
    return undefined
  }
  if (entry.toolCallId)
  {
    return `tool:${entry.toolCallId}`
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label)
  const detail = entry.detail?.trim() ?? ''
  const itemType = entry.itemType ?? ''
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0)
  {
    return undefined
  }
  return [itemType, normalizedLabel, detail].join('\u001f')
}

function asNumber(value: unknown): number | null
{
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null
{
  return asTrimmedString(payload?.title)
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null
{
  const data = asRecord(payload?.data)
  return asTrimmedString(data?.toolCallId)
}

function normalizeInlinePreview(value: string): string
{
  return value.replace(/\s+/g, ' ').trim()
}

function truncateInlinePreview(value: string, maxLength = 84): string
{
  if (value.length <= maxLength)
  {
    return value
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function normalizePreviewForComparison(value: string | null | undefined): string | null
{
  const normalized = asTrimmedString(value)
  if (!normalized)
  {
    return null
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase()
}

function summarizeToolTextOutput(value: string): string | null
{
  const lines: Array<string> = []
  for (const rawLine of value.split(/\r?\n/u))
  {
    const line = normalizeInlinePreview(rawLine)
    if (line.length > 0)
    {
      lines.push(line)
    }
  }
  const firstLine = lines.find((line) => line !== '```')
  if (firstLine)
  {
    return truncateInlinePreview(firstLine)
  }
  if (lines.length > 1)
  {
    return `${lines.length.toLocaleString()} lines`
  }
  return null
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null
{
  const data = asRecord(payload?.data)
  const rawOutput = asRecord(data?.rawOutput)
  if (!rawOutput)
  {
    return null
  }

  const totalFiles = asNumber(rawOutput.totalFiles)
  if (totalFiles !== null)
  {
    const suffix = rawOutput.truncated === true ? '+' : ''
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? '' : 's'}${suffix}`
  }

  const content = asTrimmedString(rawOutput.content)
  if (content)
  {
    return summarizeToolTextOutput(content)
  }

  const stdout = asTrimmedString(rawOutput.stdout)
  if (stdout)
  {
    return summarizeToolTextOutput(stdout)
  }

  return null
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean
{
  const data = asRecord(payload?.data)
  const kind = asTrimmedString(data?.kind)?.toLowerCase()
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase()
  return (
    extractWorkLogItemType(payload) === 'command_execution' ||
    kind === 'execute' ||
    title === 'terminal' ||
    title === 'ran command'
  )
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null
{
  const rawDetail = asTrimmedString(payload?.detail)
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null
  const normalizedHeading = normalizePreviewForComparison(heading)
  const normalizedDetail = normalizePreviewForComparison(detail)

  if (detail && normalizedHeading !== normalizedDetail)
  {
    return detail
  }

  if (isCommandToolDetail(payload, heading))
  {
    return null
  }

  const rawOutputSummary = summarizeToolRawOutput(payload)
  if (rawOutputSummary)
  {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary)
    if (normalizedRawOutputSummary !== normalizedHeading)
    {
      return rawOutputSummary
    }
  }

  return null
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry['itemType'] | undefined
{
  if (typeof payload?.itemType === 'string' && isToolLifecycleItemType(payload.itemType))
  {
    return payload.itemType
  }
  return undefined
}
