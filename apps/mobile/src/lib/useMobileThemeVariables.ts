// apps/mobile/src/lib/useMobileThemeVariables.ts
// bridge default semantic tokens to native and third-party APIs

import { useAppearancePreferences } from '../features/settings/appearance/AppearancePreferencesProvider'
import { getDefaultMobileThemeVariables, type MobileThemeVariables } from './mobileThemeVariables'

// ordinary React Native rendering uses semantic className values; keep this hook
// at reviewed boundaries whose APIs require concrete JS colors
export function useMobileThemeVariables(): MobileThemeVariables
{
  const { themeAppearance } = useAppearancePreferences()
  return getDefaultMobileThemeVariables(themeAppearance)
}
