// apps/server/src/usage/usagePricing.ts
// applies exact custom model rates without guessing unknown prices

import type { UsageModelPriceOverride, UsageTokenTotals } from '@t3tools/contracts'

export type UsageRecordCostSource = 'providerReported' | 'customPriced' | 'unpriced'

export interface PricedUsageRecord
{
  readonly costUsd: number
  readonly source: UsageRecordCostSource
}

export function priceUsageRecord(input: {
  readonly model: string
  readonly totals: UsageTokenTotals
  readonly reportedCostUsd: number | null
  readonly overrides: Readonly<Record<string, UsageModelPriceOverride>>
}): PricedUsageRecord
{
  const override = Object.hasOwn(input.overrides, input.model)
    ? input.overrides[input.model]
    : undefined
  if (override !== undefined)
  {
    const inputRate = override.inputCostPerMillionTokens / 1_000_000
    const outputRate = override.outputCostPerMillionTokens / 1_000_000
    const cacheReadRate =
      (override.cacheReadCostPerMillionTokens ?? override.inputCostPerMillionTokens) / 1_000_000
    const cacheWriteRate =
      (override.cacheWriteCostPerMillionTokens ?? override.inputCostPerMillionTokens) / 1_000_000
    return {
      costUsd:
        input.totals.uncachedInputTokens * inputRate +
        input.totals.cachedInputTokens * cacheReadRate +
        input.totals.cacheCreationTokens * cacheWriteRate +
        input.totals.outputTokens * outputRate,
      source: 'customPriced',
    }
  }
  if (input.reportedCostUsd !== null)
  {
    return { costUsd: input.reportedCostUsd, source: 'providerReported' }
  }
  return { costUsd: 0, source: 'unpriced' }
}
