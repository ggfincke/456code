// apps/web/src/components/usage/UsageLimitsView.tsx
// renders native provider subscription limits by account
import type { LimitAccount } from '@t3tools/shared/usageLimits'
import {
  paceOf,
  formatDuration,
  formatResetsIn,
  limitAccountLabel,
  type LimitPace,
} from '@t3tools/shared/usageLimits'
import { RefreshCwIcon } from 'lucide-react'

import { Button } from '../ui/button'
import { Badge } from '../ui/badge'

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: 'Ahead of pace',
  on: 'On pace',
  under: 'Under pace',
}

function resetCreditsLabel(account: LimitAccount, now: number): string | null
{
  const credits = account.usage.resetCredits
  if (!credits) return null
  const expiresAt = credits.nextExpiresAt ? Date.parse(credits.nextExpiresAt) : Number.NaN
  const expiry =
    Number.isFinite(expiresAt) && expiresAt > now
      ? ` · next expires in ${formatDuration(expiresAt - now)}`
      : ''
  return `${credits.availableCount} reset ${credits.availableCount === 1 ? 'credit' : 'credits'}${expiry}`
}

export interface UsageLimitsViewProps
{
  readonly accounts: readonly LimitAccount[]
  readonly notices?: readonly string[]
  readonly now?: number
  readonly refreshing?: boolean
  readonly onRefresh?: () => void
}

export function UsageLimitsView({
  accounts,
  notices = [],
  now = Date.now(),
  refreshing = false,
  onRefresh,
}: UsageLimitsViewProps)
{
  const pools = accounts.map((account) => ({
    key: account.key,
    driver: account.driver,
    accounts: [account],
    windows: account.usage.windows.map((window) => ({
      ...window,
      kind: window.kind ?? 'other',
      usedPercent: Math.round(Math.max(0, Math.min(100, window.usedPercent))),
      pace: paceOf(window, now),
      resets: window.resetsAt ? [{ member: { window } }] : [],
    })),
  }))
  return (
    <section aria-labelledby="usage-limits-heading" className="space-y-6">
      <header className="flex items-start justify-between gap-4 px-1">
        <div className="space-y-1">
          <h2 id="usage-limits-heading" className="text-lg font-semibold tracking-[-0.025em]">
            Subscription limits
          </h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Remaining quota by account across connected environments.
          </p>
        </div>
        {onRefresh ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            aria-label="Refresh subscription limits"
            onClick={onRefresh}
          >
            <RefreshCwIcon className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
            Refresh
          </Button>
        ) : null}
      </header>

      {pools.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-5">
          <p className="text-sm font-medium">No subscription limits available</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Sign in to a supported Codex or Claude subscription, then refresh providers.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pools.map((pool) => (
            <section
              key={pool.key}
              aria-labelledby={`usage-limits-${pool.key}`}
              className="overflow-hidden rounded-xl border border-border/70 bg-muted/10"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
                <h3 id={`usage-limits-${pool.key}`} className="text-sm font-semibold capitalize">
                  {String(pool.driver)}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {pool.accounts.length} {pool.accounts.length === 1 ? 'account' : 'accounts'}
                </span>
              </div>
              <div className="space-y-5 px-4 py-4">
                <div className="flex flex-wrap gap-1.5" aria-label="Included accounts">
                  {pool.accounts.map((account) => (
                    <span key={account.key} className="inline-flex items-center gap-1.5">
                      <Badge variant="outline">
                        {limitAccountLabel(account)}
                        {account.environments.length > 1
                          ? ` · ${account.environments.length} envs`
                          : ''}
                      </Badge>
                      {resetCreditsLabel(account, now) ? (
                        <span className="text-xs text-muted-foreground">
                          {resetCreditsLabel(account, now)}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </div>
                {pool.windows.map((window) =>
                  {
                  const reset = window.resets[0]
                    ? formatResetsIn(window.resets[0].member.window, now)
                    : null
                  return (
                    <div key={`${window.kind}:${window.id}`} className="space-y-2">
                      <div className="flex items-baseline justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{window.label}</p>
                          <p className="text-xs text-muted-foreground">
                            {[reset, window.pace ? PACE_LABEL[window.pace] : null]
                              .filter(Boolean)
                              .join(' · ') || 'Reset time unavailable'}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {window.usedPercent}% used
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`${window.label} quota used`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={window.usedPercent}
                        className="h-2 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
                          style={{ width: `${window.usedPercent}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {notices.length > 0 ? (
        <div
          role="status"
          className="space-y-1 rounded-xl border border-border/70 bg-muted/20 px-4 py-3"
        >
          {notices.map((notice) => (
            <p key={notice} className="text-xs leading-relaxed text-muted-foreground">
              {notice}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  )
}
