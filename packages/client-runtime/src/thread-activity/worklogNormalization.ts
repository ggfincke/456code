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
import { collectToolMutationTargets } from '@t3tools/shared/toolMutationTargets'

export type WorkLogRequestKind = 'command' | 'file-read' | 'file-change' | 'mcp-elicitation'

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
    payload?.requestKind === 'file-change' ||
    payload?.requestKind === 'mcp-elicitation'
  )
  {
    return payload.requestKind
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined
}

// the walk itself now lives in @t3tools/shared so the server-side divergence
// classifier reads mutation targets out of a payload exactly the way this
// timeline does; the defaults there reproduce this call byte for byte
export function extractChangedFiles(payload: Record<string, unknown> | null): string[]
{
  return [...collectToolMutationTargets(asRecord(payload?.data))]
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

// a tool.progress heartbeat carries its id as a top-level toolUseId rather than
// under data. without reading it, the thousand-odd heartbeats a long tool call
// emits share no key & each becomes its own row
function extractToolCallId(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): string | null
{
  const dataToolCallId =
    asTrimmedString(payload?.toolCallId) ?? asTrimmedString(asRecord(payload?.data)?.toolCallId)
  if (dataToolCallId !== null)
  {
    return dataToolCallId
  }
  return activity.kind === 'tool.progress' ? asTrimmedString(payload?.toolUseId) : null
}

// the frames that open & close a tool call; a heartbeat is deliberately not one
// of them, because it is identified by tool call id & these are not
function isToolLifecycleFrameKind(kind: OrchestrationThreadActivity['kind']): boolean
{
  return kind === 'tool.updated' || kind === 'tool.completed'
}

function deriveToolLifecycleCollapseKey(entry: NormalizedWorkLogEntry): string | undefined
{
  if (!isToolLifecycleFrameKind(entry.activityKind))
  {
    return undefined
  }
  if (entry.toolCallId)
  {
    return toolCallIdentityKey(entry.turnId, entry.toolCallId)
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
  const toolCallId = isTaskActivity ? null : extractToolCallId(activity, payload)
  const detail = !taskDetailAsLabel
    ? stripTrailingExitCode(asTrimmedString(payload?.detail) ?? '').output
    : null
  // a tool.progress frame carries no status field, but a heartbeat is by
  // definition still in flight. without this the row classifies as a finished
  // success and mobile stamps a green check on a tool that never returned
  const toolLifecycleStatus =
    extractWorkLogToolLifecycleStatus(payload) ??
    (activity.kind === 'tool.completed'
      ? 'completed'
      : activity.kind === 'tool.progress'
        ? 'inProgress'
        : undefined)
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
    id: previous.id,
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
  if (!isToolLifecycleFrameKind(previous.activityKind))
  {
    return false
  }
  if (!isToolLifecycleFrameKind(next.activityKind))
  {
    return false
  }
  if (previous.turnId !== next.turnId)
  {
    return false
  }
  // a finished row is never reopened by a later frame
  if (previous.activityKind === 'tool.completed')
  {
    return false
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey)
  {
    return true
  }
  // exactly one side carries a tool call id: a frame written before ids were projected
  // pairing with one written after, in either order. item type & label are all that is
  // left to match on
  const exactlyOneHasToolCallId =
    (previous.toolCallId === undefined) !== (next.toolCallId === undefined)
  return (
    exactlyOneHasToolCallId &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  )
}

// a row already emitted for a tool call that has not closed yet
interface OpenHeartbeatRow
{
  readonly index: number
  readonly turnId: TurnId | null
  readonly toolCallId?: string | undefined
}

export function toolCallIdentityKey(turnId: TurnId | null, toolCallId: string): string
{
  return JSON.stringify([turnId, toolCallId])
}

function findOpenHeartbeatToRetire(
  openHeartbeats: ReadonlyArray<OpenHeartbeatRow>,
  closeTurnId: TurnId | null,
  closeToolCallId: string | undefined,
): number
{
  if (closeToolCallId === undefined)
  {
    return openHeartbeats.findIndex((row) => row.turnId === closeTurnId)
  }
  const exact = openHeartbeats.findIndex(
    (row) => row.turnId === closeTurnId && row.toolCallId === closeToolCallId,
  )
  // an id-bearing close frame never claims a row that names a different call,
  // but it does claim an id-less one: codex heartbeats carry no id to match on
  return exact >= 0
    ? exact
    : openHeartbeats.findIndex((row) => row.turnId === closeTurnId && row.toolCallId === undefined)
}

// two tiers of matching, because two id namespaces meet here. an id-bearing
// lifecycle frame owns exactly one row, found by tool call id no matter what has
// been appended since, so two concurrent calls to the same tool stop closing each
// other's rows. an id-less frame keeps the older behavior: it merges into the
// last live row when item type & label agree. a heartbeat is in neither tier --
// it stands in for a call that has not closed yet, so it is retired by the frame
// that closes that call rather than merged into it, and an id-less heartbeat
// (codex sends no tool id) is retired by whichever call closes next, because it
// carries no identity to match on. without that retirement every long call
// strands a row at "in progress" forever, which the timeline reports as
// "Interrupted" over a tool that succeeded
function collapseNormalizedWorkLogEntries<T extends NormalizedWorkLogEntry>(
  entries: ReadonlyArray<T>,
): T[]
{
  const collapsed: T[] = []
  const retiredIndexes = new Set<number>()
  const openHeartbeats: OpenHeartbeatRow[] = []
  const openRowIndexByToolCallId = new Map<string, number>()

  const lastLiveIndex = (): number =>
  {
    for (let index = collapsed.length - 1; index >= 0; index -= 1)
    {
      if (!retiredIndexes.has(index))
      {
        return index
      }
    }
    return -1
  }

  // a closed row is never reopened: dropping the ids pointing at it stops a later
  // frame carrying the same id from merging into a call that already finished
  const forgetClosedRow = (index: number): void =>
  {
    if (collapsed[index]?.activityKind !== 'tool.completed')
    {
      return
    }
    for (const [toolCallId, rowIndex] of openRowIndexByToolCallId)
    {
      if (rowIndex === index)
      {
        openRowIndexByToolCallId.delete(toolCallId)
      }
    }
  }

  const mergeIntoRow = (index: number, entry: T): void =>
  {
    const previous = collapsed[index]
    if (!previous)
    {
      return
    }
    // a live row keeps the id it was born with so it does not remount as later
    // lifecycle frames replace its content; both surfaces key rows on entry.id
    collapsed[index] = mergeNormalizedWorkLogEntries(previous, entry)
    forgetClosedRow(index)
  }

  const mergeIntoLastLiveRow = (entry: T): boolean =>
  {
    const index = lastLiveIndex()
    const previous = index >= 0 ? collapsed[index] : undefined
    if (!previous || !shouldCollapseToolLifecycleEntries(previous, entry))
    {
      return false
    }
    mergeIntoRow(index, entry)
    return true
  }

  for (const entry of entries)
  {
    if (entry.activityKind === 'tool.progress')
    {
      // an id-less heartbeat updates the newest open id-less row, because
      // nothing distinguishes it from the call that row already stands for
      const open =
        entry.toolCallId === undefined
          ? openHeartbeats.findLast(
              (row) => row.turnId === entry.turnId && row.toolCallId === undefined,
            )
          : openHeartbeats.find(
              (row) => row.turnId === entry.turnId && row.toolCallId === entry.toolCallId,
            )
      if (open)
      {
        mergeIntoRow(open.index, entry)
        continue
      }
      openHeartbeats.push({
        index: collapsed.length,
        turnId: entry.turnId,
        ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
      })
      collapsed.push(entry)
      continue
    }

    // an id-bearing lifecycle frame is matched by identity, so anything appended
    // between its open & close frames cannot steal the row
    if (isToolLifecycleFrameKind(entry.activityKind) && entry.toolCallId !== undefined)
    {
      const identityKey = toolCallIdentityKey(entry.turnId, entry.toolCallId)
      // * the id-less fallback inside findOpenHeartbeatToRetire is load-bearing:
      // codex heartbeats carry no id, so retiring only on an exact match would
      // strand their row at "in progress" forever
      const retireIndex = findOpenHeartbeatToRetire(openHeartbeats, entry.turnId, entry.toolCallId)
      if (retireIndex >= 0)
      {
        const [retired] = openHeartbeats.splice(retireIndex, 1)
        if (retired)
        {
          retiredIndexes.add(retired.index)
        }
      }
      const openIndex = openRowIndexByToolCallId.get(identityKey)
      if (openIndex !== undefined)
      {
        mergeIntoRow(openIndex, entry)
        continue
      }
      // no row claims this id yet, but an id-less row for the same call can still
      // be the last live one when the open frame predates the id projection
      if (mergeIntoLastLiveRow(entry))
      {
        const mergedIndex = lastLiveIndex()
        if (mergedIndex >= 0 && collapsed[mergedIndex]?.activityKind !== 'tool.completed')
        {
          openRowIndexByToolCallId.set(identityKey, mergedIndex)
        }
        continue
      }
      const pushedIndex = collapsed.length
      collapsed.push(entry)
      if (entry.activityKind !== 'tool.completed')
      {
        openRowIndexByToolCallId.set(identityKey, pushedIndex)
      }
      continue
    }

    if (mergeIntoLastLiveRow(entry))
    {
      continue
    }
    if (isToolLifecycleFrameKind(entry.activityKind))
    {
      const retireIndex = findOpenHeartbeatToRetire(openHeartbeats, entry.turnId, entry.toolCallId)
      if (retireIndex >= 0)
      {
        const [retired] = openHeartbeats.splice(retireIndex, 1)
        if (retired)
        {
          retiredIndexes.add(retired.index)
        }
        // retiring the heartbeat puts the open & close frames of the same call
        // back in contact, so they collapse into the one row they always were
        if (mergeIntoLastLiveRow(entry))
        {
          continue
        }
      }
    }
    collapsed.push(entry)
  }
  return collapsed.filter((_, index) => !retiredIndexes.has(index))
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

function workEntryIndicatesToolFailureFromOutput(
  entry: Pick<
    NormalizedWorkLogEntry,
    'tone' | 'command' | 'detail' | 'requestKind' | 'itemType' | 'toolLifecycleStatus'
  >,
  includeCommand: boolean,
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
  const detail = [entry.detail, includeCommand ? entry.command : undefined]
    .filter(Boolean)
    .join('\n')
  return detail.length > 0 && toolDetailTextLooksLikeFailure(detail)
}

export function workEntryIndicatesToolFailure(
  entry: Pick<
    NormalizedWorkLogEntry,
    'tone' | 'command' | 'detail' | 'requestKind' | 'itemType' | 'toolLifecycleStatus'
  >,
  options: WorkLogClassificationOptions = {},
): boolean
{
  return workEntryIndicatesToolFailureFromOutput(entry, true, options)
}

// rendered failure chrome ignores the command because it describes user intent,
// not the tool's result
export function workEntryDisplayIndicatesToolFailure(
  entry: Pick<
    NormalizedWorkLogEntry,
    'tone' | 'command' | 'detail' | 'requestKind' | 'itemType' | 'toolLifecycleStatus'
  >,
  options: WorkLogClassificationOptions = {},
): boolean
{
  return workEntryIndicatesToolFailureFromOutput(entry, false, options)
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

// an in-flight tool row is running, not empty. it is the only row that exists
// while a multi-minute tool call waits, so it has to survive the neutral drop
export function workEntryIndicatesToolRunning(
  entry: Pick<
    NormalizedWorkLogEntry,
    'tone' | 'command' | 'detail' | 'requestKind' | 'itemType' | 'toolLifecycleStatus'
  >,
  options: WorkLogClassificationOptions = {},
): boolean
{
  return (
    workLogEntryIsToolLike(entry, options) &&
    entry.toolLifecycleStatus === 'inProgress' &&
    !workEntryIndicatesToolFailure(entry, options)
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
    !workEntryIndicatesToolRunning(entry, options) &&
    !workEntryIndicatesToolSuccess(entry, options)
  )
}
