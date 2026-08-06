// apps/server/src/import/parsers/acpImportNormalize.ts
// normalizes ACP session replay notifications into imported records

// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import * as NodeBuffer from 'node:buffer'
import * as NodeCrypto from 'node:crypto'

import type { ToolLifecycleItemType } from '@t3tools/contracts'
import { deriveToolActivityPresentation } from '@t3tools/shared/toolActivity'
import type * as EffectAcpSchema from 'effect-acp/schema'

import {
  IMPORT_NORMALIZED_SESSION_MAX_BYTES,
  IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
} from '../discovery/resourceLimits.ts'
import {
  boundedReplayText,
  boundedToolDisplayText,
  displayTextFromRawToolValue,
  deterministicTimelineEpochMs,
  deterministicTimelineWindowMs,
  isRecord,
  metadataFieldMaxBytes,
  replayCommandMaxBytes,
  replayLocationPathMaxBytes,
  replayNormalizedEnvelopeReserveBytes,
  replayPlanEntryLimit,
  replaySummaryLimit,
  replayTextFieldMaxBytes,
  replayToolCallIdMaxBytes,
  replayToolContentItemLimit,
  replayToolLocationLimit,
  replayWarningDetailLimit,
  sanitizeRawToolValue,
  timestampedRecordJsonOverheadBytes,
} from './acpImportRedact.ts'
import { jsonByteLength, normalizeOptionalText } from './acpImportConnection.ts'
import type {
  AcpImportCatalogEntry,
  AcpImportedSession,
  MutableToolReplay,
  NormalizedToolLocation,
  PendingMessage,
  PendingThought,
  ReplayRecord,
} from './acpImportTypes.ts'
import type { ImportedActivityRecord, ImportedMessageRecord, ImportedRecord } from '../types.ts'

export function persistedToolCallId(toolCallId: string): string
{
  const sanitized = boundedToolDisplayText(toolCallId, replayToolCallIdMaxBytes)
  if (sanitized.length > 0 && sanitized === toolCallId)
  {
    return sanitized
  }
  return `acp-tool-${NodeCrypto.createHash('sha256').update(toolCallId).digest('hex').slice(0, 32)}`
}

export function attachmentCountFromContentBlock(content: EffectAcpSchema.ContentBlock): number
{
  return content.type === 'text' ? 0 : 1
}

export function normalizeCommandValue(value: unknown): string | undefined
{
  if (typeof value === 'string')
  {
    const trimmed = value.trim()
    return trimmed.length > 0 ? boundedToolDisplayText(trimmed, replayCommandMaxBytes) : undefined
  }
  if (!Array.isArray(value))
  {
    return undefined
  }
  const parts = value.flatMap((entry) =>
    typeof entry === 'string' && entry.trim().length > 0 ? [entry.trim()] : [],
  )
  return parts.length > 0
    ? boundedToolDisplayText(parts.join(' '), replayCommandMaxBytes)
    : undefined
}

