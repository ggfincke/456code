// apps/server/src/provider/Layers/claudeUsageLimits.ts
// maps Claude runtime limit updates onto account usage windows
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderAccountUsageWindow,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'

import { clampPercent } from '../providerUsageLimits.ts'

const SESSION_MINS = 5 * 60
const WEEK_MINS = 7 * 24 * 60

const WINDOWS: Readonly<
  Record<
    string,
    Pick<ServerProviderAccountUsageWindow, 'id' | 'kind' | 'label' | 'windowDurationMins'>
  >
> = {
  five_hour: {
    id: 'five-hour',
    kind: 'session',
    label: '5h',
    windowDurationMins: SESSION_MINS,
  },
  seven_day: {
    id: 'seven-day',
    kind: 'weekly',
    label: 'Week',
    windowDurationMins: WEEK_MINS,
  },
  seven_day_opus: {
    id: 'seven-day-opus',
    kind: 'weekly',
    label: 'Week',
    windowDurationMins: WEEK_MINS,
  },
  seven_day_sonnet: {
    id: 'seven-day-sonnet',
    kind: 'weekly',
    label: 'Week',
    windowDurationMins: WEEK_MINS,
  },
}

const OVERAGE_INCLUDED_EVENT_TYPE = 'seven_day_overage_included'

export interface ClaudeScopedLimitNames
{
  readonly overageIncluded: string | undefined
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
})

function isoFromEpochSeconds(value: number | undefined): string | null
{
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null
  const dateTime = DateTime.make(value * 1_000)
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : null
}

function modelWindowId(displayName: string): string
{
  return `seven-day-model:${displayName.trim().toLowerCase()}`
}

export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
  observedAt: string,
  accountIdentity?: string,
): ProviderUsageLimitsUpdate | undefined
{
  if (!accountIdentity) return undefined
  const type: string | undefined = info.rateLimitType
  if (!type || typeof info.utilization !== 'number') return undefined

  const common = {
    usedPercent: clampPercent(info.utilization * 100),
    resetsAt: isoFromEpochSeconds(info.resetsAt),
  }
  const window = WINDOWS[type]
  if (window)
  {
    const scopeLabel =
      type === 'seven_day_opus' ? 'Opus' : type === 'seven_day_sonnet' ? 'Sonnet' : undefined
    return {
      observedAt,
      accountIdentity,
      windows: [{ ...window, ...common, ...(scopeLabel ? { scopeLabel } : {}) }],
    }
  }
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded)
  {
    return {
      observedAt,
      accountIdentity,
      windows: [
        {
          id: modelWindowId(names.overageIncluded),
          kind: 'weekly',
          label: 'Week',
          scopeLabel: names.overageIncluded,
          windowDurationMins: WEEK_MINS,
          ...common,
        },
      ],
    }
  }
  return undefined
}

export function recordClaudeScopedLimitNames(
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  rateLimits: object | undefined,
): Effect.Effect<void>
{
  const raw =
    rateLimits && 'model_scoped' in rateLimits
      ? (rateLimits as { readonly model_scoped?: unknown }).model_scoped
      : undefined
  const overageIncluded = Array.isArray(raw)
    ? raw.find(
        (entry): entry is { readonly display_name: string; readonly utilization: number } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { readonly display_name?: unknown }).display_name === 'string' &&
          typeof (entry as { readonly utilization?: unknown }).utilization === 'number',
      )?.display_name
    : undefined
  return Ref.set(namesRef, { overageIncluded })
}
