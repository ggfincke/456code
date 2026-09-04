// apps/server/src/provider/Layers/codexUsageLimits.ts
// maps Codex subscription usage probes and runtime updates
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderAccountUsageWindow,
  ServerProviderResetCredits,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Option from 'effect/Option'
import type * as CodexErrors from 'effect-codex-app-server/errors'

import { clampPercent } from '../providerUsageLimits.ts'

interface CodexRateLimitWindow
{
  readonly usedPercent: number
  readonly resetsAt?: number | null
  readonly windowDurationMins?: number | null
}

export interface CodexRateLimitSnapshot
{
  readonly limitId?: string | null
  readonly planType?: string | null
  readonly rateLimitReachedType?: string | null
  readonly primary?: CodexRateLimitWindow | null
  readonly secondary?: CodexRateLimitWindow | null
}

export interface CodexResetCreditsSummary
{
  readonly availableCount: number
  readonly credits?: ReadonlyArray<{
    readonly status: string
    readonly expiresAt?: number | null
  }> | null
}

const SESSION_MINS = 5 * 60
const WEEK_MINS = 7 * 24 * 60
const MONTH_MINS = 30 * 24 * 60

function isoFromEpochSeconds(value: number | null | undefined): string | undefined
{
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const dateTime = DateTime.make(value * 1_000)
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : undefined
}

function kindForDuration(minutes: number): ServerProviderAccountUsageWindow['kind']
{
  if (minutes >= MONTH_MINS) return 'monthly'
  if (minutes >= WEEK_MINS) return 'weekly'
  return 'session'
}

function labelForWindow(kind: ServerProviderAccountUsageWindow['kind'], minutes: number): string
{
  if (minutes === SESSION_MINS) return '5h'
  if (minutes === WEEK_MINS) return 'Week'
  if (minutes === MONTH_MINS) return 'Month'
  return kind === 'session' ? 'Session' : kind === 'weekly' ? 'Weekly' : 'Monthly'
}

function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<ServerProviderAccountUsageWindow>
{
  const isMonthlyPlan = snapshot.planType === 'free' || snapshot.planType === 'go'
  const positions = [
    ['primary', snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ['secondary', snapshot.secondary, WEEK_MINS],
  ] as const
  const windows: ServerProviderAccountUsageWindow[] = []
  for (const [id, window, fallbackMinutes] of positions)
  {
    if (!window || !Number.isFinite(window.usedPercent)) continue
    const windowDurationMins =
      typeof window.windowDurationMins === 'number' ? window.windowDurationMins : fallbackMinutes
    const kind = kindForDuration(windowDurationMins)
    const resetsAt = isoFromEpochSeconds(window.resetsAt)
    windows.push({
      id: `account:${id}`,
      kind,
      label: labelForWindow(kind, windowDurationMins),
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      resetsAt: resetsAt ?? null,
    })
  }
  return windows
}

export function codexResetCreditsToContract(
  summary: CodexResetCreditsSummary | null | undefined,
): ServerProviderResetCredits | undefined
{
  if (!summary) return undefined
  const expiries = (summary.credits ?? [])
    .filter((credit) => credit.status === 'available')
    .map((credit) => credit.expiresAt)
    .filter((value): value is number => typeof value === 'number')
  const nextExpiresAt = expiries.length > 0 ? isoFromEpochSeconds(Math.min(...expiries)) : undefined
  return {
    availableCount: Math.max(0, summary.availableCount),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  }
}

export function codexRateLimitsToUpdate(
  snapshot: CodexRateLimitSnapshot,
  observedAt: string,
  accountIdentity?: string,
): ProviderUsageLimitsUpdate | undefined
{
  if (!accountIdentity) return undefined
  const windows = codexRateLimitsToWindows(snapshot)
  return windows.length > 0 ? { accountIdentity, observedAt, windows } : undefined
}

export function codexRateLimitsFailureMessage(error: CodexErrors.CodexAppServerError): string
{
  switch (error._tag)
  {
    case 'CodexAppServerRequestError':
      return `Codex could not read usage (JSON-RPC ${error.code}).`
    case 'CodexAppServerSpawnError':
      return 'Codex could not be started to read usage.'
    case 'CodexAppServerProcessExitedError':
      return 'Codex exited before it could report usage.'
    default:
      return 'Codex did not answer the usage request.'
  }
}

