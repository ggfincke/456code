// apps/server/src/provider/providerUsageLimits.ts
// merges sparse limit updates into provider account usage
import type {
  ProviderUsageLimitsUpdate,
  ServerProvider,
  ServerProviderAccountUsage,
  ServerProviderAccountUsageWindow,
} from '@t3tools/contracts'

const WINDOW_KIND_ORDER: Record<NonNullable<ServerProviderAccountUsageWindow['kind']>, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
}

export function clampPercent(value: number): number
{
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
}

export function providerUsageAccountIdentity(
  provider: Pick<ServerProvider, 'auth' | 'driver'>,
): string | undefined
{
  if (provider.auth.status !== 'authenticated') return undefined
  const email = provider.auth.email?.trim().toLowerCase()
  return email ? `${provider.driver}:${provider.auth.type ?? ''}:${email}` : undefined
}

function windowOrder(window: ServerProviderAccountUsageWindow): number
{
  return window.kind ? WINDOW_KIND_ORDER[window.kind] : WINDOW_KIND_ORDER.other
}

function sortWindows(
  windows: Iterable<ServerProviderAccountUsageWindow>,
): ReadonlyArray<ServerProviderAccountUsageWindow>
{
  return [...windows].toSorted(
    (left, right) => windowOrder(left) - windowOrder(right) || left.id.localeCompare(right.id),
  )
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderAccountUsage | undefined
  readonly update: ProviderUsageLimitsUpdate
}): ServerProviderAccountUsage | undefined
{
  const { previous, update } = input
  if (update.windows.length === 0 || previous?.status === 'notApplicable') return previous
  if (
    previous?.status !== 'external' &&
    previous?.observedAt !== undefined &&
    Date.parse(update.observedAt) < Date.parse(previous.observedAt)
  )
  {
    return previous
  }

  const priorWindows = previous?.status === 'available' ? previous.windows : []
  const merged = new Map(priorWindows.map((window) => [window.id, window] as const))
  let changed = previous?.status !== 'available'
  for (const window of update.windows)
  {
    const existing = merged.get(window.id)
    const next: ServerProviderAccountUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === null && existing?.resetsAt ? { resetsAt: existing.resetsAt } : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
      ...(window.kind === undefined && existing?.kind !== undefined ? { kind: existing.kind } : {}),
    }
    if (existing === undefined || !usageWindowEquals(existing, next))
    {
      merged.set(window.id, next)
      changed = true
    }
  }
  if (!changed && previous?.status === 'available') return previous

  return {
    status: 'available',
    observedAt: update.observedAt,
    windows: sortWindows(merged.values()),
    ...(previous?.status === 'available' && previous.resetCredits !== undefined
      ? { resetCredits: previous.resetCredits }
      : {}),
  }
}

function usageWindowEquals(
  left: ServerProviderAccountUsageWindow,
  right: ServerProviderAccountUsageWindow,
): boolean
{
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.scopeLabel === right.scopeLabel &&
    left.kind === right.kind &&
    left.usedPercent === right.usedPercent &&
    left.resetsAt === right.resetsAt &&
    left.windowDurationMins === right.windowDurationMins
  )
}

export function resolveAccountUsageAfterProbe(input: {
  readonly published: ServerProviderAccountUsage | undefined
  readonly probed: ServerProviderAccountUsage | undefined
  readonly sameAccount: boolean
}): ServerProviderAccountUsage | undefined
{
  const { published, probed, sameAccount } = input
  if (!sameAccount) return probed
  if (probed?.status === 'unavailable' && published?.status === 'available') return published
  if (
    probed?.status === 'available' &&
    published?.status === 'available' &&
    probed.resetCredits === undefined &&
    published.resetCredits !== undefined
  )
  {
    return { ...probed, resetCredits: published.resetCredits }
  }
  return probed
}
