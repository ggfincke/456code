// apps/mobile/src/lib/thread-activity/worklog.ts
// normalizes mobile work log activities for feed presentation
import {
  asRecord,
  asTrimmedString,
  extractChangedFiles,
  extractToolCommand,
  extractWorkLogRequestKind,
  normalizeCompactToolLabel,
  stripTrailingExitCode,
} from '@t3tools/client-runtime/thread-activity'
import type { OrchestrationThreadActivity, ToolLifecycleItemType, TurnId } from '@t3tools/contracts'
import { isToolLifecycleItemType } from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'

import { requestKindFromRequestType, type PendingApproval } from './pending'
import {
  PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
  PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
} from './provider-switch'
export interface ThreadFeedActivity
{
  readonly id: string
  readonly createdAt: string
  readonly turnId: TurnId | null
  readonly summary: string
  readonly detail: string | null
  readonly canExpand: boolean
  readonly getFullDetail: () => string | null
  readonly getCopyText: () => string
  readonly icon:
    | 'agent'
    | 'alert'
    | 'check'
    | 'command'
    | 'edit'
    | 'eye'
    | 'globe'
    | 'hammer'
    | 'message'
    | 'warning'
    | 'wrench'
    | 'zap'
  readonly toolLike: boolean
  readonly status: 'success' | 'failure' | 'neutral' | null
}

type WorkLogToolLifecycleStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'stopped'

interface WorkLogEntry
{
  id: string
  createdAt: string
  turnId: TurnId | null
  label: string
  detail?: string
  command?: string
  rawCommand?: string
  changedFiles?: ReadonlyArray<string>
  tone: 'thinking' | 'tool' | 'info' | 'error'
  toolTitle?: string
  itemType?: ToolLifecycleItemType
  requestKind?: PendingApproval['requestKind']
  toolLifecycleStatus?: WorkLogToolLifecycleStatus
  toolData?: unknown
}

