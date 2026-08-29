// apps/server/src/provider/claude/ClaudeTokenUsage.ts
// normalizes Claude context-window and token usage snapshots

import type {
  ModelSelection,
  TaskUsageSnapshot,
  ThreadCompactionSummary,
  ThreadTokenUsageSnapshot,
} from '@t3tools/contracts'

import { resolveClaudeContextWindow } from '../Layers/ClaudeProvider.ts'

export function maxClaudeContextWindowFromModelUsage(
  modelUsage: Readonly<Record<string, { readonly contextWindow: number }>> | undefined,
): number | undefined
{
  if (!modelUsage) return undefined

  let maxContextWindow: number | undefined
  for (const value of Object.values(modelUsage))
  {
    const contextWindow = value.contextWindow
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow)
  }

  return maxContextWindow
}

export function selectedClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): number | undefined
{
  switch (modelSelection?.model)
  {
    case 'claude-opus-4-8':
    case 'claude-opus-4-7':
      // these models expose no contextWindow option because the API always uses 1M
      return 1_000_000
  }

  switch (resolveClaudeContextWindow(modelSelection))
  {
    case '1m':
      return 1_000_000
    case '200k':
      return 200_000
    default:
      return undefined
  }
}

export function finiteNonNegativeInteger(value: unknown): number | undefined
{
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}

