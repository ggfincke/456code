// apps/server/src/import/openCodeSessionParser.ts
// parses opencode storage bundles into inert imported transcript records

// @effect-diagnostics globalDate:off

import type {
  ImportedActivityRecord,
  ImportedRecord,
  ImportedSession,
  ImportedSessionMeta,
} from './types.ts'
import { deterministicId } from './ids.ts'
import {
  addWarning,
  appendParsingWarningActivity,
  applyStrictlyIncreasingTimestamps,
  materializeWarnings,
  truncateText as truncate,
  truncateUtf8,
  type WarningState,
} from './parserSupport.ts'
import { IMPORT_NORMALIZED_SESSION_MAX_RECORDS } from './resourceLimits.ts'

export interface OpenCodeStoredFile
{
  readonly relativePath: string
  readonly content: string
}

export interface OpenCodeStoredMessageBundle
{
  readonly message: OpenCodeStoredFile
  readonly parts: ReadonlyArray<OpenCodeStoredFile>
}

export interface ParseOpenCodeSessionBundleInput
{
  readonly sourcePath: string
  readonly contentHash: string
  readonly sessionId: string
  readonly session: OpenCodeStoredFile
  readonly messages: ReadonlyArray<OpenCodeStoredMessageBundle>
}

interface ParsedStoredFile
{
  readonly value: Record<string, unknown>
  readonly relativePath: string
}

const summaryLimit = 120
const payloadTextLimit = 4_000
const maxFieldBytes = 1_048_576
const maxCwdCharacters = 4_096
const maxMetadataCharacters = 512
const maxToolCallIdBytes = 512
const maxToolNameBytes = 256
const omittedAttachmentDetail = 'Attachment payloads are not included in imported transcripts.'
const administrativePartTypes = new Set([
  'agent',
  'compaction',
  'snapshot',
  'step-finish',
  'step-start',
  'subtask',
])

class NormalizedRecordLimitError extends Error
{
  constructor()
  {
    super(
      `session import normalized record limit exceeded: maximum is ${IMPORT_NORMALIZED_SESSION_MAX_RECORDS}`,
    )
    this.name = 'NormalizedRecordLimitError'
  }
}