export function commandFromTitle(title: string | undefined): string | undefined
{
  const match = title === undefined ? null : /`([^`]+)`/u.exec(title)
  const command = match?.[1]?.trim()
  return command ? boundedToolDisplayText(command, replayCommandMaxBytes) : undefined
}

export function commandFromRawInput(
  rawInput: unknown,
  title: string | undefined,
): string | undefined
{
  if (isRecord(rawInput))
  {
    const direct = normalizeCommandValue(rawInput.command)
    if (direct !== undefined)
    {
      return direct
    }
    const executable =
      typeof rawInput.executable === 'string'
        ? boundedToolDisplayText(rawInput.executable.trim(), replayCommandMaxBytes)
        : ''
    const args = normalizeCommandValue(rawInput.args)
    if (executable && args)
    {
      return boundedToolDisplayText(`${executable} ${args}`, replayCommandMaxBytes)
    }
    if (executable)
    {
      return executable
    }
  }
  return commandFromTitle(title)
}

export function normalizeToolContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): {
  readonly textOutput: string | undefined
  readonly attachmentCount: number
  readonly omittedContentItemCount: number
}
{
  if (!content)
  {
    return { textOutput: undefined, attachmentCount: 0, omittedContentItemCount: 0 }
  }
  const textChunks: string[] = []
  let attachmentCount = 0
  let retainedTextBytes = 0
  let omittedContentItemCount = Math.max(0, content.length - replayToolContentItemLimit)
  const scannedItemCount = Math.min(content.length, replayToolContentItemLimit)
  for (let contentIndex = 0; contentIndex < scannedItemCount; contentIndex += 1)
  {
    const item = content[contentIndex]!
    if (item.type === 'content' && item.content.type === 'text')
    {
      const separatorBytes = textChunks.length === 0 ? 0 : 1
      const remainingBytes = replayTextFieldMaxBytes - retainedTextBytes - separatorBytes
      if (remainingBytes <= 0)
      {
        omittedContentItemCount += 1
        continue
      }
      const boundedChunk = boundedReplayText(item.content.text, remainingBytes)
      if (boundedChunk.length === 0)
      {
        continue
      }
      textChunks.push(boundedChunk)
      retainedTextBytes += separatorBytes + NodeBuffer.Buffer.byteLength(boundedChunk, 'utf8')
      continue
    }
    if (item.type === 'content')
    {
      attachmentCount += 1
      continue
    }
    if (item.type === 'diff' || item.type === 'terminal')
    {
      attachmentCount += 1
    }
  }
  const joined = textChunks.join('\n').trim()
  return {
    textOutput: joined.length > 0 ? boundedToolDisplayText(joined) : undefined,
    attachmentCount,
    omittedContentItemCount,
  }
}

export function normalizeToolLocations(
  locations: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined,
): {
  readonly locations: ReadonlyArray<NormalizedToolLocation>
  readonly omittedLocationCount: number
}
{
  if (!locations)
  {
    return { locations: [], omittedLocationCount: 0 }
  }
  const normalized: NormalizedToolLocation[] = []
  const seen = new Set<string>()
  const scannedLocationCount = Math.min(locations.length, replayToolLocationLimit)
  for (let locationIndex = 0; locationIndex < scannedLocationCount; locationIndex += 1)
  {
    const location = locations[locationIndex]!
    const path = boundedToolDisplayText(location.path, replayLocationPathMaxBytes).trim()
    if (path.length === 0)
    {
      continue
    }
    const line =
      typeof location.line === 'number' && Number.isSafeInteger(location.line) && location.line >= 0
        ? location.line
        : undefined
    const key = `${path}\u0000${line ?? ''}`
    if (seen.has(key))
    {
      continue
    }
    seen.add(key)
    normalized.push({
      path,
      ...(line !== undefined ? { line } : {}),
    })
  }
  return {
    locations: normalized,
    omittedLocationCount: Math.max(0, locations.length - normalized.length),
  }
}

export function canonicalItemTypeFromToolKind(kind: string | undefined): ToolLifecycleItemType
{
  switch (kind)
  {
    case 'execute':
      return 'command_execution'
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_change'
    case 'search':
    case 'fetch':
      return 'web_search'
    default:
      return 'dynamic_tool_call'
  }
}

export function messageIdentityMatches(
  pending: PendingMessage,
  role: 'user' | 'assistant',
  messageId: string | null,
): boolean
{
  return (
    pending.role === role &&
    ((pending.messageId === null && messageId === null) || pending.messageId === messageId)
  )
}

export function thoughtIdentityMatches(pending: PendingThought, messageId: string | null): boolean
{
  return (pending.messageId === null && messageId === null) || pending.messageId === messageId
}

export function summarize(text: string, fallback: string): string
{
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (!flattened) return fallback
  return flattened.length <= replaySummaryLimit
    ? flattened
    : `${flattened.slice(0, replaySummaryLimit - 1)}…`
}

export function buildReplayRecords(
  notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>,
): {
  readonly records: ReadonlyArray<ReplayRecord>
  readonly attachmentCount: number
  readonly omittedContentItemCount: number
  readonly omittedLocationCount: number
  readonly omittedRecordCount: number
  readonly omittedToolCount: number
}
{
  const records: ReplayRecord[] = []
  const pendingTools = new Map<string, MutableToolReplay>()
  const completedTools = new Set<string>()
  let pendingMessage: PendingMessage | undefined
  let pendingThought: PendingThought | undefined
  let attachmentCount = 0
  let omittedContentItemCount = 0
  let omittedLocationCount = 0
  let omittedRecordCount = 0
  let lastOmittedRecordSourceIndex = 0
  let retainedRecordBytes = 2
  let attachmentSourceIndex = -1

  const pushRecord = (record: ReplayRecord): void =>
  {
    const normalizedRecordByteLimit =
      IMPORT_NORMALIZED_SESSION_MAX_BYTES - replayNormalizedEnvelopeReserveBytes
    const recordBytes =
      records.length < IMPORT_NORMALIZED_SESSION_MAX_RECORDS
        ? jsonByteLength(record) + timestampedRecordJsonOverheadBytes + 1
        : 0
    if (
      records.length < IMPORT_NORMALIZED_SESSION_MAX_RECORDS &&
      recordBytes <= normalizedRecordByteLimit - retainedRecordBytes
    )
    {
      records.push(record)
      retainedRecordBytes += recordBytes
      return
    }
    omittedRecordCount += 1
    lastOmittedRecordSourceIndex = Math.max(lastOmittedRecordSourceIndex, record.sourceIndex)
  }

  const flushMessage = () =>
  {
    if (pendingMessage === undefined) return
    const text = boundedReplayText(pendingMessage.chunks.join('').trim())
    if (text)
    {
      pushRecord({
        kind: 'message',
        role: pendingMessage.role,
        text,
        sourceIndex: pendingMessage.sourceIndex,
      } satisfies Omit<ImportedMessageRecord, 'createdAt'>)
    }
    pendingMessage = undefined
  }
  const flushThought = () =>
  {
    if (pendingThought === undefined) return
    const text = boundedReplayText(pendingThought.chunks.join('').trim())
    if (text)
    {
      const summary = summarize(text, 'Reasoning')
      pushRecord({
        kind: 'activity',
        tone: 'info',
        activityKind: 'task.progress',
        summary,
        payload: { summary, detail: text },
        sourceIndex: pendingThought.sourceIndex,
      } satisfies Omit<ImportedActivityRecord, 'createdAt'>)
    }
    pendingThought = undefined
  }
  const emitTool = (tool: MutableToolReplay, sourceIndex: number) =>
  {
    const itemType = canonicalItemTypeFromToolKind(tool.kind)
    const textOutput = tool.contentTextOutput ?? displayTextFromRawToolValue(tool.rawOutput)
    const item: Record<string, unknown> = {}
    if (tool.rawInput !== undefined)
    {
      item.input = tool.rawInput
    }
    if (tool.command !== undefined)
    {
      item.command = tool.command
    }
    if (textOutput !== undefined)
    {
      item.result = { content: textOutput }
    }
    if (itemType === 'file_change' && tool.locations.length > 0)
    {
      item.changes = tool.locations
    }
    const data: Record<string, unknown> = {
      toolCallId: persistedToolCallId(tool.toolCallId),
      ...(tool.kind ? { kind: tool.kind } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(Object.keys(item).length > 0 ? { item } : {}),
      ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
      ...(tool.rawOutput !== undefined
        ? { rawOutput: tool.rawOutput }
        : textOutput
          ? { rawOutput: { content: textOutput } }
          : {}),
      ...(tool.locations.length > 0 ? { locations: tool.locations } : {}),
      ...(tool.omittedContentItemCount > 0
        ? { omittedContentItemCount: tool.omittedContentItemCount }
        : {}),
      ...(tool.omittedLocationCount > 0 ? { omittedLocationCount: tool.omittedLocationCount } : {}),
    }
    const presentation = deriveToolActivityPresentation({
      itemType,
      title: tool.title,
      detail: textOutput ?? tool.command,
      data,
      fallbackSummary: tool.title ?? 'Tool',
    })
    const summary = summarize(presentation.summary, 'Tool')
    const detail = textOutput ?? presentation.detail
    pushRecord({
      kind: 'activity',
      tone: tool.status === 'failed' ? 'error' : 'tool',
      activityKind: 'tool.completed',
      summary,
      payload: {
        itemType,
        title: summary,
        status: tool.status,
        ...(detail ? { detail } : {}),
        data,
      },
      sourceIndex,
    } satisfies Omit<ImportedActivityRecord, 'createdAt'>)
    attachmentCount += tool.attachmentCount
    omittedContentItemCount += tool.omittedContentItemCount
    omittedLocationCount += tool.omittedLocationCount
    if (tool.attachmentCount > 0)
    {
      attachmentSourceIndex = Math.max(attachmentSourceIndex, sourceIndex)
    }
    pendingTools.delete(tool.toolCallId)
    completedTools.add(tool.toolCallId)
  }

  for (const [sourceIndex, notification] of notifications.entries())
  {
    const update = notification.update
    switch (update.sessionUpdate)
    {
      case 'user_message_chunk':
      case 'agent_message_chunk':
      {
        flushThought()
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
        const messageId = update.messageId ?? null
        if (
          pendingMessage !== undefined &&
          !messageIdentityMatches(pendingMessage, role, messageId)
        )
        {
          flushMessage()
        }
        const blockAttachments = attachmentCountFromContentBlock(update.content)
        if (blockAttachments > 0)
        {
          attachmentCount += blockAttachments
          attachmentSourceIndex = sourceIndex
          continue
        }
        if (update.content.type === 'text')
        {
          if (pendingMessage === undefined)
          {
            pendingMessage = {
              role,
              messageId,
              sourceIndex,
              chunks: [update.content.text],
            }
          }
          else
          {
            pendingMessage.chunks.push(update.content.text)
          }
        }
        continue
      }
      case 'agent_thought_chunk':
      {
        flushMessage()
        const blockAttachments = attachmentCountFromContentBlock(update.content)
        if (blockAttachments > 0)
        {
          attachmentCount += blockAttachments
          attachmentSourceIndex = sourceIndex
          continue
        }
        if (update.content.type === 'text')
        {
          const messageId = update.messageId ?? null
          if (pendingThought !== undefined && !thoughtIdentityMatches(pendingThought, messageId))
          {
            flushThought()
          }
          if (pendingThought === undefined)
          {
            pendingThought = {
              messageId,
              sourceIndex,
              chunks: [update.content.text],
            }
          }
          else
          {
            pendingThought.chunks.push(update.content.text)
          }
        }
        continue
      }
      case 'tool_call':
      {
        flushMessage()
        flushThought()
        if (completedTools.has(update.toolCallId)) continue
        const title = boundedToolDisplayText(update.title.trim()) || undefined
        const rawInput = sanitizeRawToolValue(update.rawInput)
        const rawOutput = sanitizeRawToolValue(update.rawOutput)
        const content = normalizeToolContent(update.content)
        const locations = normalizeToolLocations(update.locations)
        const tool: MutableToolReplay = {
          sourceIndex,
          toolCallId: update.toolCallId,
          title,
          kind: update.kind,
          status: update.status,
          command: commandFromRawInput(rawInput, title),
          contentTextOutput: content.textOutput,
          rawInput,
          rawOutput,
          locations: locations.locations,
          omittedContentItemCount: content.omittedContentItemCount,
          omittedLocationCount: locations.omittedLocationCount,
          attachmentCount: content.attachmentCount,
        }
        pendingTools.set(update.toolCallId, tool)
        if (tool.status === 'completed' || tool.status === 'failed')
        {
          emitTool(tool, sourceIndex)
        }
        continue
      }
      case 'tool_call_update':
      {
        flushMessage()
        flushThought()
        if (completedTools.has(update.toolCallId)) continue
        const tool = pendingTools.get(update.toolCallId) ?? {
          sourceIndex,
          toolCallId: update.toolCallId,
          title: undefined,
          kind: undefined,
          status: undefined,
          command: undefined,
          contentTextOutput: undefined,
          rawInput: undefined,
          rawOutput: undefined,
          locations: [],
          omittedContentItemCount: 0,
          omittedLocationCount: 0,
          attachmentCount: 0,
        }
        if ('title' in update)
        {
          tool.title =
            update.title == null
              ? undefined
              : boundedToolDisplayText(update.title.trim()) || undefined
        }
        if ('kind' in update)
        {
          tool.kind = update.kind ?? undefined
        }
        if ('status' in update)
        {
          tool.status = update.status ?? undefined
        }
        if ('rawInput' in update)
        {
          tool.rawInput = sanitizeRawToolValue(update.rawInput)
          tool.command = commandFromRawInput(tool.rawInput, tool.title)
        }
        else if (tool.command === undefined)
        {
          tool.command = commandFromTitle(tool.title)
        }
        if ('rawOutput' in update)
        {
          tool.rawOutput = sanitizeRawToolValue(update.rawOutput)
        }
        if ('content' in update)
        {
          const content = normalizeToolContent(update.content)
          tool.contentTextOutput = content.textOutput
          tool.attachmentCount = content.attachmentCount
          tool.omittedContentItemCount = content.omittedContentItemCount
        }
        if ('locations' in update)
        {
          const locations = normalizeToolLocations(update.locations)
          tool.locations = locations.locations
          tool.omittedLocationCount = locations.omittedLocationCount
        }
        pendingTools.set(update.toolCallId, tool)
        if (tool.status === 'completed' || tool.status === 'failed')
        {
          emitTool(tool, sourceIndex)
        }
        continue
      }
      case 'plan':
      {
        const plan = update.entries.slice(0, replayPlanEntryLimit).map((entry, index) => ({
          step: boundedReplayText(entry.content.trim()) || `Step ${index + 1}`,
          status:
            entry.status === 'completed'
              ? ('completed' as const)
              : entry.status === 'in_progress'
                ? ('inProgress' as const)
                : ('pending' as const),
        }))
        pushRecord({
          kind: 'activity',
          tone: 'info',
          activityKind: 'turn.plan.updated',
          summary: 'Plan updated',
          payload: {
            plan,
            ...(update.entries.length > replayPlanEntryLimit
              ? {
                  explanation: `Imported ACP plan omitted ${
                    update.entries.length - replayPlanEntryLimit
                  } additional steps after the first ${replayPlanEntryLimit}.`,
                  omittedStepCount: update.entries.length - replayPlanEntryLimit,
                }
              : {}),
          },
          sourceIndex,
        } satisfies Omit<ImportedActivityRecord, 'createdAt'>)
        continue
      }
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update':
      case 'usage_update':
        continue
    }
  }

  flushMessage()
  flushThought()
  for (const tool of pendingTools.values())
  {
    attachmentCount += tool.attachmentCount
    omittedContentItemCount += tool.omittedContentItemCount
    omittedLocationCount += tool.omittedLocationCount
    if (tool.attachmentCount > 0)
    {
      attachmentSourceIndex = Math.max(attachmentSourceIndex, tool.sourceIndex)
    }
  }
  if (pendingTools.size > 0)
  {
    const omittedTools = [...pendingTools.values()]
    let unfinishedSourceIndex = 0
    for (const tool of omittedTools)
    {
      unfinishedSourceIndex = Math.max(unfinishedSourceIndex, tool.sourceIndex)
    }
    const detail = omittedTools
      .slice(0, replayWarningDetailLimit)
      .map((tool) =>
        boundedReplayText(tool.title ?? tool.kind ?? 'Unnamed tool', replayLocationPathMaxBytes),
      )
      .join('\n')
    const summary = `Omitted ${pendingTools.size} unfinished tool activit${
      pendingTools.size === 1 ? 'y' : 'ies'
    } from imported ACP history`
    pushRecord({
      kind: 'activity',
      tone: 'error',
      activityKind: 'task.completed',
      summary,
      payload: {
        summary,
        detail:
          omittedTools.length > replayWarningDetailLimit
            ? `${detail}\n… and ${omittedTools.length - replayWarningDetailLimit} more`
            : detail,
        unfinishedToolCount: pendingTools.size,
      },
      sourceIndex: unfinishedSourceIndex,
    } satisfies Omit<ImportedActivityRecord, 'createdAt'>)
  }
  if (attachmentCount > 0)
  {
    const summary = `Omitted ${attachmentCount} attachment${
      attachmentCount === 1 ? '' : 's'
    } from imported ACP history`
    pushRecord({
      kind: 'activity',
      tone: 'info',
      activityKind: 'task.completed',
      summary,
      payload: {
        summary,
        detail: 'Attachment payloads are not included in imported transcripts.',
        omittedAttachmentCount: attachmentCount,
      },
      sourceIndex: attachmentSourceIndex < 0 ? notifications.length : attachmentSourceIndex,
    } satisfies Omit<ImportedActivityRecord, 'createdAt'>)
  }
  if (omittedRecordCount > 0)
  {
    const displacedRecord = records.pop()
    if (displacedRecord !== undefined)
    {
      omittedRecordCount += 1
      lastOmittedRecordSourceIndex = Math.max(
        lastOmittedRecordSourceIndex,
        displacedRecord.sourceIndex,
      )
    }
    const summary = `Omitted ${omittedRecordCount} additional record${
      omittedRecordCount === 1 ? '' : 's'
    } after the ACP normalized session limit`
    records.push({
      kind: 'activity',
      tone: 'info',
      activityKind: 'task.completed',
      summary,
      payload: {
        summary,
        omittedRecordCount,
        normalizedByteLimit: IMPORT_NORMALIZED_SESSION_MAX_BYTES,
        normalizedRecordLimit: IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
      },
      sourceIndex: lastOmittedRecordSourceIndex,
    })
  }
  records.sort((left, right) => left.sourceIndex - right.sourceIndex)
  return {
    records,
    attachmentCount,
    omittedContentItemCount,
    omittedLocationCount,
    omittedRecordCount,
    omittedToolCount: pendingTools.size,
  }
}

export function timestampRecords(
  records: ReadonlyArray<ReplayRecord>,
  updatedAt: string | null,
  contentHash: string,
): ReadonlyArray<ImportedRecord>
{
  const hashOffset = Number.parseInt(contentHash.slice(0, 12), 16) % deterministicTimelineWindowMs
  const fallbackMillis = deterministicTimelineEpochMs + hashOffset
  const lastMillis = updatedAt === null ? fallbackMillis : Date.parse(updatedAt)
  const firstMillis = Math.max(0, lastMillis - Math.max(0, records.length - 1))
  return records.map(
    (record, index) =>
      ({
        ...record,
        createdAt: new Date(firstMillis + index).toISOString(),
      }) as ImportedRecord,
  )
}

export function normalizeAcpSessionReplay(input: {
  readonly descriptor: AcpImportCatalogEntry
  readonly notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>
  readonly loadResponse: EffectAcpSchema.LoadSessionResponse
  readonly foreignNotificationCount?: number
}): AcpImportedSession
{
  const relevantNotifications = input.notifications.filter(
    (notification) => notification.sessionId === input.descriptor.nativeSessionId,
  )
  const built = buildReplayRecords(relevantNotifications)
  const warnings: string[] = []
  if (
    relevantNotifications.length !== input.notifications.length ||
    (input.foreignNotificationCount ?? 0) > 0
  )
  {
    warnings.push('ignored replay updates for a different ACP session')
  }
  if (built.records.every((record) => record.kind !== 'message'))
  {
    warnings.push('no messages found in ACP session replay')
  }
  if (built.attachmentCount > 0)
  {
    warnings.push('attachment contents were omitted from ACP session replay')
  }
  if (built.omittedToolCount > 0)
  {
    warnings.push('unfinished tool activities were omitted from ACP session replay')
  }
  if (built.omittedContentItemCount > 0)
  {
    warnings.push('tool content items beyond bounded replay limits were omitted')
  }
  if (built.omittedLocationCount > 0)
  {
    warnings.push(
      'tool locations beyond bounded replay limits or without unique paths were omitted',
    )
  }
  if (built.omittedRecordCount > 0)
  {
    warnings.push('records beyond the normalized session limit were omitted from ACP replay')
  }
  const normalizedModel = normalizeOptionalText(input.loadResponse.models?.currentModelId)
  const model =
    normalizedModel === null ? null : boundedReplayText(normalizedModel, metadataFieldMaxBytes)
  const stablePayload = {
    source: input.descriptor.source,
    sourcePath: input.descriptor.sourcePath,
    nativeSessionId: input.descriptor.nativeSessionId,
    cwd: input.descriptor.cwd,
    model,
    title: input.descriptor.title,
    records: built.records,
  }
  const contentHash = NodeCrypto.createHash('sha256')
    .update(JSON.stringify(stablePayload))
    .digest('hex')
  const records = timestampRecords(built.records, input.descriptor.updatedAt, contentHash)
  return {
    meta: {
      source: input.descriptor.source,
      sourcePath: input.descriptor.sourcePath,
      contentHash,
      nativeSessionId: input.descriptor.nativeSessionId,
      cwd: input.descriptor.cwd,
      gitBranch: null,
      model,
      title: input.descriptor.title,
      firstActivityAt: records[0]?.createdAt ?? null,
      lastActivityAt: records.at(-1)?.createdAt ?? null,
    },
    records,
    warnings,
  }
}
