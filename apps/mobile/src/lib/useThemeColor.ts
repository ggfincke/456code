// apps/mobile/src/lib/useThemeColor.ts
// manage theme color through a React hook

import type { ColorValue } from 'react-native'
import { useCSSVariable } from 'uniwind'

// typed wrapper around `useCSSVariable` that returns a `ColorValue` for use
// in React Native style props (backgroundColor, tintColor, etc.).
//
// usage: `const color = useThemeColor("--color-icon");`
export function useThemeColor(variable: `--color-${string}`): ColorValue
{
  return useCSSVariable(variable) as string as ColorValue
}
