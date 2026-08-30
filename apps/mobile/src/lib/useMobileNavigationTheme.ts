// apps/mobile/src/lib/useMobileNavigationTheme.ts
// derive React Navigation colors from the active default mobile theme

import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native'
import { useMemo } from 'react'

import { useAppearancePreferences } from '../features/settings/appearance/AppearancePreferencesProvider'
import { useMobileThemeVariables } from './useMobileThemeVariables'

export function useMobileNavigationTheme(): Theme
{
  const { themeAppearance } = useAppearancePreferences()
  const variables = useMobileThemeVariables()

  return useMemo(() =>
  {
    const base = themeAppearance === 'dark' ? DarkTheme : DefaultTheme
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: variables['--color-primary'],
        background: variables['--color-screen'],
        card: variables['--color-sheet'],
        text: variables['--color-foreground'],
        border: variables['--color-header-border'],
        notification: variables['--color-danger-foreground'],
      },
    }
  }, [themeAppearance, variables])
}
