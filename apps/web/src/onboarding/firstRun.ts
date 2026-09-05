// apps/web/src/onboarding/firstRun.ts
// persists completion of the first-run wizard

import { useCallback } from 'react'

import { useUpdateClientSettings } from '../hooks/useSettings'

export function useCompleteOnboarding(): () => void
{
  const updateClientSettings = useUpdateClientSettings()
  return useCallback(() =>
  {
    updateClientSettings({ onboardingCompletedAt: new Date().toISOString() })
  }, [updateClientSettings])
}
