// packages/contracts/src/usage.ts
// defines bounded transcript usage summaries and custom pricing

import * as Schema from 'effect/Schema'

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from './baseSchemas.ts'

export const USAGE_SUMMARY_MAX_BUCKETS = 1_000
export const USAGE_SUMMARY_MAX_SOURCES = 64

export const UsageProviderKind = Schema.Literals(['claude', 'codex'])
export type UsageProviderKind = typeof UsageProviderKind.Type

export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
})
export type UsageTokenTotals = typeof UsageTokenTotals.Type

const UsageModelTokenPrice = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
)

export const UsageModelPriceOverride = Schema.Struct({
  inputCostPerMillionTokens: UsageModelTokenPrice,
  outputCostPerMillionTokens: UsageModelTokenPrice,
  cacheReadCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
  cacheWriteCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
})
export type UsageModelPriceOverride = typeof UsageModelPriceOverride.Type

export const UsageSummaryInput = Schema.Struct({
  since: IsoDateTime,
  until: IsoDateTime,
})
export type UsageSummaryInput = typeof UsageSummaryInput.Type

export const UsageModelBucket = Schema.Struct({
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: UsageModelTokenPrice,
  records: NonNegativeInt,
  sessions: NonNegativeInt,
  providerReportedRecords: NonNegativeInt,
  customPricedRecords: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
})
export type UsageModelBucket = typeof UsageModelBucket.Type

export const UsageSummarySource = Schema.Struct({
  provider: UsageProviderKind,
  fingerprint: TrimmedNonEmptyString,
  status: Schema.Literals(['ok', 'partial', 'failed']),
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
})
export type UsageSummarySource = typeof UsageSummarySource.Type

export const UsageSummary = Schema.Struct({
  readAt: IsoDateTime,
  since: IsoDateTime,
  until: IsoDateTime,
  buckets: Schema.Array(UsageModelBucket).check(Schema.isMaxLength(USAGE_SUMMARY_MAX_BUCKETS)),
  sources: Schema.Array(UsageSummarySource).check(Schema.isMaxLength(USAGE_SUMMARY_MAX_SOURCES)),
  partial: Schema.Boolean,
})
export type UsageSummary = typeof UsageSummary.Type

export class UsageReadError extends Schema.TaggedError<UsageReadError>()('UsageReadError', {
  reason: Schema.Literals(['invalid-window', 'scan-failed']),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
})
{
  override get message(): string
  {
    return `Usage read failed (${this.reason}): ${this.detail}`
  }
}
