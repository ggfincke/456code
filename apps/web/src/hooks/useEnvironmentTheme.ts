// apps/web/src/hooks/useEnvironmentTheme.ts
// adapt the primary environment's published palettes into the live theme catalog

import { useAtomValue } from '@effect/atom-react'
import type { EnvironmentTheme } from '@t3tools/contracts'
import {
  RESERVED_THEME_IDS,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from '@t3tools/shared/themePalettes'
import { useEffect } from 'react'

import { primaryServerEnvironmentThemesAtom } from '../state/server'
import {
  applyThemeColorOverrides,
  createManagedThemeColors,
  getStandardThemeColors,
  toCanonicalThemeColor,
} from '../themePalette'
import { setEnvironmentThemes } from './useTheme'

function publishedColors(
  theme: EnvironmentTheme,
  appearance: ThemeAppearance,
  colors: Readonly<Record<string, string>> | undefined,
): ThemeColors
{
  const base =
    appearance === theme.appearance && theme.canvas !== undefined && theme.accent !== undefined
      ? createManagedThemeColors(appearance, theme.canvas, theme.accent)
      : getStandardThemeColors(appearance)
  return applyThemeColorOverrides(base, colors)
}

export function publishedThemeDefinitions(
  themes: ReadonlyArray<EnvironmentTheme>,
): ReadonlyArray<ThemeDefinition>
{
  return themes
    .filter((theme) =>
    {
      if (RESERVED_THEME_IDS.has(theme.id)) return false
      if (theme.canvas !== undefined && theme.accent !== undefined) return true
      const other = theme.appearance === 'dark' ? 'light' : 'dark'
      return [theme.colors, theme.variants?.[other]].some((colors) =>
        THEME_COLOR_ROLES.some((role) => toCanonicalThemeColor(colors?.[role]) !== null),
      )
    })
    .map((theme): ThemeDefinition =>
    {
      const other = theme.appearance === 'dark' ? 'light' : 'dark'
      const variant = theme.variants?.[other]
      return {
        id: theme.id,
        label: theme.name,
        appearance: theme.appearance,
        colors: publishedColors(theme, theme.appearance, theme.colors),
        ...(variant === undefined
          ? {}
          : {
              variants: { [other]: publishedColors(theme, other, variant) },
            }),
      }
    })
}

export function useEnvironmentThemeSync(): void
{
  const published = useAtomValue(primaryServerEnvironmentThemesAtom)
  useEffect(() =>
  {
    setEnvironmentThemes(publishedThemeDefinitions(published))
  }, [published])
  useEffect(() => () => setEnvironmentThemes([]), [])
}
