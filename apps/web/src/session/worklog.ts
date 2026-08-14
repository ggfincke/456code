// apps/web/src/session/worklog.ts
// derives and classifies session work log entries

import {
  asRecord,
  asTrimmedString,
  deriveNormalizedWorkLogEntries,
  mergeNormalizedWorkLogEntries,
  normalizeCompactToolLabel,
  stripTrailingExitCode,
  workEntryIndicatesToolFailure as normalizedWorkEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus as normalizedWorkEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolRunning as normalizedWorkEntryIndicatesToolRunning,
  workEntryIndicatesToolSuccess as normalizedWorkEntryIndicatesToolSuccess,
  workLogEntryIsToolLike as normalizedWorkLogEntryIsToolLike,
  type NormalizedWorkLogEntry,
  type WorkLogToolLifecycleStatus,
} from '@t3tools/client-runtime/thread-activity'
import {
  WORKER_VERDICT_ACTIVITY_KIND,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ToolLifecycleItemType,
  type TurnId,
} from '@t3tools/contracts'
export { formatDuration, formatElapsed } from '@t3tools/shared/orchestrationTiming'

import {
  PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
  PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
} from '../providerSwitchPresentation'
import type { Thread } from '../types'
import { requestKindFromRequestType, type PendingApproval } from './pending-turn'
export type { WorkLogToolLifecycleStatus }

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
  // provider-reported age of an in-flight tool call, carried on tool.progress
  // heartbeats so a running row can date itself from the tool's own start
  elapsedSeconds?: number
  taskId?: string
  model?: string
  subagentType?: string
  totalTokens?: number
  toolUses?: number
  durationMs?: number
  lastToolName?: string
  agentId?: string
  workflowName?: string
}

export interface WorkerVerdictEntry
{
  readonly id: string
  readonly runId: string
  readonly jobId: string
  readonly verdict: string
  readonly createdAt: string
}

export function workerVerdictKey(runId: string, jobId: string): string
{
  return JSON.stringify([runId, jobId])
}

export function deriveWorkerVerdictEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkerVerdictEntry[]
{
  return activities.flatMap((activity) =>
  {
    if (activity.kind !== WORKER_VERDICT_ACTIVITY_KIND)
    {
      return []
    }
    const payload = asRecord(activity.payload)
    const runId = asTrimmedString(payload?.runId)
    const jobId = asTrimmedString(payload?.jobId)
    const verdict = asTrimmedString(payload?.verdict)
    return runId === null || jobId === null || verdict === null
      ? []
      : [{ id: activity.id, runId, jobId, verdict, createdAt: activity.createdAt }]
  })
}

