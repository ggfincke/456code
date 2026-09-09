// tests/apps/server/provider/providerUsageLimits.test.ts
// verifies account-bound sparse provider usage updates
import { describe, expect, it } from 'vite-plus/test'
import { ProviderDriverKind } from '@t3tools/contracts'

import {
  applyUsageLimitsUpdate,
  providerUsageAccountIdentity,
  resolveAccountUsageAfterProbe,
} from '../../../../apps/server/src/provider/providerUsageLimits.ts'

const initialUsage = {
  status: 'available',
  observedAt: '2026-09-09T12:00:00.000Z',
  windows: [
    {
      id: 'account:primary',
      label: '5h',
      kind: 'session',
      usedPercent: 20,
      resetsAt: '2026-09-09T17:00:00.000Z',
      windowDurationMins: 300,
    },
    {
      id: 'account:secondary',
      label: 'Week',
      kind: 'weekly',
      usedPercent: 40,
      resetsAt: '2026-09-16T12:00:00.000Z',
      windowDurationMins: 10_080,
    },
  ],
  resetCredits: { availableCount: 2 },
} as const

describe('provider usage limits', () =>
{
  it('merges a current sparse window without dropping scoped windows or reset credits', () =>
  {
    expect(
      applyUsageLimitsUpdate({
        previous: initialUsage,
        update: {
          accountIdentity: 'codex:chatgpt:user@example.com',
          observedAt: '2026-09-09T12:01:00.000Z',
          windows: [
            {
              id: 'account:primary',
              label: '5h',
              kind: 'session',
              usedPercent: 25,
              resetsAt: null,
              windowDurationMins: 300,
            },
          ],
        },
      }),
    ).toEqual({
      ...initialUsage,
      observedAt: '2026-09-09T12:01:00.000Z',
      windows: [{ ...initialUsage.windows[0], usedPercent: 25 }, initialUsage.windows[1]],
    })
  })

  it('rejects stale updates and never carries usage across account identities', () =>
  {
    expect(
      applyUsageLimitsUpdate({
        previous: initialUsage,
        update: {
          accountIdentity: 'codex:chatgpt:user@example.com',
          observedAt: '2026-09-09T11:59:00.000Z',
          windows: [{ ...initialUsage.windows[0], usedPercent: 90 }],
        },
      }),
    ).toBe(initialUsage)

    const failedProbe = {
      status: 'unavailable',
      observedAt: '2026-09-09T12:05:00.000Z',
      message: 'Could not refresh usage.',
    } as const
    expect(
      resolveAccountUsageAfterProbe({
        published: initialUsage,
        probed: failedProbe,
        sameAccount: true,
      }),
    ).toBe(initialUsage)
    expect(
      resolveAccountUsageAfterProbe({
        published: initialUsage,
        probed: failedProbe,
        sameAccount: false,
      }),
    ).toBe(failedProbe)
  })

  it('derives identity only from a known authenticated email', () =>
  {
    expect(
      providerUsageAccountIdentity({
        driver: ProviderDriverKind.make('codex'),
        auth: { status: 'authenticated', type: 'chatgpt', email: ' User@Example.com ' },
      }),
    ).toBe('codex:chatgpt:user@example.com')
    expect(
      providerUsageAccountIdentity({
        driver: ProviderDriverKind.make('codex'),
        auth: { status: 'authenticated', type: 'chatgpt' },
      }),
    ).toBeUndefined()
    expect(
      providerUsageAccountIdentity({
        driver: ProviderDriverKind.make('codex'),
        auth: { status: 'unauthenticated', email: 'user@example.com' },
      }),
    ).toBeUndefined()
  })
})