function pushImportedRecord(records: ImportedRecord[], record: ImportedRecord): void
{
  if (records.length >= IMPORT_NORMALIZED_SESSION_MAX_RECORDS)
  {
    throw new NormalizedRecordLimitError()
  }
  records.push(record)
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null
{
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asFiniteNumber(value: unknown): number | null
{
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function summarize(value: string): string
{
  const firstLine = value.trim().split(/\r?\n/, 1)[0] ?? ''
  return truncate(firstLine, summaryLimit)
}

function boundUtf8(
  value: string,
  maxBytes: number,
  fieldDescription: string,
  warnings: WarningState,
): string
{
  const bounded = truncateUtf8(value, maxBytes)
  if (bounded === value)
  {
    return value
  }
  addWarning(warnings, `${fieldDescription} exceeded ${maxBytes} bytes and was truncated`)
  return bounded
}

function boundMetadataField(
  value: string | null,
  fieldDescription: string,
  warnings: WarningState,
): string | null
{
  if (value === null || value.length <= maxMetadataCharacters)
  {
    return value
  }
  addWarning(
    warnings,
    `${fieldDescription} exceeded ${maxMetadataCharacters} characters and was truncated`,
  )
  return truncate(value, maxMetadataCharacters)
}

function safeCwd(value: string | null, warnings: WarningState): string | null
{
  if (value === null || value.length <= maxCwdCharacters)
  {
    return value
  }
  addWarning(warnings, `OpenCode cwd exceeded ${maxCwdCharacters} characters and was omitted`)
  return null
}

function safeNativeSessionId(value: string | null, warnings: WarningState): string | null
{
  if (
    value === null ||
    value.length > maxMetadataCharacters ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
  {
    if (value !== null)
    {
      addWarning(warnings, 'OpenCode native session id was invalid or oversized and was omitted')
    }
    return null
  }
  return value
}

function stableToolCallId(
  value: string | null,
  fieldDescription: string,
  warnings: WarningState,
): string | null
{
  if (value === null || truncateUtf8(value, maxToolCallIdBytes) === value)
  {
    return value
  }
  addWarning(warnings, `${fieldDescription} exceeded 512 bytes and was replaced with a stable id`)
  return deterministicId(value, 'opencode-import-tool-call')
}

function stringifyPayload(
  value: unknown,
  fieldDescription: string,
  warnings: WarningState,
): string
{
  let serialized: string
  if (value === null || value === undefined)
  {
    return ''
  }
  if (typeof value === 'string')
  {
    serialized = value
  }
  else
  {
    try
    {
      serialized = JSON.stringify(value) ?? String(value)
    }
    catch
    {
      serialized = String(value)
    }
  }
  return boundUtf8(serialized, payloadTextLimit, fieldDescription, warnings)
}

function normalizeTimestamp(value: unknown): string | null
{
  if (typeof value !== 'string' && typeof value !== 'number')
  {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function parseStoredFile(
  file: OpenCodeStoredFile,
  kind: 'session metadata' | 'message' | 'part',
  warnings: WarningState,
): ParsedStoredFile | null
{
  try
  {
    const value: unknown = JSON.parse(file.content)
    if (!isRecord(value))
    {
      addWarning(warnings, `${kind} '${file.relativePath}' is not a JSON object and was skipped`)
      return null
    }
    return { value, relativePath: file.relativePath }
  }
  catch
  {
    addWarning(warnings, `${kind} '${file.relativePath}' contains malformed JSON and was skipped`)
    return null
  }
}

function storedFileId(relativePath: string): string | null
{
  const fileName = relativePath.split('/').at(-1)
  return fileName?.endsWith('.json') === true ? fileName.slice(0, -'.json'.length) : null
}

function storedSessionProjectId(relativePath: string): string | null
{
  const segments = relativePath.split('/')
  return segments.length === 3 && segments[0] === 'session' ? (segments[1] ?? null) : null
}

export function openCodeSessionIdentityStatus(input: {
  readonly storedSessionId: string | null
  readonly storedProjectId: string | null
  readonly sessionId: string
  readonly enclosingProjectId: string | null
}): {
  readonly sessionIdMatches: boolean
  readonly projectIdMatches: boolean
  readonly valid: boolean
}
{
  const sessionIdMatches = input.storedSessionId === input.sessionId
  const projectIdMatches =
    input.enclosingProjectId !== null && input.storedProjectId === input.enclosingProjectId
  return {
    sessionIdMatches,
    projectIdMatches,
    valid: sessionIdMatches && projectIdMatches,
  }
}

function messageTimestamp(message: Record<string, unknown>): string | null
{
  const time = isRecord(message.time) ? message.time : null
  return normalizeTimestamp(time?.created)
}

function partTimestamp(part: Record<string, unknown>, fallback: string): string
{
  const time = isRecord(part.time) ? part.time : null
  const state = isRecord(part.state) ? part.state : null
  const stateTime = state !== null && isRecord(state.time) ? state.time : null
  return (
    normalizeTimestamp(time?.start) ??
    normalizeTimestamp(time?.created) ??
    normalizeTimestamp(stateTime?.start) ??
    fallback
  )
}

function messageModel(message: Record<string, unknown>): string | null
{
  if (message.role === 'user' && isRecord(message.model))
  {
    const providerId = asString(message.model.providerID)
    const modelId = asString(message.model.modelID)
    return providerId !== null && modelId !== null ? `${providerId}/${modelId}` : null
  }

  const providerId = asString(message.providerID)
  const modelId = asString(message.modelID)
  return providerId !== null && modelId !== null ? `${providerId}/${modelId}` : null
}

function mapToolItemType(toolName: string): string
{
  const normalized = toolName.toLowerCase()
  if (
    normalized === 'bash' ||
    normalized === 'shell' ||
    normalized === 'command' ||
    normalized === 'exec' ||
    normalized === 'exec_command'
  )
  {
    return 'command_execution'
  }
  if (
    normalized === 'edit' ||
    normalized === 'write' ||
    normalized === 'patch' ||
    normalized === 'apply_patch' ||
    normalized === 'multiedit' ||
    normalized === 'notebookedit'
  )
  {
    return 'file_change'
  }
  if (normalized.includes('web'))
  {
    return 'web_search'
  }
  if (normalized.includes('mcp'))
  {
    return 'mcp_tool_call'
  }
  if (normalized.includes('image'))
  {
    return 'image_view'
  }
  if (
    normalized.includes('task') ||
    normalized.includes('agent') ||
    normalized.includes('subtask')
  )
  {
    return 'collab_agent_tool_call'
  }
  return 'dynamic_tool_call'
}

function toolActivity(
  part: Record<string, unknown>,
  createdAt: string,
  sourceIndex: number,
  relativePath: string,
  warnings: WarningState,
): {
  readonly activity: ImportedActivityRecord | null
  readonly attachmentCount: number
}
{
  const name = boundUtf8(
    asString(part.tool) ?? 'tool',
    maxToolNameBytes,
    `part '${relativePath}' tool name`,
    warnings,
  )
  const state = isRecord(part.state) ? part.state : {}
  const status = asString(state.status) ?? 'unknown'
  const itemType = mapToolItemType(name)
  const imageTool = itemType === 'image_view'
  const attachments = Math.max(
    Array.isArray(state.attachments) ? state.attachments.length : 0,
    imageTool ? 1 : 0,
  )
  if (status !== 'completed' && status !== 'error')
  {
    addWarning(
      warnings,
      `part '${relativePath}' has incomplete tool status '${truncate(status, summaryLimit)}' and was omitted`,
    )
    return { activity: null, attachmentCount: attachments }
  }
  const lifecycleStatus = status === 'error' ? 'failed' : 'completed'
  const input = imageTool
    ? '[omitted image input]'
    : stringifyPayload(state.input, `part '${relativePath}' tool input`, warnings)
  const output = imageTool
    ? '[omitted image output]'
    : status === 'error'
      ? stringifyPayload(state.error, `part '${relativePath}' tool error`, warnings)
      : stringifyPayload(state.output ?? null, `part '${relativePath}' tool output`, warnings)
  const explicitTitle = boundMetadataField(
    asString(state.title),
    `part '${relativePath}' tool title`,
    warnings,
  )
  const title = explicitTitle ?? name
  const inputRecord = isRecord(state.input) ? state.input : null
  const rawCommand =
    itemType === 'command_execution'
      ? (asString(inputRecord?.command) ?? asString(state.input))
      : null
  const command =
    rawCommand === null
      ? null
      : boundUtf8(rawCommand, maxFieldBytes, `part '${relativePath}' tool command`, warnings)
  const toolCallId = stableToolCallId(
    asString(part.callID),
    `part '${relativePath}' tool call id`,
    warnings,
  )
  const hint =
    explicitTitle ??
    (input === '' || input === 'null' || input === 'undefined'
      ? name
      : `${name}: ${summarize(input)}`)
  const itemInput = command === null ? { text: input } : { command }
  return {
    activity: {
      kind: 'activity',
      tone: status === 'error' ? 'error' : 'tool',
      activityKind: 'tool.completed',
      summary: truncate(hint, summaryLimit),
      payload: {
        itemType,
        title,
        detail: output,
        name,
        status: lifecycleStatus,
        data: {
          ...(toolCallId === null ? {} : { toolCallId }),
          kind: itemType === 'command_execution' ? 'execute' : name,
          rawInput: input,
          rawOutput: {
            content: output,
          },
          ...(command === null ? {} : { command }),
          item: {
            input: itemInput,
            ...(command === null ? {} : { command }),
            result: {
              content: output,
            },
          },
        },
      },
      createdAt,
      sourceIndex,
    },
    attachmentCount: attachments,
  }
}

function emptyMeta(input: ParseOpenCodeSessionBundleInput): ImportedSessionMeta
{
  return {
    source: 'opencode',
    sourcePath: input.sourcePath,
    contentHash: input.contentHash,
    nativeSessionId: null,
    cwd: null,
    gitBranch: null,
    model: null,
    title: null,
    firstActivityAt: null,
    lastActivityAt: null,
  }
}

export function parseOpenCodeSessionBundle(
  input: ParseOpenCodeSessionBundleInput,
): ImportedSession
{
  const warnings: WarningState = { details: [], omittedCount: 0, totalCount: 0 }
  const meta = emptyMeta(input)
  const records: ImportedRecord[] = []
  const parsedSession = parseStoredFile(input.session, 'session metadata', warnings)
  let hasMetadata = false

  if (parsedSession !== null)
  {
    const storedSessionId = asString(parsedSession.value.id)
    const storedProjectId = asString(parsedSession.value.projectID)
    const enclosingProjectId = storedSessionProjectId(parsedSession.relativePath)
    const identity = openCodeSessionIdentityStatus({
      storedSessionId,
      storedProjectId,
      sessionId: input.sessionId,
      enclosingProjectId,
    })
    if (identity.valid)
    {
      meta.nativeSessionId = safeNativeSessionId(storedSessionId, warnings)
      hasMetadata = meta.nativeSessionId !== null
    }
    if (!identity.sessionIdMatches)
    {
      addWarning(warnings, 'session metadata id does not match its storage filename')
    }
    if (!identity.projectIdMatches)
    {
      addWarning(
        warnings,
        'session metadata project id does not match its enclosing storage directory',
      )
    }
    meta.cwd = safeCwd(asString(parsedSession.value.directory), warnings)
    meta.title = boundMetadataField(
      asString(parsedSession.value.title),
      'OpenCode session title',
      warnings,
    )
  }

  const partFileIdCounts = new Map<string, number>()
  for (const file of input.messages.flatMap((bundle) => bundle.parts))
  {
    const partFileId = storedFileId(file.relativePath)
    if (partFileId !== null)
    {
      partFileIdCounts.set(partFileId, (partFileIdCounts.get(partFileId) ?? 0) + 1)
    }
  }

  const parsedMessages = input.messages
    .map((bundle) => ({
      bundle,
      parsed: parseStoredFile(bundle.message, 'message', warnings),
    }))
    .filter(
      (
        item,
      ): item is {
        readonly bundle: OpenCodeStoredMessageBundle
        readonly parsed: ParsedStoredFile
      } => item.parsed !== null,
    )
    .filter(({ parsed }) =>
    {
      if (asString(parsed.value.sessionID) === input.sessionId)
      {
        return true
      }
      addWarning(
        warnings,
        `message '${parsed.relativePath}' belongs to another session and was skipped`,
      )
      return false
    })
    .map((item) => ({
      ...item,
      createdAt: messageTimestamp(item.parsed.value),
    }))
    .filter((item) =>
    {
      if (item.createdAt !== null)
      {
        return true
      }
      addWarning(
        warnings,
        `message '${item.parsed.relativePath}' has no valid timestamp and was skipped`,
      )
      return false
    })
    .toSorted((left, right) =>
    {
      const timeOrder = Date.parse(left.createdAt ?? '') - Date.parse(right.createdAt ?? '')
      return timeOrder !== 0
        ? timeOrder
        : left.parsed.relativePath.localeCompare(right.parsed.relativePath)
    })

  let sourceIndex = 0
  let omittedAttachmentCount = 0
  let omittedAttachmentAt: string | null = null
  const warnedPartTypes = new Set<string>()

  for (const { bundle, parsed: parsedMessage, createdAt } of parsedMessages)
  {
    const role =
      parsedMessage.value.role === 'user'
        ? 'user'
        : parsedMessage.value.role === 'assistant'
          ? 'assistant'
          : null
    if (role === null || createdAt === null)
    {
      addWarning(
        warnings,
        `message '${parsedMessage.relativePath}' has an unsupported role and was skipped`,
      )
      continue
    }

    meta.model =
      boundMetadataField(
        messageModel(parsedMessage.value),
        `message '${parsedMessage.relativePath}' model`,
        warnings,
      ) ?? meta.model
    const messageId = asString(parsedMessage.value.id)
    if (messageId === null)
    {
      addWarning(warnings, `message '${parsedMessage.relativePath}' has no id and was skipped`)
      continue
    }
    if (messageId !== storedFileId(parsedMessage.relativePath))
    {
      addWarning(warnings, `message '${parsedMessage.relativePath}' id does not match its filename`)
      continue
    }

    const parsedParts = bundle.parts
      .map((file) => parseStoredFile(file, 'part', warnings))
      .filter((part): part is ParsedStoredFile => part !== null)
      .filter((part) =>
      {
        if (
          asString(part.value.sessionID) === input.sessionId &&
          asString(part.value.messageID) === messageId
        )
        {
          return true
        }
        addWarning(warnings, `part '${part.relativePath}' has mismatched ownership and was skipped`)
        return false
      })
      .filter((part) =>
      {
        const partId = asString(part.value.id)
        const partFileId = storedFileId(part.relativePath)
        if (partId === null || partId !== partFileId)
        {
          addWarning(
            warnings,
            `part '${part.relativePath}' id does not match its filename and was skipped`,
          )
          return false
        }
        if ((partFileIdCounts.get(partId) ?? 0) > 1)
        {
          addWarning(warnings, `duplicate OpenCode part id '${partId}' was skipped`)
          return false
        }
        return true
      })
      .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))

    let adjacentText: string[] = []
    let adjacentTextCreatedAt: string | null = null
    const flushAdjacentText = () =>
    {
      const text = adjacentText.join('\n').trim()
      adjacentText = []
      const textCreatedAt = adjacentTextCreatedAt ?? createdAt
      adjacentTextCreatedAt = null
      if (text.length === 0)
      {
        return
      }
      pushImportedRecord(records, {
        kind: 'message',
        role,
        text: boundUtf8(
          text,
          maxFieldBytes,
          `message '${parsedMessage.relativePath}' text`,
          warnings,
        ),
        createdAt: textCreatedAt,
        sourceIndex,
      })
      sourceIndex += 1
    }

    for (const parsedPart of parsedParts)
    {
      const part = parsedPart.value
      const partType = asString(part.type)
      const currentCreatedAt = partTimestamp(part, createdAt)

      if (partType === 'text')
      {
        if (part.ignored === true)
        {
          addWarning(warnings, `part '${parsedPart.relativePath}' ignored text was skipped`)
        }
        else if (typeof part.text === 'string')
        {
          adjacentTextCreatedAt ??= currentCreatedAt
          adjacentText.push(part.text)
        }
        else
        {
          addWarning(
            warnings,
            `part '${parsedPart.relativePath}' has malformed text and was skipped`,
          )
        }
        continue
      }
      flushAdjacentText()

      if (partType === 'reasoning')
      {
        if (typeof part.text !== 'string')
        {
          addWarning(
            warnings,
            `part '${parsedPart.relativePath}' has malformed reasoning and was skipped`,
          )
          continue
        }
        const text = boundUtf8(
          part.text.trim(),
          maxFieldBytes,
          `part '${parsedPart.relativePath}' reasoning`,
          warnings,
        )
        if (text.length > 0)
        {
          const summary = summarize(text)
          pushImportedRecord(records, {
            kind: 'activity',
            tone: 'info',
            activityKind: 'task.progress',
            summary,
            payload: { summary, detail: text },
            createdAt: currentCreatedAt,
            sourceIndex,
          })
          sourceIndex += 1
        }
        continue
      }

      if (partType === 'tool')
      {
        const mapped = toolActivity(
          part,
          currentCreatedAt,
          sourceIndex,
          parsedPart.relativePath,
          warnings,
        )
        if (mapped.activity !== null)
        {
          pushImportedRecord(records, mapped.activity)
          sourceIndex += 1
        }
        omittedAttachmentCount += mapped.attachmentCount
        if (mapped.attachmentCount > 0)
        {
          omittedAttachmentAt = currentCreatedAt
        }
        continue
      }

      if (partType === 'file')
      {
        omittedAttachmentCount += 1
        omittedAttachmentAt = currentCreatedAt
        continue
      }

      if (partType === 'patch')
      {
        const fileCount = Array.isArray(part.files) ? part.files.length : 0
        pushImportedRecord(records, {
          kind: 'activity',
          tone: 'tool',
          activityKind: 'tool.completed',
          summary:
            fileCount === 1 ? 'Applied changes to 1 file' : `Applied changes to ${fileCount} files`,
          payload: {
            itemType: 'file_change',
            fileCount,
          },
          createdAt: currentCreatedAt,
          sourceIndex,
        })
        sourceIndex += 1
        continue
      }

      if (partType === 'retry')
      {
        const summary = 'OpenCode retried the assistant response'
        const detail =
          part.error === undefined
            ? null
            : stringifyPayload(
                part.error,
                `part '${parsedPart.relativePath}' retry error`,
                warnings,
              )
        pushImportedRecord(records, {
          kind: 'activity',
          tone: 'error',
          activityKind: 'task.completed',
          summary,
          payload: {
            summary,
            ...(detail === null || detail.length === 0 ? {} : { detail }),
            attempt: asFiniteNumber(part.attempt) ?? 0,
          },
          createdAt: currentCreatedAt,
          sourceIndex,
        })
        sourceIndex += 1
        continue
      }

      if (
        partType !== null &&
        !administrativePartTypes.has(partType) &&
        !warnedPartTypes.has(partType)
      )
      {
        addWarning(warnings, `unknown OpenCode part type '${partType}' was skipped`)
        warnedPartTypes.add(partType)
      }
      else if (partType === null)
      {
        addWarning(warnings, `part '${parsedPart.relativePath}' has no type and was skipped`)
      }
    }
    flushAdjacentText()
  }

  if (omittedAttachmentCount > 0)
  {
    const noun = omittedAttachmentCount === 1 ? 'attachment' : 'attachments'
    const summary = `Omitted ${omittedAttachmentCount} ${noun} from imported transcript`
    pushImportedRecord(records, {
      kind: 'activity',
      tone: 'info',
      activityKind: 'task.completed',
      summary,
      payload: {
        omittedAttachmentCount,
        summary,
        detail: omittedAttachmentDetail,
      },
      createdAt: omittedAttachmentAt ?? records.at(-1)?.createdAt ?? new Date(0).toISOString(),
      sourceIndex,
    })
    sourceIndex += 1
  }

  const messageCount = records.filter((record) => record.kind === 'message').length
  if (!hasMetadata)
  {
    addWarning(warnings, 'no valid session metadata found; session was not imported')
  }
  if (messageCount === 0)
  {
    addWarning(warnings, 'no messages found; session was not imported')
  }
  if (!hasMetadata || messageCount === 0)
  {
    return { meta, records: [], warnings: materializeWarnings(warnings) }
  }

  appendParsingWarningActivity(records, warnings, sourceIndex, pushImportedRecord)
  applyStrictlyIncreasingTimestamps(records)
  meta.firstActivityAt = records[0]?.createdAt ?? null
  meta.lastActivityAt = records.at(-1)?.createdAt ?? null
  return { meta, records, warnings: materializeWarnings(warnings) }
}
