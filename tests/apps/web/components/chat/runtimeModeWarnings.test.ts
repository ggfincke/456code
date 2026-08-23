// tests/apps/web/components/chat/runtimeModeWarnings.test.ts
// verify runtime warnings require exact fresh-session confirmation

import { ProviderInstanceId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { resolveRuntimeModeStartWarnings } from '../../../../../apps/web/src/components/chat/runtimeModeWarnings.ts'

const antigravityCapabilities = {
  sessionModelSwitch: 'unsupported',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['auto-accept-edits', 'full-access'],
  defaultRuntimeMode: 'auto-accept-edits',
  runtimeModeWarnings: [
    {
      id: 'antigravity-full-access-v1',
      mode: 'full-access',
      severity: 'danger',
      requiresAcknowledgement: true,
      message: 'Full access bypasses individual review.',
    },
  ],
  supportedAttachmentTypes: [],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default'],
} as const

const selection = {
  instanceId: ProviderInstanceId.make('antigravity'),
  model: 'default',
} as const

describe('resolveRuntimeModeStartWarnings', () =>
{
  it('requires the exact warning id for a fresh full-access session', () =>
  {
    const missing = resolveRuntimeModeStartWarnings({
      capabilities: antigravityCapabilities,
      confirmedIds: ['stale-warning-v0'],
      currentModelSelection: selection,
      session: null,
      targetModelSelection: selection,
      runtimeMode: 'full-access',
    })
    expect(missing.missingWarning?.id).toBe('antigravity-full-access-v1')
    expect(missing.acknowledgements).toEqual([])

    const confirmed = resolveRuntimeModeStartWarnings({
      capabilities: antigravityCapabilities,
      confirmedIds: ['antigravity-full-access-v1', 'unrelated-warning'],
      currentModelSelection: selection,
      session: null,
      targetModelSelection: selection,
      runtimeMode: 'full-access',
    })
    expect(confirmed).toEqual({
      acknowledgements: ['antigravity-full-access-v1'],
      missingWarning: null,
    })
  })

  it('does not reconfirm an already active matching session', () =>
  {
    expect(
      resolveRuntimeModeStartWarnings({
        capabilities: antigravityCapabilities,
        confirmedIds: [],
        currentModelSelection: selection,
        session: {
          providerInstanceId: selection.instanceId,
          runtimeMode: 'full-access',
          status: 'ready',
        },
        targetModelSelection: selection,
        runtimeMode: 'full-access',
      }),
    ).toEqual({ acknowledgements: [], missingWarning: null })
  })
})
