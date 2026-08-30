// apps/mobile/src/lib/useThemeColor.ts
// manage theme color through a React hook

import type { ColorValue } from 'react-native'
import { useMobileThemeVariables } from './useMobileThemeVariables'

// reviewed native and third-party escape hatch; ordinary rendering uses className
export function useThemeColor(variable: `--color-${string}`): ColorValue
{
  return useMobileThemeVariables()[variable] as ColorValue
}
