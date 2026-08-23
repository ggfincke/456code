// apps/server/src/provider/providerCapabilities.ts
// define provider runtime capability matrices and pure support checks

import {
  coerceRuntimeMode,
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
  normalizeCollaborationMode,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type ProviderRuntimeCapabilities,
  type RuntimeMode,
  type ServerProvider,
} from '@t3tools/contracts'

export interface ProviderTurnModeInput
{
  readonly interactionMode?: ProviderInteractionMode | undefined
  readonly orchestrate?: boolean | undefined
}

const ALL_RUNTIME_MODES = [
  'approval-required',
  'auto-accept-edits',
  'auto',
  'full-access',
] as const satisfies ReadonlyArray<RuntimeMode>

export const CODEX_PROVIDER_CAPABILITIES = {
  defaultRuntimeMode: 'full-access',
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default', 'plan'],
  supportedRuntimeModes: ALL_RUNTIME_MODES,
  activeTurnInput: 'supported',
  conversationRollback: 'exact',
  orchestrateInstructionDelivery: 'native',
  orchestrateBaseModes: ['default', 'plan'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: ['image'],
} as const satisfies ProviderRuntimeCapabilities

export const CLAUDE_PROVIDER_CAPABILITIES = {
  ...CODEX_PROVIDER_CAPABILITIES,
} as const satisfies ProviderRuntimeCapabilities

export const CURSOR_PROVIDER_CAPABILITIES = {
  defaultRuntimeMode: 'approval-required',
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default', 'plan'],
  supportedRuntimeModes: ['approval-required', 'full-access'],
  activeTurnInput: 'supported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default', 'plan'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: ['image'],
} as const satisfies ProviderRuntimeCapabilities

export const GROK_PROVIDER_CAPABILITIES = {
  defaultRuntimeMode: 'approval-required',
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['approval-required', 'full-access'],
  activeTurnInput: 'supported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: ['image'],
} as const satisfies ProviderRuntimeCapabilities

export const OPENCODE_PROVIDER_CAPABILITIES = {
  defaultRuntimeMode: 'approval-required',
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default', 'plan'],
  supportedRuntimeModes: ['approval-required', 'full-access'],
  activeTurnInput: 'supported',
  conversationRollback: 'exact',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default', 'plan'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: ['image'],
} as const satisfies ProviderRuntimeCapabilities

export const CORAL_PROVIDER_CAPABILITIES = {
  defaultRuntimeMode: 'approval-required',
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['approval-required'],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'unsupported',
  orchestrateBaseModes: [],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: ['image'],
} as const satisfies ProviderRuntimeCapabilities

export const GEMINI_PROVIDER_CAPABILITIES = {
  defaultRuntimeMode: 'approval-required',
  sessionModelSwitch: 'unsupported',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['approval-required'],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: ['image'],
} as const satisfies ProviderRuntimeCapabilities

export const ANTIGRAVITY_PROVIDER_CAPABILITIES = {
  defaultRuntimeMode: 'auto-accept-edits',
  sessionModelSwitch: 'unsupported',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['auto-accept-edits', 'full-access'],
  runtimeModeWarnings: [
    {
      id: 'antigravity-full-access-v1',
      mode: 'full-access',
      severity: 'danger',
      requiresAcknowledgement: true,
      message:
        'Antigravity will run with --dangerously-skip-permissions. ' +
        '456code cannot review or approve individual tool calls.',
    },
  ],
  supportedAttachmentTypes: [],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default'],
} as const satisfies ProviderRuntimeCapabilities

export const CONSERVATIVE_PROVIDER_CAPABILITIES =
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES satisfies ProviderRuntimeCapabilities

export function resolveProviderCapabilities(
  capabilities: ProviderRuntimeCapabilities | undefined,
): ProviderRuntimeCapabilities
{
  return capabilities ?? CONSERVATIVE_PROVIDER_CAPABILITIES
}

export function exposeProviderCapabilities(provider: ServerProvider): ServerProvider
{
  return provider.capabilities === undefined
    ? { ...provider, capabilities: CONSERVATIVE_PROVIDER_CAPABILITIES }
    : provider
}

export function providerCapabilitiesForDriver(
  driver: ProviderDriverKind,
): ProviderRuntimeCapabilities
{
  switch (driver)
  {
    case 'codex':
      return CODEX_PROVIDER_CAPABILITIES
    case 'claudeAgent':
      return CLAUDE_PROVIDER_CAPABILITIES
    case 'cursor':
      return CURSOR_PROVIDER_CAPABILITIES
    case 'grok':
      return GROK_PROVIDER_CAPABILITIES
    case 'opencode':
      return OPENCODE_PROVIDER_CAPABILITIES
    case 'coral':
      return CORAL_PROVIDER_CAPABILITIES
    case 'gemini':
      return GEMINI_PROVIDER_CAPABILITIES
    case 'antigravity':
      return ANTIGRAVITY_PROVIDER_CAPABILITIES
    default:
      return CONSERVATIVE_PROVIDER_CAPABILITIES
  }
}

export function supportsRuntimeMode(
  capabilities: ProviderRuntimeCapabilities,
  runtimeMode: RuntimeMode,
): boolean
{
  return capabilities.supportedRuntimeModes.includes(runtimeMode)
}

export function coerceSupportedRuntimeMode(
  capabilities: ProviderRuntimeCapabilities,
  runtimeMode: RuntimeMode,
): RuntimeMode
{
  return coerceRuntimeMode(runtimeMode, capabilities.supportedRuntimeModes)
}

export function supportsTurnMode(
  capabilities: ProviderRuntimeCapabilities,
  input: ProviderTurnModeInput,
): boolean
{
  const mode = normalizeCollaborationMode(input.interactionMode ?? 'default', input.orchestrate)
  if (!capabilities.supportedInteractionModes.includes(mode.baseMode)) return false
  return (
    !mode.orchestrate ||
    (capabilities.orchestrateInstructionDelivery !== 'unsupported' &&
      capabilities.orchestrateBaseModes.includes(mode.baseMode))
  )
}

export function providerBaseInteractionMode(input: ProviderTurnModeInput): ProviderInteractionMode
{
  return normalizeCollaborationMode(input.interactionMode ?? 'default', input.orchestrate).baseMode
}
