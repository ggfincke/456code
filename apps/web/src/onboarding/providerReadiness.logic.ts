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

