// apps/mobile/src/features/usage/UsageSummarySection.tsx
// renders transcript usage and pricing coverage on mobile

import type { UsageSummary, UsageTokenTotals } from '@t3tools/contracts'
import { Pressable, View } from 'react-native'

import { AppText as Text } from '../../components/AppText'

function totalTokens(totals: UsageTokenTotals): number
{
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  )
}

function formatTokens(value: number): string
{
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}

function formatCost(value: number): string
{
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value)
}

export interface UsageSummarySectionProps
{
  readonly summary: UsageSummary | null
  readonly loading?: boolean
  readonly error?: string | null
  readonly onRefresh?: () => void
}

export function UsageSummarySection({
  summary,
  loading = false,
  error = null,
  onRefresh,
}: UsageSummarySectionProps)
{
  const tokens =
    summary?.buckets.reduce((total, bucket) => total + totalTokens(bucket.totals), 0) ?? 0
  const cost = summary?.buckets.reduce((total, bucket) => total + bucket.costUsd, 0) ?? 0
  const unpriced =
    summary?.buckets.reduce((total, bucket) => total + bucket.unpricedRecords, 0) ?? 0

  return (
    <View className="gap-4">
      <View className="flex-row items-start justify-between gap-4 px-1">
        <View className="flex-1 gap-1">
          <Text className="text-lg font-sans-bold">Usage and cost</Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            Transcript totals and API-equivalent cost. Subscription billing may differ.
          </Text>
        </View>
        {onRefresh ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh usage summary"
            disabled={loading}
            className="min-h-11 justify-center rounded-full border border-border px-4 active:opacity-70 disabled:opacity-50"
            onPress={onRefresh}
          >
            <Text className="text-sm font-sans-bold">{loading ? 'Refreshing…' : 'Refresh'}</Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <View accessibilityRole="alert" className="rounded-[22px] border border-danger px-5 py-4">
          <Text className="text-sm text-danger">{error}</Text>
        </View>
      ) : null}

      {summary === null ? (
        <View className="rounded-[22px] border border-border bg-card px-5 py-5">
          <Text className="font-sans-bold">
            {loading ? 'Reading usage…' : 'Usage is unavailable'}
          </Text>
          <Text className="mt-1 text-sm leading-normal text-foreground-muted">
            Connect this environment and refresh to read its local provider transcripts.
          </Text>
        </View>
      ) : (
        <>
          <View className="flex-row gap-3">
            <View className="flex-1 rounded-[22px] border border-border bg-card px-4 py-4">
              <Text className="text-xs text-foreground-muted">Tokens</Text>
              <Text className="mt-1 text-lg font-sans-bold tabular-nums">
                {formatTokens(tokens)}
              </Text>
            </View>
            <View className="flex-1 rounded-[22px] border border-border bg-card px-4 py-4">
              <Text className="text-xs text-foreground-muted">API cost</Text>
              <Text className="mt-1 text-lg font-sans-bold tabular-nums">{formatCost(cost)}</Text>
            </View>
          </View>
          <View className="overflow-hidden rounded-[22px] border border-border bg-card">
            {summary.buckets.length === 0 ? (
              <Text className="px-5 py-5 text-sm text-foreground-muted">
                No Claude or Codex usage was recorded in this period.
              </Text>
            ) : (
              summary.buckets.map((bucket, index) => (
                <View
                  key={`${bucket.provider}:${bucket.model}`}
                  className={`flex-row items-center justify-between gap-4 px-5 py-4 ${index > 0 ? 'border-t border-border' : ''}`}
                >
                  <View className="flex-1">
                    <Text numberOfLines={1} className="text-sm font-sans-medium">
                      {bucket.model}
                    </Text>
                    <Text className="text-xs capitalize text-foreground-muted">
                      {bucket.provider} · {formatTokens(totalTokens(bucket.totals))} tokens
                    </Text>
                  </View>
                  <Text className="text-sm font-sans-bold tabular-nums">
                    {formatCost(bucket.costUsd)}
                  </Text>
                </View>
              ))
            )}
          </View>
          {unpriced > 0 || summary.partial ? (
            <View accessibilityRole="alert" className="rounded-[22px] bg-subtle px-5 py-4">
              <Text className="text-xs leading-normal text-foreground-muted">
                {[
                  unpriced > 0 ? `${unpriced.toLocaleString()} records have no price.` : null,
                  summary.partial ? 'Some transcript files could not be included.' : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </Text>
            </View>
          ) : null}
        </>
      )}
    </View>
  )
}
