// apps/mobile/src/features/usage/UsageLimitsSection.tsx
// renders native provider subscription limits on mobile
import type { LimitAccount } from '@t3tools/shared/usageLimits'
import {
  remainingPercent,
  formatDuration,
  formatResetsIn,
  limitAccountLabel,
} from '@t3tools/shared/usageLimits'
import { Pressable, View } from 'react-native'

import { AppText as Text } from '../../components/AppText'

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

export interface UsageLimitsSectionProps
{
  readonly accounts: readonly LimitAccount[]
  readonly notices?: readonly string[]
  readonly now?: number
  readonly refreshing?: boolean
  readonly onRefresh?: () => void
}

export function UsageLimitsSection({
  accounts,
  notices = [],
  now = Date.now(),
  refreshing = false,
  onRefresh,
}: UsageLimitsSectionProps)
{
  const pools = accounts.map((account) => ({
    key: account.key,
    driver: account.driver,
    accounts: [account],
    windows: account.usage.windows.map((window) => ({
      ...window,
      kind: window.kind ?? 'other',
      remainingPercent: remainingPercent(window),
      resets: window.resetsAt ? [{ member: { window } }] : [],
    })),
  }))
  return (
    <View className="gap-4">
      <View className="flex-row items-start justify-between gap-4 px-1">
        <View className="flex-1 gap-1">
          <Text className="text-lg font-sans-bold">Subscription limits</Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            Remaining quota across connected environments.
          </Text>
        </View>
        {onRefresh ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh subscription limits"
            disabled={refreshing}
            className="min-h-11 justify-center rounded-full border border-border px-4 active:opacity-70 disabled:opacity-50"
            onPress={onRefresh}
          >
            <Text className="text-sm font-sans-bold">{refreshing ? 'Refreshing…' : 'Refresh'}</Text>
          </Pressable>
        ) : null}
      </View>

      {pools.length === 0 ? (
        <View className="rounded-[22px] border border-border bg-card px-5 py-5">
          <Text className="font-sans-bold">No subscription limits available</Text>
          <Text className="mt-1 text-sm leading-normal text-foreground-muted">
            Sign in to a supported Codex or Claude subscription, then refresh providers.
          </Text>
        </View>
      ) : (
        pools.map((pool) => (
          <View
            key={pool.key}
            className="overflow-hidden rounded-[22px] border border-border bg-card"
          >
            <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
              <Text className="font-sans-bold capitalize">{String(pool.driver)}</Text>
              <Text className="text-xs text-foreground-muted">
                {pool.accounts.length} {pool.accounts.length === 1 ? 'account' : 'accounts'}
              </Text>
            </View>
            <View className="gap-5 px-5 py-4">
              <View className="flex-row flex-wrap gap-2">
                {pool.accounts.map((account) => (
                  <View key={account.key} className="gap-1 rounded-2xl bg-subtle px-3 py-2">
                    <Text className="text-xs font-sans-medium">{limitAccountLabel(account)}</Text>
                    {resetCreditsLabel(account, now) ? (
                      <Text className="text-xs text-foreground-muted">
                        {resetCreditsLabel(account, now)}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
              {pool.windows.map((window) =>
                {
                const reset = window.resets[0]
                  ? formatResetsIn(window.resets[0].member.window, now)
                  : null
                return (
                  <View key={`${window.kind}:${window.id}`} className="gap-2">
                    <View className="flex-row items-end justify-between gap-4">
                      <View className="flex-1">
                        <Text className="text-sm font-sans-medium">{window.label}</Text>
                        <Text className="text-xs text-foreground-muted">
                          {reset ?? 'Reset time unavailable'}
                        </Text>
                      </View>
                      <Text className="text-sm font-sans-bold tabular-nums">
                        {window.remainingPercent}% left
                      </Text>
                    </View>
                    <View
                      accessible
                      accessibilityRole="progressbar"
                      accessibilityLabel={`${window.label} quota remaining`}
                      accessibilityValue={{
                        min: 0,
                        max: 100,
                        now: window.remainingPercent,
                      }}
                      className="h-2 overflow-hidden rounded-full bg-subtle"
                    >
                      <View
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${window.remainingPercent}%` }}
                      />
                    </View>
                  </View>
                )
              })}
            </View>
          </View>
        ))
      )}

      {notices.length > 0 ? (
        <View accessibilityRole="alert" className="gap-1 rounded-[22px] bg-subtle px-5 py-4">
          {notices.map((notice) => (
            <Text key={notice} className="text-xs leading-normal text-foreground-muted">
              {notice}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  )
}
