// tests/apps/mobile/state/threads/use-thread-composer-state.test.ts
// verifies provider-capability normalization at mobile composer dispatch

import { ProviderInstanceId, type ProviderRuntimeCapabilities } from '@t3tools/contracts'
import { describe, expect, it, vi } from 'vite-plus/test'

// keep the pure dispatch resolver independent of Expo-backed hook collaborators.
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
}))
vi.mock('../../../../../apps/mobile/src/lib/uuid', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/entities', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/use-remote-environment-registry', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/use-thread-detail', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/use-thread-provider-switch', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/use-thread-selection', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/threads', () => ({}))
vi.mock('../../../../../apps/mobile/src/state/threads/use-thread-outbox', () => ({}))

import {
  modelSelectionChangeBlockedByCapabilities,
  resolveThreadComposerDispatchSettings,
} from '../../../../../apps/mobile/src/state/threads/use-thread-composer-state'

const CODEX_CAPABILITIES = {
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default', 'plan'],
  supportedRuntimeModes: ['approval-required', 'full-access'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: ['image'],
  activeTurnInput: 'supported',
  conversationRollback: 'exact',
  orchestrateInstructionDelivery: 'native',
  orchestrateBaseModes: ['default', 'plan'],
} as const satisfies ProviderRuntimeCapabilities

const CORAL_CAPABILITIES = {
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['approval-required'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: [],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'unsupported',
  orchestrateBaseModes: [],
} as const satisfies ProviderRuntimeCapabilities

const ANTIGRAVITY_CAPABILITIES = {
  defaultRuntimeMode: 'auto-accept-edits',
  sessionModelSwitch: 'unsupported',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['auto-accept-edits', 'full-access'],
  runtimeModeWarnings: [],
  supportedAttachmentTypes: [],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default'],
} as const satisfies ProviderRuntimeCapabilities

describe('mobile thread composer dispatch', () =>
{
  it('rejects same-instance model changes when the provider reports no session switch support', () =>
  {
    const selection = { instanceId: ProviderInstanceId.make('antigravity'), model: 'default' }

    expect(
      modelSelectionChangeBlockedByCapabilities({
        threadStarted: true,
        currentModelSelection: selection,
        nextModelSelection: { ...selection, model: 'another-model' },
        capabilities: ANTIGRAVITY_CAPABILITIES,
      }),
    ).toBe('This provider does not allow changing models after a thread has started.')
    expect(
      modelSelectionChangeBlockedByCapabilities({
        threadStarted: false,
        currentModelSelection: selection,
        nextModelSelection: { ...selection, model: 'another-model' },
        capabilities: ANTIGRAVITY_CAPABILITIES,
      }),
    ).toBeNull()
  })

  it('normalizes stale modes against the final Coral instance and conservative fallback', () =>
  {
    const codexInstanceId = ProviderInstanceId.make('codex')
    const coralInstanceId = ProviderInstanceId.make('coral')
    const input = {
      draft: {
        modelSelection: { instanceId: coralInstanceId, model: 'gemma4:31b-mlx' },
        runtimeMode: 'full-access' as const,
        interactionMode: 'plan' as const,
        orchestrate: true,
      },
      thread: {
        modelSelection: { instanceId: codexInstanceId, model: 'gpt-5.4' },
        runtimeMode: 'full-access' as const,
        interactionMode: 'plan' as const,
        orchestrate: true,
      },
    }

    expect(
      resolveThreadComposerDispatchSettings({
        ...input,
        serverConfig: {
          providers: [
            { instanceId: codexInstanceId, capabilities: CODEX_CAPABILITIES },
            { instanceId: coralInstanceId, capabilities: CORAL_CAPABILITIES },
          ],
        },
      }),
    ).toEqual({
      modelSelection: input.draft.modelSelection,
      runtimeMode: 'approval-required',
      collaborationMode: { baseMode: 'default', orchestrate: false },
    })

    expect(
      resolveThreadComposerDispatchSettings({
        ...input,
        serverConfig: {
          providers: [
            { instanceId: codexInstanceId, capabilities: CODEX_CAPABILITIES },
            { instanceId: coralInstanceId },
          ],
        },
      }),
    ).toEqual({
      modelSelection: input.draft.modelSelection,
      runtimeMode: 'approval-required',
      collaborationMode: { baseMode: 'default', orchestrate: false },
    })
  })

  it('falls back to Antigravity auto-accept-edits instead of carrying an unsupported draft mode', () =>
  {
    const antigravityInstanceId = ProviderInstanceId.make('antigravity')

    expect(
      resolveThreadComposerDispatchSettings({
        draft: {
          modelSelection: { instanceId: antigravityInstanceId, model: 'default' },
          runtimeMode: 'approval-required',
          interactionMode: 'default',
          orchestrate: false,
        },
        thread: {
          modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
          runtimeMode: 'full-access',
          interactionMode: 'default',
          orchestrate: false,
        },
        serverConfig: {
          providers: [
            { instanceId: antigravityInstanceId, capabilities: ANTIGRAVITY_CAPABILITIES },
          ],
        },
      }),
    ).toMatchObject({
      modelSelection: { instanceId: antigravityInstanceId, model: 'default' },
      runtimeMode: 'auto-accept-edits',
    })
  })
})
