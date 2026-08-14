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

import { resolveThreadComposerDispatchSettings } from '../../../../../apps/mobile/src/state/threads/use-thread-composer-state'

const CODEX_CAPABILITIES = {
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default', 'plan'],
  supportedRuntimeModes: ['approval-required', 'full-access'],
  activeTurnInput: 'supported',
  conversationRollback: 'exact',
  orchestrateInstructionDelivery: 'native',
  orchestrateBaseModes: ['default', 'plan'],
} as const satisfies ProviderRuntimeCapabilities

const CORAL_CAPABILITIES = {
  sessionModelSwitch: 'in-session',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['approval-required'],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'unsupported',
  orchestrateBaseModes: [],
} as const satisfies ProviderRuntimeCapabilities

describe('mobile thread composer dispatch', () =>
{
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
})
