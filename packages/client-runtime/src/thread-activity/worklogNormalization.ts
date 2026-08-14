// packages/client-runtime/src/thread-activity/worklogNormalization.ts
// normalizes provider thread activity payloads into work log fields shared by web & mobile

import type {
  OrchestrationThreadActivity,
  ToolLifecycleItemType,
  TurnId,
  UserInputQuestion,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'
import { isToolLifecycleItemType } from '@t3tools/shared/toolActivity'

export type WorkLogRequestKind = 'command' | 'file-read' | 'file-change'

export type WorkLogToolLifecycleStatus =
  'inProgress' | 'completed' | 'failed' | 'declined' | 'stopped'

export interface NormalizedWorkLogEntry
{
  readonly id: string
  readonly createdAt: string
  readonly turnId: TurnId | null
  readonly label: string
  readonly tone: 'thinking' | 'tool' | 'info' | 'error'
  readonly activityKind: OrchestrationThreadActivity['kind']
  readonly detail?: string
  readonly command?: string
  readonly rawCommand?: string
  readonly changedFiles?: ReadonlyArray<string>
  readonly toolTitle?: string
  readonly toolData?: unknown
  readonly itemType?: ToolLifecycleItemType
  readonly requestKind?: WorkLogRequestKind
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus
  readonly collapseKey?: string
  readonly toolCallId?: string
}

export interface NormalizeWorkLogOptions<T extends NormalizedWorkLogEntry>
{
  readonly requestKindFromRequestType: (requestType: unknown) => WorkLogRequestKind | null
  readonly excludedActivityKinds?: ReadonlySet<string>
  readonly includeTaskStarted?: boolean
  readonly mapEntry?: (input: {
    readonly activity: OrchestrationThreadActivity
    readonly payload: Record<string, unknown> | null
    readonly entry: NormalizedWorkLogEntry
  }) => T
  readonly finalizeEntries?: (entries: ReadonlyArray<T>) => ReadonlyArray<T>
}

export interface WorkLogClassificationOptions
{
  readonly thinkingIsToolLike?: boolean
}

export function asRecord(value: unknown): Record<string, unknown> | null
{
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function asTrimmedString(value: unknown): string | null
{
  if (typeof value !== 'string')
  {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNonEmptyString(value: unknown): string | null
{
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function stripTrailingExitCode(value: string): {
  output: string | null
  exitCode?: number | undefined
}
{
  const trimmed = value.trim()
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(trimmed)
  if (!match?.groups)
  {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    }
  }
  const exitCode = Number.parseInt(match.groups.code ?? '', 10)
  const normalizedOutput = match.groups.output?.trim() ?? ''
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  }
}

// drops the trailing "complete"/"completed" suffix providers append to repeated tool labels
export function normalizeCompactToolLabel(value: string): string
{
  return value.replace(/\s+(?:complete|completed)\s*$/i, '').trim()
}

function trimMatchingOuterQuotes(value: string): string
{
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  )
  {
    const unquoted = trimmed.slice(1, -1).trim()
    return unquoted.length > 0 ? unquoted : trimmed
  }
  return trimmed
}

function executableBasename(value: string): string | null
{
  const trimmed = trimMatchingOuterQuotes(value)
  if (trimmed.length === 0)
  {
    return null
  }
  const normalized = trimmed.replace(/\\/g, '/')
  const segments = normalized.split('/')
  const last = segments.at(-1)?.trim() ?? ''
  return last.length > 0 ? last.toLowerCase() : null
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null
{
  const trimmed = value.trim()
  if (trimmed.length === 0)
  {
    return null
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'"))
  {
    const quote = trimmed.charAt(0)
    const closeIndex = trimmed.indexOf(quote, 1)
    if (closeIndex <= 0)
    {
      return null
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    }
  }

  const firstWhitespace = trimmed.search(/\s/)
  if (firstWhitespace < 0)
  {
    return {
      executable: trimmed,
      rest: '',
    }
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  }
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ['cmd', 'cmd.exe'],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ['bash', 'sh', 'zsh'],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const

function findShellWrapperSpec(shell: string)
{
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  )
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null
{
  const match = wrapperFlagPattern.exec(value)
  if (!match)
  {
    return null
  }

  const command = value.slice(match.index + match[0].length).trim()
  if (command.length === 0)
  {
    return null
  }

  const unwrapped = trimMatchingOuterQuotes(command)
  return unwrapped.length > 0 ? unwrapped : null
}

function unwrapKnownShellCommandWrapper(value: string): string
{
  const split = splitExecutableAndRest(value)
  if (!split || split.rest.length === 0)
  {
    return value
  }

  const shell = executableBasename(split.executable)
  if (!shell)
  {
    return value
  }

  const spec = findShellWrapperSpec(shell)
  if (!spec)
  {
    return value
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value
}

function formatCommandArrayPart(value: string): string
{
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function formatCommandValue(value: unknown): string | null
{
  const direct = asTrimmedString(value)
  if (direct)
  {
    return direct
  }
  if (!Array.isArray(value))
  {
    return null
  }
  const parts: Array<string> = []
  for (const entry of value)
  {
    const part = asTrimmedString(entry)
    if (part !== null)
    {
      parts.push(part)
    }
  }
  if (parts.length === 0)
  {
    return null
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(' ')
}

function normalizeCommandValue(value: unknown): string | null
{
  const formatted = formatCommandValue(value)
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null
{
  const formatted = formatCommandValue(value)
  if (!formatted || normalizedCommand === null)
  {
    return null
  }
  return formatted === normalizedCommand ? null : formatted
}

export function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null
  rawCommand: string | null
}
{
  const data = asRecord(payload?.data)
  const item = asRecord(data?.item)
  const itemResult = asRecord(item?.result)
  const itemInput = asRecord(item?.input)
  const itemType = asTrimmedString(payload?.itemType)
  const detail = asTrimmedString(payload?.detail)
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === 'command_execution' && detail ? stripTrailingExitCode(detail).output : null,
  ]

  for (const candidate of candidates)
  {
    const command = normalizeCommandValue(candidate)
    if (!command)
    {
      continue
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    }
  }

  return {
    command: null,
    rawCommand: null,
  }
}

// the request-type fallback is supplied by the caller because web & mobile recognize
// different provider request types
export function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
  requestKindFromRequestType: (requestType: unknown) => WorkLogRequestKind | null,
): WorkLogRequestKind | undefined
{
  if (
    payload?.requestKind === 'command' ||
    payload?.requestKind === 'file-read' ||
    payload?.requestKind === 'file-change'
  )
  {
    return payload.requestKind
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown)
{
  const normalized = asTrimmedString(value)
  if (!normalized || seen.has(normalized))
  {
    return
  }
  seen.add(normalized)
  target.push(normalized)
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number)
{
  if (depth > 4 || target.length >= 12)
  {
    return
  }
  if (Array.isArray(value))
  {
    for (const entry of value)
    {
      collectChangedFiles(entry, target, seen, depth + 1)
      if (target.length >= 12)
      {
        return
      }
    }
    return
  }

  const record = asRecord(value)
  if (!record)
  {
    return
  }

  pushChangedFile(target, seen, record.path)
  pushChangedFile(target, seen, record.filePath)
  pushChangedFile(target, seen, record.relativePath)
  pushChangedFile(target, seen, record.filename)
  pushChangedFile(target, seen, record.newPath)
  pushChangedFile(target, seen, record.oldPath)

  for (const nestedKey of [
    'item',
    'result',
    'input',
    'data',
    'changes',
    'files',
    'edits',
    'patch',
    'patches',
    'operations',
  ])
  {
    if (!(nestedKey in record))
    {
      continue
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1)
    if (target.length >= 12)
    {
      return
    }
  }
}

export function extractChangedFiles(payload: Record<string, unknown> | null): string[]
{
  const changedFiles: string[] = []
  const seen = new Set<string>()
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0)
  return changedFiles
}

export function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null
{
  const questions = payload?.questions
  if (!Array.isArray(questions))
  {
    return null
  }

  const parsed = questions
    .map<UserInputQuestion | null>((entry) =>
    {
      const question = asRecord(entry)
      if (
        typeof question?.id !== 'string' ||
        typeof question.header !== 'string' ||
        typeof question.question !== 'string' ||
        !Array.isArray(question.options)
      )
      {
        return null
      }
      const options = question.options
        .map<{ readonly label: string; readonly description: string } | null>((option) =>
        {
          const optionRecord = asRecord(option)
          if (
            typeof optionRecord?.label !== 'string' ||
            typeof optionRecord.description !== 'string'
          )
          {
            return null
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          }
        })
        .filter(
          (option): option is { readonly label: string; readonly description: string } =>
            option !== null,
        )
      if (options.length === 0)
      {
        return null
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      }
    })
    .filter((question): question is UserInputQuestion => question !== null)

  return parsed.length > 0 ? parsed : null
}

function workLogPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null
{
  return asRecord(activity.payload)
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean
{
  if (activity.kind !== 'tool.updated' && activity.kind !== 'tool.completed')
  {
    return false
  }
  const detail = workLogPayload(activity)?.detail
  return typeof detail === 'string' && detail.startsWith('ExitPlanMode:')
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
): ToolLifecycleItemType | undefined
{
  return typeof payload?.itemType === 'string' && isToolLifecycleItemType(payload.itemType)
    ? payload.itemType
    : undefined
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null
{
  return asTrimmedString(asRecord(payload?.data)?.toolCallId)
}

function deriveToolLifecycleCollapseKey(entry: NormalizedWorkLogEntry): string | undefined
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

function toNormalizedWorkLogEntry(
  activity: OrchestrationThreadActivity,
  requestKindFromRequestType: NormalizeWorkLogOptions<NormalizedWorkLogEntry>['requestKindFromRequestType'],
): NormalizedWorkLogEntry
{
  const payload = workLogPayload(activity)
  const commandPreview = extractToolCommand(payload)
  const changedFiles = extractChangedFiles(payload)
  const toolTitle = asTrimmedString(payload?.title)
  const isTaskActivity = activity.kind === 'task.progress' || activity.kind === 'task.completed'
  const taskSummary = isTaskActivity ? asNonEmptyString(payload?.summary) : null
  const taskDetailAsLabel =
    isTaskActivity && !taskSummary ? asNonEmptyString(payload?.detail) : null
  const itemType = extractWorkLogItemType(payload)
  const requestKind = extractWorkLogRequestKind(payload, requestKindFromRequestType)
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload)
  const detail = !taskDetailAsLabel
    ? stripTrailingExitCode(asTrimmedString(payload?.detail) ?? '').output
    : null
  const toolLifecycleStatus =
    extractWorkLogToolLifecycleStatus(payload) ??
    (activity.kind === 'tool.completed' ? 'completed' : undefined)
  const toolData = itemType === 'mcp_tool_call' ? asRecord(payload?.data)?.item : undefined
  const base: NormalizedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskSummary ?? taskDetailAsLabel ?? activity.summary,
    tone:
      activity.kind === 'task.progress'
        ? 'thinking'
        : activity.tone === 'approval'
          ? 'info'
          : activity.tone,
    activityKind: activity.kind,
    ...(detail ? { detail } : {}),
    ...(commandPreview.command ? { command: commandPreview.command } : {}),
    ...(commandPreview.rawCommand ? { rawCommand: commandPreview.rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
  }
  return base
}

export function mergeNormalizedWorkLogEntries<T extends NormalizedWorkLogEntry>(
  previous: T,
  next: T,
): T
{
  const changedFiles = [
    ...new Set([...(previous.changedFiles ?? []), ...(next.changedFiles ?? [])]),
  ]
  return {
    ...previous,
    ...next,
    ...((next.detail ?? previous.detail) ? { detail: next.detail ?? previous.detail } : {}),
    ...((next.command ?? previous.command) ? { command: next.command ?? previous.command } : {}),
    ...((next.rawCommand ?? previous.rawCommand)
      ? { rawCommand: next.rawCommand ?? previous.rawCommand }
      : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...((next.toolTitle ?? previous.toolTitle)
      ? { toolTitle: next.toolTitle ?? previous.toolTitle }
      : {}),
    ...((next.itemType ?? previous.itemType)
      ? { itemType: next.itemType ?? previous.itemType }
      : {}),
    ...((next.requestKind ?? previous.requestKind)
      ? { requestKind: next.requestKind ?? previous.requestKind }
      : {}),
    ...((next.collapseKey ?? previous.collapseKey)
      ? { collapseKey: next.collapseKey ?? previous.collapseKey }
      : {}),
    ...((next.toolCallId ?? previous.toolCallId)
      ? { toolCallId: next.toolCallId ?? previous.toolCallId }
      : {}),
    ...((next.toolLifecycleStatus ?? previous.toolLifecycleStatus)
      ? { toolLifecycleStatus: next.toolLifecycleStatus ?? previous.toolLifecycleStatus }
      : {}),
    ...(next.toolData !== undefined || previous.toolData !== undefined
      ? { toolData: next.toolData ?? previous.toolData }
      : {}),
  }
}

function shouldCollapseToolLifecycleEntries(
  previous: NormalizedWorkLogEntry,
  next: NormalizedWorkLogEntry,
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

function collapseNormalizedWorkLogEntries<T extends NormalizedWorkLogEntry>(
  entries: ReadonlyArray<T>,
): T[]
{
  const collapsed: T[] = []
  for (const entry of entries)
  {
    const previous = collapsed.at(-1)
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry))
    {
      collapsed[collapsed.length - 1] = mergeNormalizedWorkLogEntries(previous, entry)
      continue
    }
    collapsed.push(entry)
  }
  return collapsed
}

export function deriveNormalizedWorkLogEntries<
  T extends NormalizedWorkLogEntry = NormalizedWorkLogEntry,
>(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: NormalizeWorkLogOptions<T>,
): T[]
{
  const entries: T[] = []
  for (const activity of [...activities].sort(compareOrchestrationThreadActivities))
  {
    if (activity.kind === 'tool.started' || activity.kind === 'context-window.updated') continue
    if (activity.kind === 'task.started' && options.includeTaskStarted !== true) continue
    if (options.excludedActivityKinds?.has(activity.kind)) continue
    if (activity.summary === 'Checkpoint captured' || isPlanBoundaryToolActivity(activity)) continue

    const payload = workLogPayload(activity)
    const entry = toNormalizedWorkLogEntry(activity, options.requestKindFromRequestType)
    const mapped = options.mapEntry ? options.mapEntry({ activity, payload, entry }) : (entry as T)
    const collapseKey = deriveToolLifecycleCollapseKey(mapped)
    entries.push(collapseKey ? ({ ...mapped, collapseKey } as T) : mapped)
  }
  const collapsed = collapseNormalizedWorkLogEntries(entries)
  return options.finalizeEntries ? [...options.finalizeEntries(collapsed)] : collapsed
}

export function workLogEntryIsToolLike(
  entry: Pick<NormalizedWorkLogEntry, 'tone' | 'command' | 'requestKind' | 'itemType'>,
  options: WorkLogClassificationOptions = {},
): boolean
{
  if (
    entry.tone === 'tool' ||
    entry.tone === 'error' ||
    (options.thinkingIsToolLike === true && entry.tone === 'thinking')
  )
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
    (normalized.includes('cannot find path') && normalized.includes('because it does not exist')) ||
    normalized.includes('commandnotfoundexception') ||
    normalized.includes('is not recognized as the name of a cmdlet') ||
    (normalized.includes('is not recognized') && normalized.includes("the term '")) ||
    normalized.includes('a parameter cannot be found that matches parameter name') ||
    normalized.includes('command not found') ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  )
}

export function workEntryIndicatesToolFailure(
  entry: Pick<
    NormalizedWorkLogEntry,
    'tone' | 'command' | 'detail' | 'requestKind' | 'itemType' | 'toolLifecycleStatus'
  >,
  options: WorkLogClassificationOptions = {},
): boolean
{
  if (entry.tone === 'error')
  {
    return true
  }
  if (entry.toolLifecycleStatus === 'failed' || entry.toolLifecycleStatus === 'declined')
  {
    return true
  }
  if (!workLogEntryIsToolLike(entry, options))
  {
    return false
  }
  const detail = [entry.detail, entry.command].filter(Boolean).join('\n')
  return detail.length > 0 && toolDetailTextLooksLikeFailure(detail)
}

export function workEntryIndicatesToolSuccess(
  entry: Pick<
    NormalizedWorkLogEntry,
    'tone' | 'command' | 'detail' | 'requestKind' | 'itemType' | 'toolLifecycleStatus'
  >,
  options: WorkLogClassificationOptions = {},
): boolean
{
  if (!workLogEntryIsToolLike(entry, options) || workEntryIndicatesToolFailure(entry, options))
  {
    return false
  }
  return (
    entry.tone !== 'thinking' &&
    entry.toolLifecycleStatus !== 'inProgress' &&
    entry.toolLifecycleStatus !== 'stopped' &&
    entry.toolLifecycleStatus !== 'failed' &&
    entry.toolLifecycleStatus !== 'declined'
  )
}

export function workEntryIndicatesToolNeutralStatus(
  entry: Pick<
    NormalizedWorkLogEntry,
    'tone' | 'command' | 'detail' | 'requestKind' | 'itemType' | 'toolLifecycleStatus'
  >,
  options: WorkLogClassificationOptions = {},
): boolean
{
  return (
    workLogEntryIsToolLike(entry, options) &&
    !workEntryIndicatesToolFailure(entry, options) &&
    !workEntryIndicatesToolSuccess(entry, options)
  )
}
