// apps/mobile/src/components/AppSymbol.tsx
// render app symbol

import { SymbolView as ExpoSymbolView, type SymbolViewProps } from 'expo-symbols'

export type { SFSymbol } from 'expo-symbols'
export type AppSymbolName = SymbolViewProps['name']

export function SymbolView(props: SymbolViewProps)
{
  return <ExpoSymbolView {...props} />
}
