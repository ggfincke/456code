// apps/mobile/src/lib/mobileThemeVariables.ts
// expose generated default theme variables to native and third-party boundaries

import defaultThemeVariables from '../../generated-uniwind-default-theme-variables.json'

export type MobileThemeAppearance = 'light' | 'dark'
export type MobileThemeVariable = `--color-${string}`
export type MobileThemeVariables = Readonly<Record<MobileThemeVariable, string>>

const defaults = defaultThemeVariables as Readonly<
  Record<MobileThemeAppearance, MobileThemeVariables>
>

export function getDefaultMobileThemeVariables(
  appearance: MobileThemeAppearance,
): MobileThemeVariables
{
  return defaults[appearance]
}
