// packages/shared/src/themePalettes.ts
// share palette roles and publication identity rules

export const BUILT_IN_THEME_IDS = ['light', 'dark', 'ocean'] as const
export const RESERVED_THEME_IDS: ReadonlySet<string> = new Set(['system', ...BUILT_IN_THEME_IDS])
export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number]
export type ThemeAppearance = 'light' | 'dark'

export const THEME_COLOR_ROLES = [
  'canvas',
  'chrome',
  'toolbar',
  'toolbarForeground',
  'toolbarBorder',
  'toolbarControl',
  'toolbarControlForeground',
  'toolbarControlHover',
  'surface',
  'surfaceRaised',
  'surfaceOverlay',
  'text',
  'textMuted',
  'border',
  'input',
  'focus',
  'accent',
  'accentForeground',
  'secondary',
  'secondaryForeground',
  'muted',
  'mutedForeground',
  'placeholder',
  'secondaryLabel',
  'iconMuted',
  'error',
  'errorForeground',
  'errorSurface',
  'warning',
  'warningForeground',
  'warningSurface',
  'update',
  'updateForeground',
  'updateSurface',
  'accentSurface',
  'accentSurfaceForeground',
  'messageSurface',
  'messageForeground',
  'messageAction',
  'messageActionForeground',
  'messageActionHover',
  'codeBackground',
  'codeForeground',
  'sidebar',
  'sidebarForeground',
  'sidebarMutedForeground',
  'sidebarControlSurface',
  'sidebarRowHover',
  'sidebarRowActive',
  'sidebarRowSelected',
  'sidebarBorder',
  'terminalBackground',
  'terminalForeground',
  'terminalCursor',
  'terminalSelection',
  'terminalScrollbar',
  'terminalScrollbarHover',
] as const
export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number]
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>
export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>
export type ThemeDefinition = Readonly<{
  id: string
  label: string
  appearance: ThemeAppearance
  colors: ThemeColors
  variants?: ThemeVariants
}>

export function environmentThemeFileHasColors(file: {
  readonly canvas?: string
  readonly accent?: string
  readonly colors?: Readonly<Record<string, string>>
}): boolean
{
  return (
    (file.canvas !== undefined && file.accent !== undefined) ||
    (file.colors !== undefined && Object.keys(file.colors).length > 0)
  )
}
