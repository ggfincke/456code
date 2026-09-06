// packages/shared/src/usageLimits.ts
// pools native provider limits across connected environments
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAccountUsage,
  type ServerProviderAccountUsageWindow,
  type ServerProviderSlashCommand,
} from '@t3tools/contracts'

import { isProviderAvailable } from './serverSettings.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type AvailableAccountUsage = Extract<ServerProviderAccountUsage, { readonly status: 'available' }>
type LimitWindowKind = NonNullable<ServerProviderAccountUsageWindow['kind']>

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

function accountKey(provider: ServerProvider): string
{
  const email = provider.auth.email?.trim().toLowerCase()
  return email ? `${provider.driver}:${email}` : `${provider.instanceId}`
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
  const accounts = new Map<string, LimitAccount>()
  for (const [environmentId, presentation] of presentations)
  {
    const environmentLabel = presentation.entry.target.label
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? []))
    {
      if (provider.accountUsage?.status !== 'available') continue
      const key = accountKey(provider)
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
      const previous = accounts.get(key)
      if (!previous)
      {
        accounts.set(key, next)
        continue
      }

      const fresher = Date.parse(next.usage.observedAt) > Date.parse(previous.usage.observedAt)
      const winner = fresher ? next : previous
      const environments = [
        ...previous.environments,
        ...next.environments.filter(
          (candidate) =>
            !previous.environments.some(
              (seen) =>
                seen.environmentId === candidate.environmentId &&
                seen.instanceId === candidate.instanceId,
            ),
        ),
      ]
      accounts.set(key, {
        ...winner,
        displayName: previous.displayName ?? next.displayName,
        plan: previous.plan ?? next.plan,
        accentColor: previous.accentColor ?? next.accentColor,
        environments,
      })
    }
  }
  return [...accounts.values()]
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

export interface LimitPoolMember
{
  readonly account: LimitAccount
  readonly window: ServerProviderAccountUsageWindow
}

export interface LimitPoolWindow
{
  readonly id: string
  readonly kind: LimitWindowKind
  readonly label: string
  readonly members: readonly LimitPoolMember[]
  readonly columns: ReadonlyArray<{
    readonly account: LimitAccount
    readonly window: ServerProviderAccountUsageWindow | null
  }>
  readonly remainingPercent: number
  readonly usedPercent: number
  readonly pace: LimitPace | null
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember
    readonly at: number
    readonly restoresPercent: number
  }>
}

export interface LimitPool
{
  readonly driver: ServerProvider['driver']
  readonly accounts: readonly LimitAccount[]
  readonly windows: readonly LimitPoolWindow[]
}

const WINDOW_KIND_ORDER: Record<LimitWindowKind, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
}

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[]
{
  const byDriver = new Map<ServerProvider['driver'], LimitAccount[]>()
  for (const account of accounts)
  {
    const list = byDriver.get(account.driver)
    if (list) list.push(account)
    else byDriver.set(account.driver, [account])
  }
  return [...byDriver].map(([driver, members]) =>
  {
    const orderWindow = members
      .flatMap((account) => account.usage.windows)
      .sort(
        (left, right) => WINDOW_KIND_ORDER[windowKind(left)] - WINDOW_KIND_ORDER[windowKind(right)],
      )[0]
    const orderReset = (account: LimitAccount) =>
    {
      const window = account.usage.windows.find(
        (candidate) =>
          windowKind(candidate) === (orderWindow ? windowKind(orderWindow) : undefined) &&
          candidate.id === orderWindow?.id,
      )
      return (window ? resetMillis(window) : null) ?? Number.POSITIVE_INFINITY
    }
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    )
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) }
  })
}

function accountSortName(account: LimitAccount): string
{
  return (account.displayName ?? account.email ?? account.key).toLowerCase()
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[]
{
  const byKey = new Map<string, LimitPoolMember[]>()
  for (const account of accounts)
  {
    for (const window of account.usage.windows)
    {
      const key = `${windowKind(window)}:${window.id}`
      const list = byKey.get(key)
      if (list) list.push({ account, window })
      else byKey.set(key, [{ account, window }])
    }
  }

  const pools = [...byKey.values()].map((members): LimitPoolWindow =>
  {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]))
    const first = members[0]!.window
    const usedPercent =
      members.reduce((sum, member) => sum + member.window.usedPercent, 0) / members.length
    const timed = members.flatMap((member) =>
    {
      const elapsed = elapsedShare(member.window, now)
      return elapsed === null ? [] : [{ used: member.window.usedPercent, elapsed }]
    })
    const timedUsed = timed.reduce((sum, entry) => sum + entry.used, 0) / timed.length
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, entry) => sum + entry.elapsed, 0) / timed.length : null
    const resets = members
      .flatMap((member) =>
      {
        const at = resetMillis(member.window)
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.window.usedPercent / members.length),
              },
            ]
      })
      .sort((left, right) => left.at - right.at)
    return {
      id: first.id,
      kind: windowKind(first),
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    }
  })
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])
}

function windowKind(window: ServerProviderAccountUsageWindow): LimitWindowKind
{
  if (window.kind) return window.kind
  const duration = window.windowDurationMins
  if (duration !== undefined)
  {
    if (duration >= 30 * 24 * 60) return 'monthly'
    if (duration >= 7 * 24 * 60) return 'weekly'
    if (duration > 0) return 'session'
  }
  return 'other'
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

export function remainingPercent(window: ServerProviderAccountUsageWindow): number
{
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)))
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

export const USAGE_LIMITS_COMMAND = {
  name: 'usage-limits',
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand

export function isUsageLimitsCommand(prompt: string): boolean
{
  return prompt.trim().toLowerCase() === '/usage-limits'
}

export function hasProviderUsageLimits(
  driver: ServerProvider['driver'],
  providers: readonly ServerProvider[],
): boolean
{
  return providersWithLimits(providers).some((provider) => provider.driver === driver)
}

export function withUsageLimitsCommands(providers: readonly ServerProvider[]): ServerProvider[]
{
  return providers.map((provider) =>
  {
    if (!hasProviderUsageLimits(provider.driver, providers)) return provider
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ]
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    }
  })
}