interface DerivedWorkLogEntry extends WorkLogEntry
{
  activityKind: OrchestrationThreadActivity['kind']
  collapseKey?: string
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedWorkLogEntry[]
{
  const ordered = [...activities].toSorted(compareOrchestrationThreadActivities)
  const entries: DerivedWorkLogEntry[] = []
  for (const activity of ordered)
  {
    if (activity.kind === 'tool.started') continue
    if (activity.kind === 'task.started') continue
    if (activity.kind === 'context-window.updated') continue
    // switch outcomes belong to the composer notice, not the work log
    if (activity.kind === PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND) continue
    if (activity.kind === PROVIDER_SWITCH_FAILED_ACTIVITY_KIND) continue
    if (activity.summary === 'Checkpoint captured') continue
    if (isPlanBoundaryToolActivity(activity)) continue
    entries.push(toDerivedWorkLogEntry(activity))
  }
  return collapseDerivedWorkLogEntries(entries)
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
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === 'string' &&
    payload.detail.length > 0
      ? payload.detail
      : null
  const taskLabel = taskSummary || taskDetailAsLabel
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
  if (
    !taskDetailAsLabel &&
    payload &&
    typeof payload.detail === 'string' &&
    payload.detail.length > 0
  )
  {
    const detail = stripTrailingExitCode(payload.detail).output
    if (detail)
    {
      entry.detail = detail
    }
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
  return previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey
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
    ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
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
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label)
  const detail = entry.detail?.trim() ?? ''
  const itemType = entry.itemType ?? ''
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0)
  {
    return undefined
  }
  return [itemType, normalizedLabel, detail].join('\u001f')
}

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean
{
  if (entry.tone === 'tool' || entry.tone === 'thinking' || entry.tone === 'error')
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

function toolDetailTextLooksLikeFailure(text: string): boolean
{
  const normalized = text.toLowerCase()
  return (
    normalized.includes('file not found') ||
    normalized.includes('no files found') ||
    normalized.includes('enoent') ||
    normalized.includes('no such file or directory') ||
    normalized.includes('no such file') ||
    normalized.includes('commandnotfoundexception') ||
    normalized.includes('command not found') ||
    (normalized.includes('cannot find path') && normalized.includes('because it does not exist')) ||
    (normalized.includes('is not recognized') && normalized.includes("the term '")) ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  )
}

function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean
{
  if (entry.tone === 'error')
  {
    return true
  }
  if (entry.toolLifecycleStatus === 'failed' || entry.toolLifecycleStatus === 'declined')
  {
    return true
  }
  if (!workLogEntryIsToolLike(entry))
  {
    return false
  }
  return toolDetailTextLooksLikeFailure([entry.detail, entry.command].filter(Boolean).join('\n'))
}

function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean
{
  if (!workLogEntryIsToolLike(entry) || workEntryIndicatesToolFailure(entry))
  {
    return false
  }
  if (entry.tone === 'thinking')
  {
    return false
  }
  return (
    entry.toolLifecycleStatus !== 'inProgress' &&
    entry.toolLifecycleStatus !== 'stopped' &&
    entry.toolLifecycleStatus !== 'failed' &&
    entry.toolLifecycleStatus !== 'declined'
  )
}

export function workEntryStatus(entry: WorkLogEntry): ThreadFeedActivity['status']
{
  if (!workLogEntryIsToolLike(entry))
  {
    return null
  }
  if (workEntryIndicatesToolFailure(entry))
  {
    return 'failure'
  }
  if (workEntryIndicatesToolSuccess(entry))
  {
    return 'success'
  }
  return 'neutral'
}

export function workEntryIcon(entry: DerivedWorkLogEntry): ThreadFeedActivity['icon']
{
  if (
    entry.activityKind === 'user-input.requested' ||
    entry.activityKind === 'user-input.resolved'
  )
  {
    return 'message'
  }
  if (entry.activityKind === 'runtime.warning') return 'warning'
  if (entry.requestKind === 'command') return 'command'
  if (entry.requestKind === 'file-read') return 'eye'
  if (entry.requestKind === 'file-change') return 'edit'
  if (entry.itemType === 'command_execution' || entry.command) return 'command'
  if (entry.itemType === 'file_change' || (entry.changedFiles?.length ?? 0) > 0) return 'edit'
  if (entry.itemType === 'web_search') return 'globe'
  if (entry.itemType === 'image_view') return 'eye'
  if (entry.itemType === 'mcp_tool_call') return 'wrench'
  if (entry.itemType === 'dynamic_tool_call' || entry.itemType === 'collab_agent_tool_call')
  {
    return 'hammer'
  }
  if (entry.tone === 'error') return 'alert'
  if (entry.tone === 'thinking') return 'agent'
  if (entry.tone === 'info') return 'check'
  return 'zap'
}

export function buildWorkEntryExpandedBody(entry: WorkLogEntry): string | null
{
  const blocks: string[] = []
  const appendUniqueBlock = (value: string | null | undefined) =>
  {
    const trimmed = value?.trim()
    if (trimmed && !blocks.includes(trimmed))
    {
      blocks.push(trimmed)
    }
  }

  if (entry.itemType === 'mcp_tool_call' && entry.toolData !== undefined)
  {
    appendUniqueBlock(`MCP call\n${JSON.stringify(entry.toolData, null, 2)}`)
  }
  appendUniqueBlock(entry.rawCommand ?? entry.command)
  appendUniqueBlock(entry.detail)
  if ((entry.changedFiles?.length ?? 0) > 0)
  {
    appendUniqueBlock(entry.changedFiles!.join('\n'))
  }

  return blocks.length > 0 ? blocks.join('\n\n') : null
}

export function workEntryHasExpandedBody(entry: WorkLogEntry): boolean
{
  return (
    (entry.itemType === 'mcp_tool_call' && entry.toolData !== undefined) ||
    Boolean((entry.rawCommand ?? entry.command)?.trim()) ||
    Boolean(entry.detail?.trim()) ||
    (entry.changedFiles?.some((path) => path.trim().length > 0) ?? false)
  )
}

export function memoizeValue<T>(build: () => T): () => T
{
  let value: T
  let initialized = false
  return () =>
  {
    if (!initialized)
    {
      value = build()
      initialized = true
    }
    return value
  }
}

export function workEntryPreview(
  workEntry: Pick<WorkLogEntry, 'detail' | 'command' | 'changedFiles'>,
): string | null
{
  if (workEntry.command) return workEntry.command
  if (workEntry.detail) return workEntry.detail
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null
  const [firstPath] = workEntry.changedFiles ?? []
  if (!firstPath) return null
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`
}

function capitalizePhrase(value: string): string
{
  const trimmed = value.trim()
  if (trimmed.length === 0)
  {
    return value
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
}

export function workEntryHeading(workEntry: WorkLogEntry): string
{
  if (!workEntry.toolTitle)
  {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label))
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle))
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null
{
  return asTrimmedString(payload?.title)
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined
{
  const status = payload?.status
  if (
    status === 'inProgress' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'declined' ||
    status === 'stopped'
  )
  {
    return status
  }
  return undefined
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
