// tests/apps/web/onboarding/welcomeGate.test.ts
// verifies first-run onboarding waits for durable client state

import { describe, expect, it } from 'vite-plus/test'

import { shouldShowWelcomeWizard } from '../../../../apps/web/src/onboarding/welcomeGate'

describe('shouldShowWelcomeWizard', () =>
{
  it('shows only after authenticated config and client-settings hydration are complete', () =>
  {
    const ready = {
      authenticated: true,
      clientSettingsHydrated: true,
      serverConfigAvailable: true,
      onboardingCompletedAt: null,
    }
    expect(shouldShowWelcomeWizard(ready)).toBe(true)
    expect(shouldShowWelcomeWizard({ ...ready, authenticated: false })).toBe(false)
    expect(shouldShowWelcomeWizard({ ...ready, clientSettingsHydrated: false })).toBe(false)
    expect(shouldShowWelcomeWizard({ ...ready, serverConfigAvailable: false })).toBe(false)
    expect(
      shouldShowWelcomeWizard({ ...ready, onboardingCompletedAt: '2026-09-09T12:00:00.000Z' }),
    ).toBe(false)
  })
})