export function deriveWorkerVerdictMap(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, string>
{
  return new Map(
    deriveWorkerVerdictEntries(activities).map((entry) => [
      workerVerdictKey(entry.runId, entry.jobId),
      entry.verdict,
    ]),
  )
}

interface DerivedWorkLogEntry extends WorkLogEntry
{
  turnId: TurnId | null
  activityKind: OrchestrationThreadActivity['kind']
  collapseKey?: string
  toolCallId?: string
  taskToolUseId?: string
  parentToolUseId?: string
}

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean
{
  return normalizedWorkLogEntryIsToolLike(entry)
}

export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean
{
  return normalizedWorkEntryIndicatesToolFailure(entry)
}

export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean
{
  return normalizedWorkEntryIndicatesToolSuccess(entry)
}

export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean
{
  return normalizedWorkEntryIndicatesToolNeutralStatus(entry)
}

export function workEntryIndicatesToolRunning(entry: WorkLogEntry): boolean
{
  return normalizedWorkEntryIndicatesToolRunning(entry)
}

// a running row dates itself from the tool's own start instant, not from the
// heartbeat that happens to be newest: the collapsed row's createdAt advances
// with every heartbeat, so a timer keyed off it would restart every few seconds
export function workEntryRunningSince(entry: WorkLogEntry): string | null
{
  if (entry.elapsedSeconds === undefined)
  {
    return null
  }
  const observedAt = Date.parse(entry.createdAt)
  if (!Number.isFinite(observedAt))
  {
    return null
  }
  return new Date(observedAt - Math.max(0, entry.elapsedSeconds) * 1000).toISOString()
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
  return deriveNormalizedWorkLogEntries<DerivedWorkLogEntry>(activities, {
    requestKindFromRequestType,
    excludedActivityKinds: new Set([
      PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
      PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
      WORKER_VERDICT_ACTIVITY_KIND,
    ]),
    includeTaskStarted: true,
    mapEntry: mapWebWorkLogEntry,
    finalizeEntries: collapseTaskWorkLogEntries,
  }).map((entry) =>
  {
    const {
      activityKind,
      collapseKey: _collapseKey,
      taskToolUseId: _taskToolUseId,
      parentToolUseId: _parentToolUseId,
      ...rest
    } = entry
    return Object.assign(rest, { sourceActivityKind: activityKind })
  })
}

function mapWebWorkLogEntry(input: {
  readonly activity: OrchestrationThreadActivity
  readonly payload: Record<string, unknown> | null
  readonly entry: NormalizedWorkLogEntry
}): DerivedWorkLogEntry
{
  const { activity, payload } = input
  const { detail: _baseDetail, ...base } = input.entry
  const isTaskActivity =
    activity.kind === 'task.started' ||
    activity.kind === 'task.progress' ||
    activity.kind === 'task.completed'
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
  const detail = isTaskActivity
    ? !taskDetailAsLabel && typeof payload?.detail === 'string'
      ? stripTrailingExitCode(payload.detail).output
      : taskTextDetail
    : extractToolDetail(payload, input.entry.toolTitle ?? activity.summary, input.entry.itemType)
  const entry: DerivedWorkLogEntry = {
    ...base,
    label: taskSummary ?? taskDetailAsLabel ?? activity.summary,
    tone:
      activity.kind === 'task.started' || activity.kind === 'task.progress'
        ? 'thinking'
        : input.entry.tone,
    ...(detail ? { detail } : {}),
  }
  if (isTaskActivity)
  {
    // subagent identity + usage captured by the adapter ride on task payloads
    const taskId = asTrimmedString(payload?.taskId)
    const taskToolUseId = asTrimmedString(payload?.toolUseId)
    const tokenUsage = asRecord(payload?.tokenUsage)
    const totalTokens = asNumber(tokenUsage?.totalTokens)
    const toolUses = asNumber(payload?.totalToolUseCount) ?? asNumber(tokenUsage?.toolUses)
    const durationMs = asNumber(payload?.totalDurationMs) ?? asNumber(tokenUsage?.durationMs)
    const model = asTrimmedString(payload?.model)
    const subagentType = asTrimmedString(payload?.subagentType)
    const lastToolName = asTrimmedString(payload?.lastToolName)
    const agentId = asTrimmedString(payload?.agentId)
    const workflowName = asTrimmedString(payload?.workflowName)
    if (taskId) entry.taskId = taskId
    if (taskToolUseId) entry.taskToolUseId = taskToolUseId
    if (model) entry.model = model
    if (subagentType) entry.subagentType = subagentType
    if (totalTokens !== null) entry.totalTokens = totalTokens
    if (toolUses !== null) entry.toolUses = toolUses
    if (durationMs !== null) entry.durationMs = durationMs
    if (lastToolName) entry.lastToolName = lastToolName
    if (agentId) entry.agentId = agentId
    if (workflowName) entry.workflowName = workflowName
  }
  else if (activity.kind === 'tool.progress')
  {
    const parentToolUseId = asTrimmedString(payload?.parentToolUseId)
    const lastToolName = asTrimmedString(payload?.toolName)
    const elapsedSeconds = asNumber(payload?.elapsedSeconds)
    if (parentToolUseId) entry.parentToolUseId = parentToolUseId
    if (lastToolName) entry.lastToolName = lastToolName
    if (elapsedSeconds !== null) entry.elapsedSeconds = elapsedSeconds
  }
  if (
    entry.toolLifecycleStatus === undefined &&
    (activity.kind === 'task.started' || activity.kind === 'task.progress')
  )
  {
    entry.toolLifecycleStatus = 'inProgress'
  }
  return entry
}

function collapseTaskWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[]
{
  const collapsed: DerivedWorkLogEntry[] = []
  // task lifecycle rows collapse by taskId into one live row & nested
  // tool.progress rows update their owning task's last-tool label. a
  // lead-level heartbeat owns no task row, so it falls through as the live row
  // the shared pass already collapsed by tool call id
  const taskIndexById = new Map<string, number>()
  const taskIdByToolUseId = new Map<string, string>()
  for (const entry of entries)
  {
    if (entry.activityKind === 'tool.progress' && entry.parentToolUseId)
    {
      const taskId = taskIdByToolUseId.get(entry.parentToolUseId)
      const taskIndex = taskId ? taskIndexById.get(taskId) : undefined
      if (taskIndex !== undefined)
      {
        if (entry.lastToolName)
        {
          const taskEntry = collapsed[taskIndex]
          if (taskEntry && taskEntry.activityKind !== 'task.completed')
          {
            collapsed[taskIndex] = { ...taskEntry, lastToolName: entry.lastToolName }
          }
        }
        continue
      }
    }
    if (entry.taskId)
    {
      const existingIndex = taskIndexById.get(entry.taskId)
      if (existingIndex === undefined)
      {
        taskIndexById.set(entry.taskId, collapsed.length)
        collapsed.push(entry)
      }
      else
      {
        const previous = collapsed[existingIndex]
        if (
          previous &&
          (previous.activityKind !== 'task.completed' || entry.activityKind === 'task.completed')
        )
        {
          collapsed[existingIndex] = {
            ...mergeNormalizedWorkLogEntries(previous, entry),
            id: previous.id,
            createdAt: previous.createdAt,
          }
        }
      }
      const taskIndex = taskIndexById.get(entry.taskId)
      const taskToolUseId =
        taskIndex === undefined ? undefined : collapsed[taskIndex]?.taskToolUseId
      if (taskToolUseId)
      {
        taskIdByToolUseId.set(taskToolUseId, entry.taskId)
      }
      continue
    }
    collapsed.push(entry)
  }
  return collapsed
}

function asNumber(value: unknown): number | null
{
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

function isCommandToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
  itemType: ToolLifecycleItemType | undefined,
): boolean
{
  const data = asRecord(payload?.data)
  const kind = asTrimmedString(data?.kind)?.toLowerCase()
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase()
  return (
    itemType === 'command_execution' ||
    kind === 'execute' ||
    title === 'terminal' ||
    title === 'ran command'
  )
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
  itemType: ToolLifecycleItemType | undefined,
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

  if (isCommandToolDetail(payload, heading, itemType))
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
