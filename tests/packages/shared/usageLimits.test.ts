// tests/packages/shared/usageLimits.test.ts
// verifies account pooling and email-safe provider usage labels
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  limitAccountLabel,
  type LimitsPresentation,
  toggleUsageEnvironment,
} from '../../../packages/shared/src/usageLimits.ts'

const driver = ProviderDriverKind.make('codex')

function provider(input: {
  readonly instanceId: string
  readonly displayName?: string
  readonly observedAt: string
  readonly usedPercent: number
}): ServerProvider
{
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: true,
    installed: true,
    version: '1.0.0',
    status: 'ready',
    auth: {
      status: 'authenticated',
      type: 'chatgpt',
      label: 'Plus',
      email: 'Person@Example.com',
    },
    checkedAt: input.observedAt,
    models: [],
    slashCommands: [],
    skills: [],
    accountUsage: {
      status: 'available',
      observedAt: input.observedAt,
      windows: [
        {
          id: 'account:primary',
          label: '5h',
          kind: 'session',
          usedPercent: input.usedPercent,
          resetsAt: '2026-09-09T17:00:00.000Z',
          windowDurationMins: 300,
        },
      ],
    },
  }
}

describe('usage limits', () =>
{
  it('keeps explicit none distinct from following all environments as the catalog changes', () =>
  {
    const local = EnvironmentId.make('local')
    const remote = EnvironmentId.make('remote')
    const environments = [{ environmentId: local }, { environmentId: remote }]
    const selected = toggleUsageEnvironment(null, environments, local)
    expect(selected).toEqual([remote])
    expect(toggleUsageEnvironment(selected, environments, remote)).toEqual([])
    expect(toggleUsageEnvironment(selected, environments, local)).toBeNull()
    expect(toggleUsageEnvironment([remote], [{ environmentId: local }], local)).toEqual([
      remote,
      local,
    ])
  })

  it('pools one account across environments and keeps its email out of the display label', () =>
  {
    const presentations = new Map<EnvironmentId, LimitsPresentation>([
      [
        EnvironmentId.make('local'),
        {
          entry: { target: { label: 'Local' } },
          serverConfig: {
            providers: [
              provider({
                instanceId: 'codex-local',
                displayName: 'Personal Codex',
                observedAt: '2026-09-09T12:00:00.000Z',
                usedPercent: 20,
              }),
            ],
          },
        },
      ],
      [
        EnvironmentId.make('remote'),
        {
          entry: { target: { label: 'Remote' } },
          serverConfig: {
            providers: [
              provider({
                instanceId: 'codex-remote',
                observedAt: '2026-09-09T12:01:00.000Z',
                usedPercent: 25,
              }),
            ],
          },
        },
      ],
    ])

    const accounts = collectLimitAccounts(presentations)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.environments).toHaveLength(2)
    expect(accounts[0]?.usage.windows[0]?.usedPercent).toBe(25)
    expect(accounts[0] && limitAccountLabel(accounts[0])).toBe('Personal Codex')
    expect(accounts[0] && limitAccountLabel(accounts[0])).not.toContain('Person@Example.com')
    expect(collectLimitPools(accounts, Date.parse('2026-09-09T12:00:00.000Z'))).toHaveLength(1)
    const emailNamedProvider = provider({
      instanceId: 'private',
      displayName: 'Personal person@example.com',
      observedAt: '2026-09-09T12:00:00.000Z',
      usedPercent: 20,
    })
    expect(
      collectLimitNotices(
        new Map([
          [
            EnvironmentId.make('local'),
            {
              entry: { target: { label: 'Local' } },
              serverConfig: {
                providers: [
                  {
                    ...emailNamedProvider,
                    accountUsage: {
                      status: 'unavailable',
                      message: 'Please sign in.',
                      observedAt: '2026-09-09T12:00:00.000Z',
                    },
                  },
                ],
              },
            },
          ],
        ]),
      ),
    ).toEqual(['codex: Please sign in.'])
  })
})
