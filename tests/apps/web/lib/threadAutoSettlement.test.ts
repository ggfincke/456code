// tests/apps/web/lib/threadAutoSettlement.test.ts
// verifies automatic settlement ownership across server capability versions

import type { ServerConfig } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  resolveAutoSettlementPreferences,
  resolveClientAutoSettlementEvaluation,
} from '../../../../apps/web/src/lib/threadAutoSettlement'

function config(input: {
  readonly serverManaged: boolean
  readonly autoSettleAfterDays: number | null
  readonly autoSettleOnMerge: boolean
}): ServerConfig
{
  return {
    environment: {
      capabilities: {
        threadAutoSettlement: input.serverManaged,
      },
    },
    settings: {
      sidebarAutoSettleAfterDays: input.autoSettleAfterDays,
      sidebarAutoSettleOnMerge: input.autoSettleOnMerge,
    },
  } as ServerConfig
}

describe('thread auto-settlement settings', () =>
{
  it('shows server preferences but disables duplicate client evaluation when supported', () =>
  {
    const serverConfig = config({
      serverManaged: true,
      autoSettleAfterDays: 14,
      autoSettleOnMerge: true,
    })
    const legacy = { autoSettleAfterDays: null, autoSettleOnMerge: false }

    expect(resolveAutoSettlementPreferences(serverConfig, legacy)).toEqual({
      autoSettleAfterDays: 14,
      autoSettleOnMerge: true,
      serverManaged: true,
    })
    expect(resolveClientAutoSettlementEvaluation(serverConfig, legacy)).toEqual({
      autoSettleAfterDays: null,
      autoSettleOnMerge: false,
    })
  })

  it('preserves explicit legacy client opt-outs when the capability is absent', () =>
  {
    const legacy = { autoSettleAfterDays: null, autoSettleOnMerge: false }
    const legacyConfig = config({
      serverManaged: false,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
    })

    expect(resolveAutoSettlementPreferences(legacyConfig, legacy)).toEqual({
      ...legacy,
      serverManaged: false,
    })
    expect(resolveClientAutoSettlementEvaluation(legacyConfig, legacy)).toEqual({
      ...legacy,
      serverManaged: false,
    })
  })
})
