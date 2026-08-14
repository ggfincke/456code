// tests/packages/contracts/server.test.ts
// verifies provider snapshot defaults and account usage wire invariants
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import { ServerProvider } from '../../../packages/contracts/src/server.ts'

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider)

const baseProvider = {
  instanceId: 'codex',
  driver: 'codex',
  enabled: true,
  installed: true,
  version: '1.0.0',
  status: 'ready',
  auth: { status: 'authenticated' },
  checkedAt: '2026-04-10T00:00:00.000Z',
  models: [],
}

describe('ServerProvider', () =>
{
  it.each([
    {
      label: 'keeps capabilities absent on older cached snapshots',
      input: { ...baseProvider },
      assert: (parsed: ReturnType<typeof decodeServerProvider>) =>
      {
        expect(parsed.slashCommands).toEqual([])
        expect(parsed.skills).toEqual([])
        expect(parsed.capabilities).toBeUndefined()
        expect(parsed.versionAdvisory).toBeUndefined()
        expect(parsed.updateState).toBeUndefined()
      },
    },
    {
      label: 'defaults one-click update support on older advisory snapshots',
      input: {
        ...baseProvider,
        versionAdvisory: {
          status: 'behind_latest',
          currentVersion: '1.0.0',
          latestVersion: '1.0.1',
          updateCommand: 'npm install -g @openai/codex@latest',
          checkedAt: '2026-04-10T00:00:00.000Z',
          message: 'Update available.',
        },
      },
      assert: (parsed: ReturnType<typeof decodeServerProvider>) =>
      {
        expect(parsed.versionAdvisory?.canUpdate).toBe(false)
      },
    },
    {
      label: 'defaults capability fields missing from older cached snapshots',
      input: {
        ...baseProvider,
        capabilities: {
          sessionModelSwitch: 'in-session',
        },
      },
      assert: (parsed: ReturnType<typeof decodeServerProvider>) =>
      {
        expect(parsed.capabilities).toEqual({
          sessionModelSwitch: 'in-session',
          supportedInteractionModes: ['default'],
          supportedRuntimeModes: ['approval-required'],
          activeTurnInput: 'unsupported',
          conversationRollback: 'unsupported',
          orchestrateInstructionDelivery: 'unsupported',
          orchestrateBaseModes: [],
        })
      },
    },
    {
      label: 'decodes continuation group metadata',
      input: {
        ...baseProvider,
        instanceId: 'codex_personal',
        continuation: { groupKey: 'codex:home:/Users/julius/.codex' },
      },
      assert: (parsed: ReturnType<typeof decodeServerProvider>) =>
      {
        expect(parsed.continuation?.groupKey).toBe('codex:home:/Users/julius/.codex')
      },
    },
  ])('$label', ({ input, assert }) =>
  {
    assert(decodeServerProvider(input))
  })

  it('decodes available and external provider account usage states', () =>
  {
    expect(
      decodeServerProvider({
        ...baseProvider,
        accountUsage: {
          status: 'available',
          observedAt: '2026-04-10T00:00:00.000Z',
          windows: [
            {
              id: 'account:primary',
              label: '5h',
              usedPercent: 62,
              resetsAt: '2026-04-10T05:00:00.000Z',
            },
          ],
        },
      }).accountUsage?.status,
    ).toBe('available')
    expect(
      decodeServerProvider({
        ...baseProvider,
        accountUsage: { status: 'external', dashboardUrl: 'https://cursor.com/dashboard' },
      }).accountUsage?.status,
    ).toBe('external')
  })

  it('decodes local providers whose authentication is not applicable', () =>
  {
    expect(
      decodeServerProvider({
        ...baseProvider,
        auth: { status: 'not-applicable' },
      }).auth.status,
    ).toBe('not-applicable')
  })

  it('rejects empty or contradictory provider capability mode matrices', () =>
  {
    for (const capabilities of [
      { supportedInteractionModes: [] },
      { supportedInteractionModes: ['plan'] },
      { supportedInteractionModes: ['default', 'orchestrate'] },
      { supportedRuntimeModes: [] },
    ])
    {
      expect(() => decodeServerProvider({ ...baseProvider, capabilities })).toThrow()
    }
  })

  it('rejects empty available usage windows and out-of-range percentages', () =>
  {
    expect(() =>
      decodeServerProvider({
        ...baseProvider,
        accountUsage: {
          status: 'available',
          observedAt: '2026-04-10T00:00:00.000Z',
          windows: [],
        },
      }),
    ).toThrow()
    expect(() =>
      decodeServerProvider({
        ...baseProvider,
        accountUsage: {
          status: 'available',
          observedAt: '2026-04-10T00:00:00.000Z',
          windows: [
            {
              id: 'account:primary',
              label: '5h',
              usedPercent: 101,
              resetsAt: null,
            },
          ],
        },
      }),
    ).toThrow()
  })
})
