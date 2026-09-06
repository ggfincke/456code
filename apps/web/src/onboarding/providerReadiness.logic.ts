// apps/web/src/onboarding/providerReadiness.logic.ts
// resolves truthful provider setup state and terminal commands

import {
  ClaudeSettings,
  CodexSettings,
  type ExecutionEnvironmentPlatformOs,
  type ServerProvider,
  type ServerSettings,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings)
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings)
const safeShellBinaryPattern = /^[A-Za-z0-9_./:\\-]+$/

export type OnboardingProviderState =
  'checking' | 'disabled' | 'install' | 'signIn' | 'ready' | 'attention'

export function getOnboardingProviderState(
  provider: ServerProvider | undefined,
): OnboardingProviderState
{
  if (provider === undefined) return 'checking'
  if (!provider.enabled || provider.status === 'disabled') return 'disabled'
  if (!provider.installed) return 'install'
  if (provider.auth.status === 'unauthenticated') return 'signIn'
  if (provider.status === 'ready') return 'ready'
  return 'attention'
}

export function resolveOnboardingProviderInstallCommand(
  driver: 'claudeAgent' | 'codex',
  platform: ExecutionEnvironmentPlatformOs,
): string
{
  if (driver === 'claudeAgent')
  {
    return platform === 'windows'
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash'
  }
  return platform === 'windows'
    ? 'irm https://chatgpt.com/codex/install.ps1 | iex'
    : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
}

function quoteProviderBinary(
  binaryPath: string,
  fallback: string,
  platform: ExecutionEnvironmentPlatformOs,
): string
{
  if (
    safeShellBinaryPattern.test(binaryPath) &&
    (platform === 'windows' || !binaryPath.includes('\\'))
  )
  {
    return binaryPath
  }
  if (platform === 'windows') return `& '${binaryPath.replaceAll("'", "''")}'`
  if (platform === 'darwin' || platform === 'linux')
  {
    if (binaryPath.startsWith('~/') || binaryPath.startsWith('~\\'))
    {
      return `~/'${binaryPath.slice(2).replaceAll("'", `'"'"'`)}'`
    }
    return `'${binaryPath.replaceAll("'", `'"'"'`)}'`
  }
  return fallback
}

export function resolveOnboardingProviderLoginCommand(
  provider: ServerProvider,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
): string
{
  const instance = settings.providerInstances[provider.instanceId]
  if (provider.driver === 'claudeAgent')
  {
    const config = decodeClaudeSettings(
      instance ? (instance.config ?? {}) : settings.providers.claudeAgent,
    )
    const binary = Option.isSome(config) ? config.value.binaryPath : 'claude'
    return `${quoteProviderBinary(binary, 'claude', platform)} auth login`
  }
  if (provider.driver === 'codex')
  {
    const config = decodeCodexSettings(
      instance ? (instance.config ?? {}) : settings.providers.codex,
    )
    const binary = Option.isSome(config) ? config.value.binaryPath : 'codex'
    return `${quoteProviderBinary(binary, 'codex', platform)} login`
  }
  return provider.driver
}
