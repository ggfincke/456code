// apps/web/src/lib/threadAutoSettlement.ts
// resolves server-owned and legacy client-owned automatic settlement settings

import type { ServerConfig } from '@t3tools/contracts'

export interface AutoSettlementPreferences
{
  readonly autoSettleAfterDays: number | null
  readonly autoSettleOnMerge: boolean
}

export interface AutoSettlementResolution extends AutoSettlementPreferences
{
  readonly serverManaged: boolean
}

export function resolveAutoSettlementPreferences(
  config: ServerConfig | null | undefined,
  legacyPreferences: AutoSettlementPreferences,
): AutoSettlementResolution
{
  if (config?.environment.capabilities.threadAutoSettlement === true)
  {
    return {
      autoSettleAfterDays: config.settings.sidebarAutoSettleAfterDays,
      autoSettleOnMerge: config.settings.sidebarAutoSettleOnMerge,
      serverManaged: true,
    }
  }
  return { ...legacyPreferences, serverManaged: false }
}

export function resolveClientAutoSettlementEvaluation(
  config: ServerConfig | null | undefined,
  legacyPreferences: AutoSettlementPreferences,
): AutoSettlementPreferences
{
  const preferences = resolveAutoSettlementPreferences(config, legacyPreferences)
  return preferences.serverManaged
    ? { autoSettleAfterDays: null, autoSettleOnMerge: false }
    : preferences
}
