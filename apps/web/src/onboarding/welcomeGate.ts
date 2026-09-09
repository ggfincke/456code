// apps/web/src/onboarding/welcomeGate.ts
// gates first-run onboarding until authentication, config, and local settings are ready

export function shouldShowWelcomeWizard(input: {
  readonly authenticated: boolean
  readonly clientSettingsHydrated: boolean
  readonly serverConfigAvailable: boolean
  readonly onboardingCompletedAt: string | null
}): boolean
{
  return (
    input.authenticated &&
    input.clientSettingsHydrated &&
    input.serverConfigAvailable &&
    input.onboardingCompletedAt === null
  )
}
