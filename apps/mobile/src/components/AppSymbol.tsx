// apps/mobile/src/components/AppSymbol.tsx
// render app symbol

import { SymbolView as ExpoSymbolView, type SymbolViewProps } from 'expo-symbols'
import { withUniwind } from 'uniwind'

export type { SFSymbol } from 'expo-symbols'
export type AppSymbolName = SymbolViewProps['name']

// expo-symbols exposes tint as a native prop; keep the Uniwind bridge here so
// callers can pass tintColorClassName without subscribing to theme variables
export const SymbolView = withUniwind(ExpoSymbolView)
