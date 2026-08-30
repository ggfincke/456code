// apps/mobile/src/features/settings/appearance/AppearancePreferencesProvider.tsx
// provide appearance preferences context

import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'

import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { AsyncResult } from 'effect/unstable/reactivity'

import { ScopedTheme, Uniwind } from 'uniwind'

import {
  resolveAppearance,
  resolveAppearancePreferences,
  resolveTextScaleVariables,
  type AppearancePreferences,
  type ResolvedAppearance,
} from '../../../lib/appearancePreferences'
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from '../../../state/preferences'
import { cacheTerminalFontSize } from '../../terminal/terminalUiState'
import type { MobileThemeAppearance } from '../../../lib/mobileThemeVariables'

interface AppearancePreferencesContextValue
{
  // effective values with base-size derivation applied. Use this for rendering.
  readonly appearance: ResolvedAppearance
  readonly themeAppearance: MobileThemeAppearance
  readonly isReady: boolean
  readonly setBaseFontSize: (value: number) => void
  // pass null to clear the override and follow the base font size.
  readonly setTerminalFontSize: (value: number | null) => void
  // pass null to clear the override and follow the base font size.
  readonly setCodeFontSize: (value: number | null) => void
  readonly setCodeWordBreak: (value: boolean) => void
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null)

// injects the scaled `--text-*` variables into Uniwind so every
// className-based text size (`text-sm`, `text-base`, ...) re-resolves live.
// updates the current theme last so the active stylesheet settles correctly.
function applyTextScaleVariables(baseFontSize: number)
{
  const variables = resolveTextScaleVariables(baseFontSize)
  const currentTheme = Uniwind.currentTheme

  for (const theme of ['light', 'dark'] as const)
  {
    if (theme !== currentTheme)
    {
      Uniwind.updateCSSVariables(theme, variables)
    }
  }
  Uniwind.updateCSSVariables(currentTheme, variables)
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode })
{
  const themeAppearance = useColorScheme() === 'dark' ? 'dark' : 'light'
  const preferencesResult = useAtomValue(mobilePreferencesAtom)
  const savePreferences = useAtomSet(updateMobilePreferencesAtom)
  const preferences = useMemo(
    () =>
      resolveAppearancePreferences(
        AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null,
      ),
    [preferencesResult],
  )
  const isReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting

  useEffect(() =>
  {
    applyTextScaleVariables(preferences.baseFontSize)
    cacheTerminalFontSize(resolveAppearance(preferences).terminalFontSize)
  }, [preferences])

  const updatePreferences = useCallback(
    (patch: Partial<AppearancePreferences>) =>
    {
      savePreferences(patch)
    },
    [savePreferences],
  )

  const setBaseFontSize = useCallback(
    (value: number) =>
    {
      updatePreferences({ baseFontSize: value })
    },
    [updatePreferences],
  )

  const setTerminalFontSize = useCallback(
    (value: number | null) =>
    {
      updatePreferences({ terminalFontSize: value })
    },
    [updatePreferences],
  )

  const setCodeFontSize = useCallback(
    (value: number | null) =>
    {
      updatePreferences({ codeFontSize: value })
    },
    [updatePreferences],
  )

  const setCodeWordBreak = useCallback(
    (value: boolean) =>
    {
      updatePreferences({ codeWordBreak: value })
    },
    [updatePreferences],
  )

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance: resolveAppearance(preferences),
      themeAppearance,
      isReady,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    }),
    [
      preferences,
      themeAppearance,
      isReady,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    ],
  )

  return (
    <AppearancePreferencesContext.Provider value={value}>
      <ScopedTheme theme={themeAppearance}>{props.children}</ScopedTheme>
    </AppearancePreferencesContext.Provider>
  )
}

export function useAppearancePreferences(): AppearancePreferencesContextValue
{
  const context = use(AppearancePreferencesContext)
  if (!context)
  {
    throw new Error('useAppearancePreferences must be used within AppearancePreferencesProvider')
  }
  return context
}
