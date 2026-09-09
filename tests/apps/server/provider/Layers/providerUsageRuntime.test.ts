// tests/apps/server/provider/Layers/providerUsageRuntime.test.ts
// verifies native provider runtime usage and reset-credit normalization
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vite-plus/test'

import { claudeRateLimitEventToUpdate } from '../../../../../apps/server/src/provider/Layers/claudeUsageLimits.ts'
import {
  codexRateLimitsToUpdate,
  codexResetCreditsToContract,
  codexUsageLimitMessage,
} from '../../../../../apps/server/src/provider/Layers/codexUsageLimits.ts'

describe('provider usage runtime normalization', () =>
{
  it('maps Codex updates to the probed account window ids and reports the exact reset', () =>
  {
    const observedAt = '2026-09-09T12:00:00.000Z'
    const resetsAt = (Date.parse(observedAt) + 90 * 60_000) / 1_000
    const snapshot = {
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
    } as const

    expect(codexRateLimitsToUpdate(snapshot, observedAt, 'codex:chatgpt:user@example.com')).toEqual(
      {
        accountIdentity: 'codex:chatgpt:user@example.com',
        observedAt,
        windows: [
          {
            id: 'account:primary',
            kind: 'session',
            label: '5h',
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: '2026-09-09T13:30:00.000Z',
          },
        ],
      },
    )
    expect(codexUsageLimitMessage(snapshot, observedAt)).toBe(
      'Codex usage limit reached. The session limit resets in 1h 30m. Send the message again once the limit resets.',
    )
  })

  it('keeps reset credits read-only and reports the next available expiry', () =>
  {
    expect(
      codexResetCreditsToContract({
        availableCount: 2,
        credits: [
          { status: 'used', expiresAt: 1_800_000_000 },
          { status: 'available', expiresAt: 1_800_500_000 },
          { status: 'available', expiresAt: 1_800_100_000 },
        ],
      }),
    ).toEqual({
      availableCount: 2,
      nextExpiresAt: '2027-01-16T11:46:40.000Z',
    })
  })

  it('requires a current account identity before publishing Claude usage', () =>
  {
    const info = {
      status: 'allowed_warning',
      rateLimitType: 'seven_day_sonnet',
      utilization: 0.75,
      resetsAt: 1_800_000_000,
    } as SDKRateLimitInfo
    expect(
      claudeRateLimitEventToUpdate(
        info,
        { overageIncluded: undefined },
        '2026-09-09T12:00:00.000Z',
      ),
    ).toBeUndefined()
    expect(
      claudeRateLimitEventToUpdate(
        info,
        { overageIncluded: undefined },
        '2026-09-09T12:00:00.000Z',
        'claudeAgent:oauth:user@example.com',
      ),
    ).toEqual({
      accountIdentity: 'claudeAgent:oauth:user@example.com',
      observedAt: '2026-09-09T12:00:00.000Z',
      windows: [
        {
          id: 'seven-day-sonnet',
          kind: 'weekly',
          label: 'Week',
          scopeLabel: 'Sonnet',
          usedPercent: 75,
          resetsAt: '2027-01-15T08:00:00.000Z',
          windowDurationMins: 10_080,
        },
      ],
    })
  })
})
