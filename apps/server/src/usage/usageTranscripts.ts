// apps/server/src/usage/usageTranscripts.ts
// extracts billable deltas from Claude and Codex transcripts

import type { UsageProviderKind, UsageTokenTotals } from '@t3tools/contracts'

export interface UsageRecord
{
  readonly provider: UsageProviderKind
  readonly timestampMs: number
  readonly model: string
  readonly sessionId: string
  readonly totals: UsageTokenTotals
  readonly reportedCostUsd: number | null
  readonly dedupeKey: string | null
}

export interface ParsedUsageTranscript
{
  readonly records: ReadonlyArray<UsageRecord>
  readonly malformedRecords: number
}

export const EMPTY_USAGE_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
}

function nonNegativeInt(value: unknown): number
{
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function timestampMillis(value: unknown): number | null
{
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function addUsageTotals(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals
{
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

export function totalUsageTokens(totals: UsageTokenTotals): number
{
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  )
}

function parseClaudeLine(line: string): UsageRecord | null
{
  let parsed: unknown
  try
  {
    parsed = JSON.parse(line)
  }
  catch
  {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  if (record.type !== 'assistant') return null
  const message = record.message
  if (typeof message !== 'object' || message === null) return null
  const messageRecord = message as Record<string, unknown>
  const usage = messageRecord.usage
  if (typeof usage !== 'object' || usage === null) return null
  const timestampMs = timestampMillis(record.timestamp)
  const model = typeof messageRecord.model === 'string' ? messageRecord.model.trim() : ''
  if (timestampMs === null || model.length === 0) return null

  const usageRecord = usage as Record<string, unknown>
  const totals = {
    uncachedInputTokens: nonNegativeInt(usageRecord.input_tokens),
    cachedInputTokens: nonNegativeInt(usageRecord.cache_read_input_tokens),
    cacheCreationTokens: nonNegativeInt(usageRecord.cache_creation_input_tokens),
    outputTokens: nonNegativeInt(usageRecord.output_tokens),
    reasoningTokens: 0,
  } satisfies UsageTokenTotals
  if (totalUsageTokens(totals) === 0) return null

  const messageId = typeof messageRecord.id === 'string' ? messageRecord.id : null
  const requestId = typeof record.requestId === 'string' ? record.requestId : null
  const cost = record.costUSD
  return {
    provider: 'claude',
    timestampMs,
    model,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    totals,
    reportedCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    dedupeKey:
      messageId === null && requestId === null ? null : `${messageId ?? ''}:${requestId ?? ''}`,
  }
}

interface CodexScanState
{
  model: string
  sessionId: string
  lastTokenCountSignature: string | null
  sawSessionMeta: boolean
  suppressingForkCopies: boolean
  forkCopyAnchorMs: number
}

function initialCodexScanState(): CodexScanState
{
  return {
    model: '',
    sessionId: '',
    lastTokenCountSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  }
}

function isForkedCodexSession(payload: Record<string, unknown>): boolean
{
  if (typeof payload.forked_from_id === 'string') return true
  const source = payload.source
  if (typeof source !== 'object' || source === null) return false
  const subagent = (source as Record<string, unknown>).subagent
  if (typeof subagent !== 'object' || subagent === null) return false
  const spawn = (subagent as Record<string, unknown>).thread_spawn
  return (
    typeof spawn === 'object' &&
    spawn !== null &&
    typeof (spawn as Record<string, unknown>).parent_thread_id === 'string'
  )
}

function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null
{
  let parsed: unknown
  try
  {
    parsed = JSON.parse(line)
  }
  catch
  {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return null
  const payloadRecord = payload as Record<string, unknown>

  if (record.type === 'session_meta')
  {
    if (state.sawSessionMeta) return null
    state.sawSessionMeta = true
    const id = payloadRecord.id ?? payloadRecord.session_id
    if (typeof id === 'string') state.sessionId = id
    const observedAt = timestampMillis(record.timestamp)
    if (observedAt !== null && isForkedCodexSession(payloadRecord))
    {
      state.suppressingForkCopies = true
      state.forkCopyAnchorMs = observedAt
    }
    return null
  }
  if (record.type === 'turn_context')
  {
    if (typeof payloadRecord.model === 'string') state.model = payloadRecord.model.trim()
    return null
  }
  if (payloadRecord.type !== 'token_count') return null

  const info = payloadRecord.info
  if (typeof info !== 'object' || info === null) return null
  const infoRecord = info as Record<string, unknown>
  const last = infoRecord.last_token_usage
  if (typeof last !== 'object' || last === null) return null
  const timestampMs = timestampMillis(record.timestamp)
  if (timestampMs === null || state.model.length === 0) return null

  const lastRecord = last as Record<string, unknown>
  const cumulative = infoRecord.total_token_usage
  const signature = JSON.stringify(
    typeof cumulative === 'object' && cumulative !== null
      ? { cumulative, last: lastRecord, model: state.model }
      : { timestamp: record.timestamp, last: lastRecord, model: state.model },
  )
  if (signature === state.lastTokenCountSignature) return null
  state.lastTokenCountSignature = signature

  if (state.suppressingForkCopies)
  {
    if (timestampMs - state.forkCopyAnchorMs < 1_000)
    {
      state.forkCopyAnchorMs = timestampMs
      return null
    }
    state.suppressingForkCopies = false
  }

  const inputTokens = nonNegativeInt(lastRecord.input_tokens)
  const cachedInputTokens = nonNegativeInt(lastRecord.cached_input_tokens)
  const cacheCreationTokens = nonNegativeInt(lastRecord.cache_write_input_tokens)
  const outputTokens = nonNegativeInt(lastRecord.output_tokens)
  const totals = {
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, nonNegativeInt(lastRecord.reasoning_output_tokens)),
  } satisfies UsageTokenTotals
  if (totalUsageTokens(totals) === 0) return null

  return {
    provider: 'codex',
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: null,
    dedupeKey: null,
  }
}

export function parseUsageTranscript(
  provider: UsageProviderKind,
  content: string,
): ParsedUsageTranscript
{
  const records: UsageRecord[] = []
  let malformedRecords = 0
  const codexState = initialCodexScanState()
  for (const line of content.split('\n'))
  {
    const mightCarryUsage =
      provider === 'claude'
        ? line.includes('"usage"')
        : line.includes('"session_meta"') ||
          line.includes('"turn_context"') ||
          line.includes('"token_count"')
    if (!mightCarryUsage) continue
    const record = provider === 'claude' ? parseClaudeLine(line) : parseCodexLine(line, codexState)
    if (record)
    {
      records.push(record)
    }
    else
    {
      try
      {
        JSON.parse(line)
      }
      catch
      {
        malformedRecords += 1
      }
    }
  }
  return { records, malformedRecords }
}
