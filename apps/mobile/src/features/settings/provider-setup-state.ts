// apps/mobile/src/features/settings/provider-setup-state.ts
// derive Antigravity setup settings and presentation

import {
  DEFAULT_SERVER_SETTINGS,
  type AntigravityOfficialRuntime,
  type OrchestrationSession,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from '@t3tools/contracts'

export function readAntigravityOfficialRuntime(config: unknown): AntigravityOfficialRuntime
{
  if (config !== null && typeof config === 'object' && 'officialRuntime' in config)
  {
    const runtime = config.officialRuntime
    if (
      runtime !== null &&
      typeof runtime === 'object' &&
      'mode' in runtime &&
      runtime.mode === 'custom' &&
      'executablePath' in runtime &&
      typeof runtime.executablePath === 'string' &&
      runtime.executablePath.trim().length > 0
    )
    {
      return { mode: 'custom', executablePath: runtime.executablePath.trim() }
    }
  }
  return { mode: 'managed' }
}

export function antigravityInstancePatch(
  settings: ServerSettings,
  provider: ServerProvider,
  input: {
    readonly enabled?: boolean
    readonly officialRuntime?: AntigravityOfficialRuntime
  },
): ServerSettingsPatch | null
{
  if (provider.driver !== 'antigravity') return null

  const { enabled: _legacyEnabled, ...legacyConfig } = settings.providers.antigravity
  const current = settings.providerInstances[provider.instanceId] ?? {
    driver: provider.driver,
    config: legacyConfig,
  }
  const currentConfig =
    current.config !== null && typeof current.config === 'object' && !Array.isArray(current.config)
      ? current.config
      : {}
  const config =
    input.officialRuntime === undefined
      ? currentConfig
      : { ...currentConfig, officialRuntime: input.officialRuntime }

  return {
    ...(provider.instanceId === 'antigravity'
      ? { providers: { antigravity: DEFAULT_SERVER_SETTINGS.providers.antigravity } }
      : {}),
    providerInstances: {
      ...settings.providerInstances,
      [provider.instanceId]: {
        ...current,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        config,
      },
    },
  }
}

export function providerNeedsSetup(provider: ServerProvider): boolean
{
  return provider.driver === 'antigravity'
}

export function resolveLegacyAntigravityTransition(
  session: OrchestrationSession | null | undefined,
): { readonly bindingGeneration: string } | null
{
  const incompatibility = session?.continuationIncompatibility
  return incompatibility ? { bindingGeneration: incompatibility.bindingGeneration } : null
}
