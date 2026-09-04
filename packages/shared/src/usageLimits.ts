// packages/shared/src/usageLimits.ts
// presents native provider limits from connected environments
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAccountUsage,
  type ServerProviderAccountUsageWindow,
} from '@t3tools/contracts'

import { isProviderAvailable } from './serverSettings.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type AvailableAccountUsage = Extract<ServerProviderAccountUsage, { readonly status: 'available' }>

export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[]
{
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.accountUsage !== undefined &&
      provider.accountUsage.status !== 'notApplicable',
  )
}

export interface LimitsPresentation
{
  readonly entry: { readonly target: { readonly label: string } }
  readonly serverConfig: {
    readonly providers?: readonly ServerProvider[] | undefined
  } | null
}

export interface LimitsGroup
{
  readonly environmentId: EnvironmentId
  readonly environmentLabel: string | null
  readonly providers: readonly ServerProvider[]
}

export function collectLimitsGroups(
  presentations: ReadonlyMap<EnvironmentId, LimitsPresentation>,
): readonly LimitsGroup[]
{
  const groups: LimitsGroup[] = []
  for (const [environmentId, presentation] of presentations)
  {
    const providers = providersWithLimits(presentation.serverConfig?.providers ?? [])
    if (providers.length === 0) continue
    groups.push({ environmentId, environmentLabel: presentation.entry.target.label, providers })
  }
  return groups.length > 1 ? groups : groups.map((group) => ({ ...group, environmentLabel: null }))
}

export interface LimitAccount
{
  readonly key: string
  readonly driver: ServerProvider['driver']
  readonly displayName: string | null
  readonly email: string | undefined
  readonly plan: string | undefined
  readonly accentColor: string | undefined
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId
    readonly label: string
    readonly instanceId: ProviderInstanceId
  }>
  readonly usage: AvailableAccountUsage
}

export function limitAccountLabel(account: LimitAccount): string
{
  return account.displayName ?? account.plan ?? String(account.driver)
}

export function collectLimitAccounts(
  presentations: ReadonlyMap<EnvironmentId, LimitsPresentation>,
): readonly LimitAccount[]
{
  const accounts: LimitAccount[] = []
  for (const [environmentId, presentation] of presentations)
  {
    const environmentLabel = presentation.entry.target.label
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? []))
    {
      if (provider.accountUsage?.status !== 'available') continue
      const key = `${environmentId}:${provider.instanceId}`
      const next: LimitAccount = {
        key,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label: environmentLabel, instanceId: provider.instanceId }],
        usage: provider.accountUsage,
      }
      accounts.push(next)
    }
  }
  return accounts
}

export function collectLimitNotices(
  presentations: ReadonlyMap<EnvironmentId, LimitsPresentation>,
): readonly string[]
{
  const notices: string[] = []
  for (const presentation of presentations.values())
  {
    const prefix = presentations.size > 1 ? `${presentation.entry.target.label} · ` : ''
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? []))
    {
      const notice = provider.accountUsage ? limitsNotice(provider.accountUsage) : null
      if (notice)
      {
        const name = provider.displayName?.trim() || String(provider.driver)
        notices.push(`${prefix}${name}: ${notice}`)
      }
    }
  }
  return notices
}

export function limitsNotice(usage: ServerProviderAccountUsage): string | null
{
  switch (usage.status)
  {
    case 'available':
      return usage.windows.length === 0 ? 'No limits reported.' : null
    case 'external':
      return 'Usage details are available in the provider dashboard.'
    case 'notApplicable':
      return null
    case 'unavailable':
      return usage.message
  }
}

function resetMillis(window: ServerProviderAccountUsageWindow): number | null
{
  if (window.resetsAt === null) return null
  const at = Date.parse(window.resetsAt)
  return Number.isFinite(at) ? at : null
}

export function elapsedShare(window: ServerProviderAccountUsageWindow, now: number): number | null
{
  const resetsAt = resetMillis(window)
  if (resetsAt === null || window.windowDurationMins === undefined) return null
  const length = window.windowDurationMins * MINUTE
  if (length <= 0) return null
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length))
}

export type LimitPace = 'ahead' | 'on' | 'under'

export function paceOf(window: ServerProviderAccountUsageWindow, now: number): LimitPace | null
{
  const elapsed = elapsedShare(window, now)
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed)
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace
{
  const gap = usedPercent - elapsed * 100
  if (gap > 5) return 'ahead'
  if (gap < -5) return 'under'
  return 'on'
}

export function formatDuration(ms: number): string
{
  const remaining = Math.max(0, ms)
  const days = Math.floor(remaining / DAY)
  const hours = Math.floor((remaining % DAY) / HOUR)
  const minutes = Math.floor((remaining % HOUR) / MINUTE)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatResetsIn(
  window: ServerProviderAccountUsageWindow,
  now: number,
): string | null
{
  const resetsAt = resetMillis(window)
  if (resetsAt === null) return null
  return resetsAt <= now ? 'resets now' : `resets in ${formatDuration(resetsAt - now)}`
}

