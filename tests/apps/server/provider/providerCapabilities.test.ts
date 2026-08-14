// tests/apps/server/provider/providerCapabilities.test.ts
// verifies authoritative provider runtime capability matrices

import { ProviderDriverKind } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  CORAL_PROVIDER_CAPABILITIES,
  CONSERVATIVE_PROVIDER_CAPABILITIES,
  coerceSupportedRuntimeMode,
  providerCapabilitiesForDriver,
  resolveProviderCapabilities,
  supportsRuntimeMode,
  supportsTurnMode,
} from '../../../../apps/server/src/provider/providerCapabilities.ts'

describe('providerCapabilities', () =>
{
  it.each([
    {
      driver: 'codex',
      expected: {
        sessionModelSwitch: 'in-session',
        supportedInteractionModes: ['default', 'plan'],
        supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
        activeTurnInput: 'supported',
        conversationRollback: 'exact',
        orchestrateInstructionDelivery: 'native',
        orchestrateBaseModes: ['default', 'plan'],
      },
    },
    {
      driver: 'claudeAgent',
      expected: {
        sessionModelSwitch: 'in-session',
        supportedInteractionModes: ['default', 'plan'],
        supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
        activeTurnInput: 'supported',
        conversationRollback: 'exact',
        orchestrateInstructionDelivery: 'native',
        orchestrateBaseModes: ['default', 'plan'],
      },
    },
    {
      driver: 'cursor',
      expected: {
        sessionModelSwitch: 'in-session',
        supportedInteractionModes: ['default', 'plan'],
        supportedRuntimeModes: ['approval-required', 'full-access'],
        activeTurnInput: 'supported',
        conversationRollback: 'unsupported',
        orchestrateInstructionDelivery: 'prompt-prefix',
        orchestrateBaseModes: ['default', 'plan'],
      },
    },
    {
      driver: 'grok',
      expected: {
        sessionModelSwitch: 'in-session',
        supportedInteractionModes: ['default'],
        supportedRuntimeModes: ['approval-required', 'full-access'],
        activeTurnInput: 'supported',
        conversationRollback: 'unsupported',
        orchestrateInstructionDelivery: 'prompt-prefix',
        orchestrateBaseModes: ['default'],
      },
    },
    {
      driver: 'opencode',
      expected: {
        sessionModelSwitch: 'in-session',
        supportedInteractionModes: ['default', 'plan'],
        supportedRuntimeModes: ['approval-required', 'full-access'],
        activeTurnInput: 'supported',
        conversationRollback: 'exact',
        orchestrateInstructionDelivery: 'prompt-prefix',
        orchestrateBaseModes: ['default', 'plan'],
      },
    },
    {
      driver: 'coral',
      expected: {
        sessionModelSwitch: 'in-session',
        supportedInteractionModes: ['default'],
        supportedRuntimeModes: ['approval-required'],
        activeTurnInput: 'unsupported',
        conversationRollback: 'unsupported',
        orchestrateInstructionDelivery: 'unsupported',
        orchestrateBaseModes: [],
      },
    },
  ] as const)('returns the canonical $driver matrix', ({ driver, expected }) =>
  {
    expect(providerCapabilitiesForDriver(ProviderDriverKind.make(driver))).toEqual(expected)
  })

  it('fails closed for an unknown provider driver', () =>
  {
    expect(providerCapabilitiesForDriver(ProviderDriverKind.make('future-provider'))).toEqual(
      CONSERVATIVE_PROVIDER_CAPABILITIES,
    )
  })

  it('fails closed for absent cached capabilities and Coral Early Access Core', () =>
  {
    expect(resolveProviderCapabilities(undefined)).toEqual(CONSERVATIVE_PROVIDER_CAPABILITIES)
    expect(supportsRuntimeMode(CORAL_PROVIDER_CAPABILITIES, 'full-access')).toBe(false)
    expect(supportsTurnMode(CORAL_PROVIDER_CAPABILITIES, { interactionMode: 'plan' })).toBe(false)
    expect(supportsTurnMode(CORAL_PROVIDER_CAPABILITIES, { interactionMode: 'orchestrate' })).toBe(
      false,
    )
    expect(
      supportsTurnMode(CORAL_PROVIDER_CAPABILITIES, {
        interactionMode: 'plan',
        orchestrate: true,
      }),
    ).toBe(false)
    expect(supportsTurnMode(CORAL_PROVIDER_CAPABILITIES, { interactionMode: 'default' })).toBe(true)
    expect(supportsRuntimeMode(CORAL_PROVIDER_CAPABILITIES, 'approval-required')).toBe(true)
  })

  it('coerces Coral full-access to approval-required', () =>
  {
    expect(coerceSupportedRuntimeMode(CORAL_PROVIDER_CAPABILITIES, 'full-access')).toBe(
      'approval-required',
    )
    expect(coerceSupportedRuntimeMode(CORAL_PROVIDER_CAPABILITIES, 'approval-required')).toBe(
      'approval-required',
    )
  })
})
