// apps/mobile/src/lib/thread-activity/worklog.ts
// normalizes mobile work log activities for feed presentation
import {
  deriveNormalizedWorkLogEntries,
  normalizeCompactToolLabel,
  workEntryIndicatesToolFailure as normalizedWorkEntryIndicatesToolFailure,
  workEntryIndicatesToolRunning as normalizedWorkEntryIndicatesToolRunning,
  workEntryIndicatesToolSuccess as normalizedWorkEntryIndicatesToolSuccess,
  workLogEntryIsToolLike as normalizedWorkLogEntryIsToolLike,
  type NormalizedWorkLogEntry,
} from '@t3tools/client-runtime/thread-activity'
import type { OrchestrationThreadActivity, TurnId } from '@t3tools/contracts'

import { requestKindFromRequestType } from './pending'
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
  readonly status: 'success' | 'failure' | 'running' | 'neutral' | null
}

type WorkLogEntry = Omit<NormalizedWorkLogEntry, 'activityKind' | 'collapseKey' | 'toolCallId'>

type DerivedWorkLogEntry = NormalizedWorkLogEntry

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedWorkLogEntry[]
{
  return deriveNormalizedWorkLogEntries<DerivedWorkLogEntry>(activities, {
    requestKindFromRequestType,
    excludedActivityKinds: new Set([
      PROVIDER_SWITCH_COMPLETED_ACTIVITY_KIND,
      PROVIDER_SWITCH_FAILED_ACTIVITY_KIND,
    ]),
  })
}

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean
{
  return normalizedWorkLogEntryIsToolLike(entry, { thinkingIsToolLike: true })
}

function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean
{
  return normalizedWorkEntryIndicatesToolFailure(entry, { thinkingIsToolLike: true })
}

function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean
{
  return normalizedWorkEntryIndicatesToolSuccess(entry, { thinkingIsToolLike: true })
}

function workEntryIndicatesToolRunning(entry: WorkLogEntry): boolean
{
  return normalizedWorkEntryIndicatesToolRunning(entry, { thinkingIsToolLike: true })
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
  // heartbeats & other in-flight frames carry no completion of their own; the
  // check mark here claimed a tool had finished while it was still waiting
  if (workEntryIndicatesToolRunning(entry))
  {
    return 'running'
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
  // an approaching plan limit reads as a warning, not as an info row that scrolls past
  if (entry.activityKind === 'account.rate-limit.warning') return 'warning'
  // a compaction is the runtime working on itself; both halves of the pair share one mark
  if (
    entry.activityKind === 'context-compaction' ||
    entry.activityKind === 'context-compaction.started'
  )
  {
    return 'zap'
  }
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
