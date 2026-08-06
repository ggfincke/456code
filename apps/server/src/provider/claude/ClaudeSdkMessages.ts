// apps/server/src/provider/claude/ClaudeSdkMessages.ts
// extracts and diagnoses low-level Claude SDK message content

import type { RuntimeContentStreamKind } from '@t3tools/contracts'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString)
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString)

type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, 'assistant_text' | 'reasoning_text'>

interface ClaudeSdkMessageView
{
  readonly type: string
  readonly subtype?: unknown
  readonly message?: unknown
  readonly event?: unknown
  readonly tool_use_result?: unknown
}

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined
{
  const result = encodeUnknownJsonStringExit(input)
  return Exit.isSuccess(result) ? result.value : undefined
}

export function readClaudeToolUseResult(
  message: ClaudeSdkMessageView,
): Record<string, unknown> | undefined
{
  if (message.type !== 'user')
  {
    return undefined
  }
  const result = (message as { readonly tool_use_result?: unknown }).tool_use_result
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind
{
  return deltaType.includes('thinking') ? 'reasoning_text' : 'assistant_text'
}

export function extractAssistantTextBlocks(message: ClaudeSdkMessageView): Array<string>
{
  if (message.type !== 'assistant')
  {
    return []
  }

  const content = (message.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content))
  {
    return []
  }

  const fragments: Array<string> = []
  for (const block of content)
  {
    if (!block || typeof block !== 'object')
    {
      continue
    }
    const candidate = block as { type?: unknown; text?: unknown }
    if (
      candidate.type === 'text' &&
      typeof candidate.text === 'string' &&
      candidate.text.length > 0
    )
    {
      fragments.push(candidate.text)
    }
  }

  return fragments
}

export function extractContentBlockText(block: unknown): string
{
  if (!block || typeof block !== 'object')
  {
    return ''
  }

  const candidate = block as { type?: unknown; text?: unknown }
  return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
}

function extractTextContent(value: unknown): string
{
  if (typeof value === 'string')
  {
    return value
  }

  if (Array.isArray(value))
  {
    return value.map((entry) => extractTextContent(entry)).join('')
  }

  if (!value || typeof value !== 'object')
  {
    return ''
  }

  const record = value as {
    text?: unknown
    content?: unknown
  }

  if (typeof record.text === 'string')
  {
    return record.text
  }

  return extractTextContent(record.content)
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined
{
  const result = decodeUnknownJsonStringExit(value)
  if (!Exit.isSuccess(result))
  {
    return undefined
  }
  const parsed = result.value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined
{
  return encodeJsonStringForDiagnostics(input)
}

export function toolResultBlocksFromUserMessage(message: ClaudeSdkMessageView): Array<{
  readonly toolUseId: string
  readonly block: Record<string, unknown>
  readonly text: string
  readonly isError: boolean
}>
{
  if (message.type !== 'user')
  {
    return []
  }

  const content = (message.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content))
  {
    return []
  }

  const blocks: Array<{
    readonly toolUseId: string
    readonly block: Record<string, unknown>
    readonly text: string
    readonly isError: boolean
  }> = []

  for (const entry of content)
  {
    if (!entry || typeof entry !== 'object')
    {
      continue
    }

    const block = entry as Record<string, unknown>
    if (block.type !== 'tool_result')
    {
      continue
    }

    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    if (!toolUseId)
    {
      continue
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    })
  }

  return blocks
}

function sdkMessageType(value: unknown): string | undefined
{
  if (!value || typeof value !== 'object')
  {
    return undefined
  }
  const record = value as { type?: unknown }
  return typeof record.type === 'string' ? record.type : undefined
}

function sdkMessageSubtype(value: unknown): string | undefined
{
  if (!value || typeof value !== 'object')
  {
    return undefined
  }
  const record = value as { subtype?: unknown }
  return typeof record.subtype === 'string' ? record.subtype : undefined
}

export function sdkNativeMethod(message: ClaudeSdkMessageView): string
{
  const subtype = sdkMessageSubtype(message)
  if (subtype)
  {
    return `claude/${message.type}/${subtype}`
  }

  if (message.type === 'stream_event')
  {
    const streamType = sdkMessageType(message.event)
    if (streamType)
    {
      const deltaType =
        streamType === 'content_block_delta'
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined
      if (deltaType)
      {
        return `claude/${message.type}/${streamType}/${deltaType}`
      }
      return `claude/${message.type}/${streamType}`
    }
  }

  return `claude/${message.type}`
}

const SDK_MESSAGE_NOISE_KEYS = new Set([
  'type',
  'subtype',
  'uuid',
  'parent_uuid',
  'session_id',
  'parent_tool_use_id',
  'request_id',
])

// pull salient scalar content from messages the adapter doesn't model yet
function previewUnknownSdkContent(message: unknown): string | undefined
{
  if (!message || typeof message !== 'object')
  {
    return undefined
  }
  const parts: Array<string> = []
  for (const [key, value] of Object.entries(message as Record<string, unknown>))
  {
    if (SDK_MESSAGE_NOISE_KEYS.has(key))
    {
      continue
    }
    if (typeof value === 'string')
    {
      const trimmed = value.trim()
      if (trimmed.length > 0)
      {
        parts.push(`${key}: ${trimmed}`)
      }
    }
    else if (typeof value === 'number' || typeof value === 'boolean')
    {
      parts.push(`${key}: ${String(value)}`)
    }
  }
  if (parts.length === 0)
  {
    return undefined
  }
  const joined = parts.join(' · ')
  return joined.length > 280 ? `${joined.slice(0, 279)}…` : joined
}

export function describeUnknownSdkMessage(kind: string, message: unknown): string
{
  const preview = previewUnknownSdkContent(message)
  return preview ? `${kind} — ${preview}` : `${kind} (no displayable text content)`
}

export function sdkNativeItemId(message: ClaudeSdkMessageView): string | undefined
{
  if (message.type === 'assistant')
  {
    const maybeId = (message.message as { id?: unknown }).id
    if (typeof maybeId === 'string')
    {
      return maybeId
    }
    return undefined
  }

  if (message.type === 'user')
  {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId
  }

  if (message.type === 'stream_event')
  {
    const event = message.event as {
      type?: unknown
      content_block?: { id?: unknown }
    }
    if (event.type === 'content_block_start' && typeof event.content_block?.id === 'string')
    {
      return event.content_block.id
    }
  }

  return undefined
}
