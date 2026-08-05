// apps/mobile/src/features/cloud/connectOnboardingOptOut.ts
// determine whether connect onboarding opted out

import { loadPreferences, updatePreferences } from '../../persistence/imperative'

// lives apart from connectOnboarding.ts so CloudAuthProvider (which imports
// the request signal) never pulls the persistence adapter into its
// module graph; that breaks CloudAuthProvider.test.ts suite loading.

// whether the account chose "Don't show this again".
export async function isConnectOnboardingOptedOut(accountId: string): Promise<boolean>
{
  const preferences = await loadPreferences()
  return preferences.connectOnboardingOptOutAccounts?.includes(accountId) ?? false
}

// persists "Don't show this again" for the account.
export async function optOutOfConnectOnboarding(accountId: string): Promise<void>
{
  await updatePreferences((current) =>
  {
    const optedOut = current.connectOnboardingOptOutAccounts ?? []
    return optedOut.includes(accountId)
      ? {}
      : { connectOnboardingOptOutAccounts: [...optedOut, accountId] }
  })
}
