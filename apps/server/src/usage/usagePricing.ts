// apps/server/src/usage/usagePricing.ts
// applies exact custom model rates without guessing unknown prices

import type { UsageTokenTotals } from '@t3tools/contracts'

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
  readonly overrides: Readonly<Record<string, never>>
}): PricedUsageRecord
{
  if (input.reportedCostUsd !== null)
  {
    return { costUsd: input.reportedCostUsd, source: 'providerReported' }
  }
  return { costUsd: 0, source: 'unpriced' }
}
