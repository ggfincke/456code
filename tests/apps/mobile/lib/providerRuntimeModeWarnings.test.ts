// tests/apps/mobile/lib/providerRuntimeModeWarnings.test.ts
// verify mobile runtime warning confirmation and acknowledgement boundaries

import { describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
}))

vi.mock('react-native', () => ({
  Alert: { alert: mocks.alert },
}))

import {
  confirmProviderRuntimeModeWarnings,
  requiredProviderRuntimeModeWarnings,
} from '../../../../apps/mobile/src/lib/providerRuntimeModeWarnings'

const capabilities = {
  defaultRuntimeMode: 'auto-accept-edits',
  sessionModelSwitch: 'unsupported',
  supportedInteractionModes: ['default'],
  supportedRuntimeModes: ['auto-accept-edits', 'full-access'],
  runtimeModeWarnings: [
    {
      id: 'antigravity-full-access-v1',
      mode: 'full-access',
      severity: 'danger',
      message: 'Full access bypasses individual review.',
      requiresAcknowledgement: true,
    },
  ],
  supportedAttachmentTypes: [],
  activeTurnInput: 'unsupported',
  conversationRollback: 'unsupported',
  orchestrateInstructionDelivery: 'prompt-prefix',
  orchestrateBaseModes: ['default'],
} as const

describe('mobile provider runtime mode warnings', () =>
{
  it('emits the exact Antigravity acknowledgement only after confirmation', async () =>
  {
    mocks.alert.mockImplementationOnce((_title, _message, buttons) =>
    {
      buttons[0]?.onPress?.()
    })

    await expect(
      confirmProviderRuntimeModeWarnings(capabilities, 'full-access'),
    ).resolves.toBeNull()
    expect(mocks.alert).toHaveBeenCalledTimes(1)

    mocks.alert.mockReset()
    mocks.alert.mockImplementationOnce((_title, _message, buttons) =>
    {
      buttons[1]?.onPress?.()
    })

    await expect(confirmProviderRuntimeModeWarnings(capabilities, 'full-access')).resolves.toEqual([
      'antigravity-full-access-v1',
    ])
  })

  it('emits no acknowledgement and shows no warning for the safe default mode', async () =>
  {
    mocks.alert.mockReset()

    expect(requiredProviderRuntimeModeWarnings(capabilities, 'auto-accept-edits')).toEqual([])
    await expect(
      confirmProviderRuntimeModeWarnings(capabilities, 'auto-accept-edits'),
    ).resolves.toEqual([])
    expect(mocks.alert).not.toHaveBeenCalled()
  })
})
