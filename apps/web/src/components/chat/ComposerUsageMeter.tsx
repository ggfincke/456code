// apps/web/src/components/chat/ComposerUsageMeter.tsx
// combines provider-plan and context-window usage in the composer footer meter
import type { ServerProviderAccountUsage } from '@t3tools/contracts'

import { useClientSettings } from '~/hooks/useSettings'
import { cn } from '~/lib/utils'
import { type ContextWindowSnapshot, formatContextWindowTokens } from '~/lib/contextWindow'
import type { ThreadContextWindowSelection } from './composerContextWindow'
import { Popover, PopoverPopup, PopoverTrigger } from '../ui/popover'
import {
  formatProviderUsagePercent,
  isProviderUsageWindowDanger,
  ProviderUsageDetails,
} from './ProviderUsage'

function formatPercentage(value: number | null): string | null
{
  if (value === null || !Number.isFinite(value)) return null
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/u, '')}%`
  return `${Math.round(value)}%`
}

function tightestAccountWindow(usage: ServerProviderAccountUsage | undefined)
{
  if (usage?.status !== 'available') return null
  return usage.windows.reduce((tightest, window) =>
    window.usedPercent > tightest.usedPercent ? window : tightest,
  )
}

// the thread has usage on record, but none of it can be attributed to the
// provider named in the popup header — an em dash beats a wrong number.
function EmptyContextWindowDetails(props: { providerDisplayName?: string | null | undefined })
{
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Context window</div>
        <div className="text-[11px] tabular-nums text-muted-foreground/70">—</div>
      </div>
      <div className="text-pretty text-[11px] leading-4 text-muted-foreground/60">
        {props.providerDisplayName ?? 'This agent'} has not reported context usage on this thread
        yet.
      </div>
    </div>
  )
}

function ContextWindowDetails(props: {
  usage: ContextWindowSnapshot
  qualifier?: string | undefined
  providerDisplayName?: string | null | undefined
})
{
  const usedPercentage = formatPercentage(props.usage.usedPercentage)
  const normalizedPercentage = Math.max(0, Math.min(100, props.usage.usedPercentage ?? 0))
  const totalProcessedTokens = props.usage.totalProcessedTokens ?? null
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0
  const usageColor =
    normalizedPercentage > 90
      ? 'var(--color-red-500)'
      : 'color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <div className="font-medium text-muted-foreground text-xs">Context window</div>
          {props.qualifier ? (
            <div className="truncate text-[10px] text-muted-foreground/50">{props.qualifier}</div>
          ) : null}
        </div>
        {props.usage.maxTokens !== null && usedPercentage ? (
          <div className="text-[11px] tabular-nums text-muted-foreground/70">
            <span>{usedPercentage}</span>
            <span className="mx-1">·</span>
            <span>
              {formatContextWindowTokens(props.usage.usedTokens)}/
              {formatContextWindowTokens(props.usage.maxTokens ?? null)}
            </span>
          </div>
        ) : (
          <div className="text-[11px] tabular-nums text-muted-foreground/70">
            {formatContextWindowTokens(props.usage.usedTokens)}
          </div>
        )}
      </div>
      {props.usage.maxTokens !== null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(normalizedPercentage)}
          aria-label="Context window usage"
        >
          <div
            className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
          />
        </div>
      ) : null}
      {showTotalProcessed ? (
        <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
          <span className="text-muted-foreground/60">Total processed</span>
          <span className="font-medium tabular-nums text-muted-foreground/80">
            {formatContextWindowTokens(totalProcessedTokens)}
          </span>
        </div>
      ) : null}
      {/* the compaction note names the labelled provider, so it is only true
          for a snapshot that provider actually recorded */}
      {props.usage.compactsAutomatically && !props.qualifier ? (
        <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
          {props.providerDisplayName ?? 'It'} automatically compacts its context when needed.
        </div>
      ) : null}
    </div>
  )
}

export function ComposerUsageMeter(props: {
  contextUsage: ThreadContextWindowSelection
  accountUsage?: ServerProviderAccountUsage | undefined
  providerDisplayName?: string | null
})
{
  const { accountUsage, contextUsage: contextSelection, providerDisplayName } = props
  const usageDisplayMode = useClientSettings((settings) => settings.providerUsageDisplayMode)
  // only the current provider's snapshot may drive the ring. A snapshot the
  // thread has switched away from stays behind its qualifier in the popup so
  // the meter itself never reads as the new provider's usage.
  const contextUsage = contextSelection.state === 'current' ? contextSelection.snapshot : null
  const carriedOverUsage =
    contextSelection.state === 'previous-provider' ? contextSelection.snapshot : null
  const hasContextSection = contextSelection.state !== 'none'
  if (!hasContextSection && !accountUsage) return null

  const contextPercentage = Math.max(0, Math.min(100, contextUsage?.usedPercentage ?? 0))
  const accountWindow = tightestAccountWindow(accountUsage)
  const normalizedPercentage = contextUsage ? contextPercentage : (accountWindow?.usedPercent ?? 0)
  const radius = 9.75
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference
  const contextUsedLabel = contextUsage ? formatPercentage(contextUsage.usedPercentage) : null
  const isDanger = contextUsage
    ? normalizedPercentage > 90
    : accountWindow
      ? isProviderUsageWindowDanger(accountWindow)
      : false
  const usageColor = isDanger
    ? 'var(--color-red-500)'
    : 'color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)'
  const ariaLabel = contextUsage
    ? contextUsage.maxTokens !== null && contextUsedLabel
      ? `Usage: context window ${contextUsedLabel} used${accountUsage ? '; provider plan usage available' : ''}`
      : `Usage: context window ${formatContextWindowTokens(contextUsage.usedTokens)} tokens used${accountUsage ? '; provider plan usage available' : ''}`
    : hasContextSection
      ? `Usage: no context window reported for the current provider${accountUsage ? '; provider plan usage available' : ''}`
      : accountWindow
        ? `Provider usage: ${formatProviderUsagePercent(accountWindow, usageDisplayMode)} in the ${accountWindow.label} window`
        : 'Provider usage'

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              'inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors',
              'hover:bg-accent data-[pressed]:bg-accent',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            )}
            aria-label={ariaLabel}
            data-composer-usage-meter="true"
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              {!contextUsage && !accountWindow ? (
                <span className="size-1 rounded-full bg-muted-foreground/60" aria-hidden="true" />
              ) : null}
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        className="dropdown-glass w-72 max-w-none border-0! bg-secondary! p-0 shadow-none! before:hidden"
      >
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Usage</div>
            {providerDisplayName ? (
              <div className="truncate text-[10px] text-muted-foreground/50">
                {providerDisplayName}
              </div>
            ) : null}
          </div>
          {accountUsage ? (
            <ProviderUsageDetails usage={accountUsage} displayMode={usageDisplayMode} />
          ) : null}
          {accountUsage && hasContextSection ? <div className="h-px bg-border/65" /> : null}
          {contextUsage ? (
            <ContextWindowDetails usage={contextUsage} providerDisplayName={providerDisplayName} />
          ) : carriedOverUsage ? (
            <ContextWindowDetails
              usage={carriedOverUsage}
              qualifier="from previous provider"
              providerDisplayName={providerDisplayName}
            />
          ) : contextSelection.state === 'unavailable' ? (
            <EmptyContextWindowDetails providerDisplayName={providerDisplayName} />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