function finitePositiveInteger(value: unknown): number | undefined
{
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

export function claudeUsageInputTokens(usage: Readonly<Record<string, unknown>>): number
{
  return (
    (finiteNonNegativeInteger(usage.input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_creation_input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_read_input_tokens) ?? 0)
  )
}

export function claudeUsageOutputTokens(usage: Readonly<Record<string, unknown>>): number
{
  return finiteNonNegativeInteger(usage.output_tokens) ?? 0
}

export function lastClaudeUsageIteration(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined
{
  const iterations = Array.isArray(value.iterations) ? value.iterations : []
  return iterations.findLast(
    (iteration): iteration is Record<string, unknown> =>
      iteration !== null && typeof iteration === 'object' && !Array.isArray(iteration),
  )
}

export function claudeTotalProcessedTokens(value: unknown): number | undefined
{
  if (!value || typeof value !== 'object' || Array.isArray(value))
  {
    return undefined
  }

  const usage = value as Record<string, unknown>
  const explicitTotal = finiteNonNegativeInteger(usage.total_tokens)
  if (explicitTotal !== undefined && explicitTotal > 0)
  {
    return explicitTotal
  }

  const total = claudeUsageInputTokens(usage) + claudeUsageOutputTokens(usage)
  return total > 0 ? total : undefined
}

function makeClaudeTokenUsageSnapshot(input: {
  readonly activeTokens: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly contextWindow?: number
  readonly totalProcessedTokens?: number
  readonly lastUsedTokens?: number
  readonly compactsAutomatically?: boolean
}): ThreadTokenUsageSnapshot | undefined
{
  const activeTokens = finiteNonNegativeInteger(input.activeTokens)
  if (activeTokens === undefined || activeTokens <= 0)
  {
    return undefined
  }

  const maxTokens = finitePositiveInteger(input.contextWindow)
  const usedTokens = maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens
  const lastUsedTokens =
    finiteNonNegativeInteger(input.lastUsedTokens) ??
    (maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens)
  const totalProcessedTokens = finiteNonNegativeInteger(input.totalProcessedTokens)
  const inputTokens = finiteNonNegativeInteger(input.inputTokens)
  const outputTokens = finiteNonNegativeInteger(input.outputTokens)

  return {
    usedTokens,
    lastUsedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input.compactsAutomatically !== undefined
      ? { compactsAutomatically: input.compactsAutomatically }
      : {}),
  }
}

export function normalizeClaudeActiveTokenUsage(
  value: unknown,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined
{
  if (!value || typeof value !== 'object')
  {
    return undefined
  }

  const usage = value as Record<string, unknown>
  const activeUsage = lastClaudeUsageIteration(usage) ?? usage
  const inputTokens = claudeUsageInputTokens(activeUsage)
  const outputTokens = claudeUsageOutputTokens(activeUsage)
  const activeTokens = claudeTotalProcessedTokens(activeUsage) ?? inputTokens + outputTokens
  if (activeTokens <= 0)
  {
    return undefined
  }

  return makeClaudeTokenUsageSnapshot({
    activeTokens,
    inputTokens,
    outputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  })
}

export function compactBoundaryTokenUsageSnapshot(
  message: Readonly<Record<string, unknown>>,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined
{
  const metadata = message.compact_metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
  {
    return undefined
  }

  const compactMetadata = metadata as Record<string, unknown>
  const postTokens = finiteNonNegativeInteger(compactMetadata.post_tokens)
  if (postTokens === undefined || postTokens <= 0)
  {
    return undefined
  }

  const preTokens = finiteNonNegativeInteger(compactMetadata.pre_tokens)
  return makeClaudeTokenUsageSnapshot({
    activeTokens: postTokens,
    ...(preTokens !== undefined ? { lastUsedTokens: preTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  })
}

// the same compact_metadata blob, read for the numbers a work-log row can show. kept separate
// from the usage snapshot above because that one is typed as ThreadTokenUsageSnapshot & feeds
// the context meter. only scalars are lifted out: the live blob also carries
// pre_compact_discovered_tools and the preserved_segment / preserved_messages uuid arrays, which
// must never end up projected into an activity row
export function compactBoundaryMetadata(
  message: Readonly<Record<string, unknown>>,
): ThreadCompactionSummary | undefined
{
  const metadata = message.compact_metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
  {
    return undefined
  }

  const compactMetadata = metadata as Record<string, unknown>
  const trigger = compactMetadata.trigger
  if (trigger !== 'manual' && trigger !== 'auto')
  {
    return undefined
  }

  const preTokens = finiteNonNegativeInteger(compactMetadata.pre_tokens)
  const postTokens = finiteNonNegativeInteger(compactMetadata.post_tokens)
  const durationMs = finiteNonNegativeInteger(compactMetadata.duration_ms)
  return {
    trigger,
    ...(preTokens !== undefined ? { preTokens } : {}),
    ...(postTokens !== undefined ? { postTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

export function normalizeClaudeTaskProgressTokenUsage(
  value: unknown,
  context: {
    readonly lastKnownTokenUsage: { readonly usedTokens: number } | undefined
    readonly lastKnownContextWindow: number | undefined
    readonly lastKnownTotalProcessedTokens: number | undefined
  },
): ThreadTokenUsageSnapshot | undefined
{
  const totalTokens = claudeTotalProcessedTokens(value)
  if (totalTokens === undefined || totalTokens <= 0)
  {
    return undefined
  }

  const lastUsedTokens = context.lastKnownTokenUsage?.usedTokens
  const activeTokens =
    lastUsedTokens !== undefined ? Math.max(totalTokens, lastUsedTokens) : totalTokens
  if (lastUsedTokens !== undefined && activeTokens === lastUsedTokens)
  {
    return undefined
  }

  const usage = value as Record<string, unknown>
  const snapshot = makeClaudeTokenUsageSnapshot({
    activeTokens,
    ...(context.lastKnownContextWindow !== undefined
      ? { contextWindow: context.lastKnownContextWindow }
      : {}),
    totalProcessedTokens: Math.max(
      totalTokens,
      context.lastKnownTotalProcessedTokens ?? totalTokens,
    ),
  })
  if (!snapshot)
  {
    return undefined
  }

  const toolUses = finiteNonNegativeInteger(usage.tool_uses)
  const durationMs = finiteNonNegativeInteger(usage.duration_ms)
  return {
    ...snapshot,
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

// per-task usage snapshot from sdk task frames (total_tokens/tool_uses/duration_ms)
export function normalizeClaudeTaskUsage(value: unknown): TaskUsageSnapshot | undefined
{
  if (!value || typeof value !== 'object' || Array.isArray(value))
  {
    return undefined
  }

  const usage = value as Record<string, unknown>
  const totalTokens = finiteNonNegativeInteger(usage.total_tokens)
  if (totalTokens === undefined)
  {
    return undefined
  }

  const toolUses = finiteNonNegativeInteger(usage.tool_uses)
  const durationMs = finiteNonNegativeInteger(usage.duration_ms)
  return {
    totalTokens,
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}
