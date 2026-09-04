// apps/web/src/components/usage/UsageSummaryView.tsx
// renders bounded transcript usage and pricing coverage

import type { UsageSummary, UsageTokenTotals } from '@t3tools/contracts'
import { useId } from 'react'
import { RefreshCwIcon } from 'lucide-react'

import { Button } from '../ui/button'

function addTotals(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals
{
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

function tokenCount(totals: UsageTokenTotals): number
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
    minimumFractionDigits: value < 1 ? 2 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value)
}

export interface UsageSummaryViewProps
{
  readonly summary: UsageSummary | null
  readonly loading?: boolean
  readonly error?: string | null
  readonly onRefresh?: () => void
}

export function UsageSummaryView({
  summary,
  loading = false,
  error = null,
  onRefresh,
}: UsageSummaryViewProps)
{
  const headingId = useId()
  const totals =
    summary?.buckets.reduce((current, bucket) => addTotals(current, bucket.totals), {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    }) ?? null
  const cost = summary?.buckets.reduce((total, bucket) => total + bucket.costUsd, 0) ?? 0
  const unpricedRecords =
    summary?.buckets.reduce((total, bucket) => total + bucket.unpricedRecords, 0) ?? 0

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <header className="flex items-start justify-between gap-4 px-1">
        <div className="space-y-1">
          <h2 id={headingId} className="text-lg font-semibold tracking-[-0.025em]">
            Usage and cost
          </h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Transcript token totals and API-equivalent cost. Subscription billing may differ.
          </p>
        </div>
        {onRefresh ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            aria-label="Refresh usage summary"
            onClick={onRefresh}
          >
            <RefreshCwIcon className={loading ? 'animate-spin' : undefined} aria-hidden="true" />
            Refresh
          </Button>
        ) : null}
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
        >
          {error}
        </div>
      ) : null}

      {summary === null ? (
        <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-5">
          <p className="text-sm font-medium">
            {loading ? 'Reading usage…' : 'Usage is unavailable'}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Connect this environment and refresh to read its local Claude and Codex transcripts.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs text-muted-foreground">Tokens</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatTokens(tokenCount(totals!))}
              </p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs text-muted-foreground">API-equivalent cost</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{formatCost(cost)}</p>
            </div>
            <div className="col-span-2 rounded-xl border border-border/70 px-4 py-3 sm:col-span-1">
              <p className="text-xs text-muted-foreground">Pricing coverage</p>
              <p className="mt-1 text-sm font-medium">
                {unpricedRecords === 0
                  ? 'All records priced'
                  : `${unpricedRecords.toLocaleString()} unpriced records`}
              </p>
            </div>
          </div>

          <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
            {summary.buckets.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">
                No Claude or Codex usage was recorded in this period.
              </p>
            ) : (
              summary.buckets.map((bucket) => (
                <div
                  key={`${bucket.provider}:${bucket.model}`}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{bucket.model}</p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {bucket.provider} · {formatTokens(tokenCount(bucket.totals))} tokens ·{' '}
                      {bucket.records.toLocaleString()} responses
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatCost(bucket.costUsd)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {bucket.unpricedRecords > 0
                        ? `${bucket.unpricedRecords} unpriced`
                        : bucket.customPricedRecords > 0
                          ? 'custom rate'
                          : 'provider reported'}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>

          {summary.partial ? (
            <p
              role="status"
              className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground"
            >
              This is a partial summary because one or more transcript scan limits or reads failed.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
