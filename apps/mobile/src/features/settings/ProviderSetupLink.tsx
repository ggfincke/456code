// apps/mobile/src/features/settings/ProviderSetupLink.tsx
// open provider setup from an environment row

import type { ServerProvider } from '@t3tools/contracts'
import { Pressable } from 'react-native'

import { AppText as Text } from '../../components/AppText'
import { ProviderIcon } from '../../components/ProviderIcon'
import { SymbolView } from '../../components/AppSymbol'

export function ProviderSetupLink(props: {
  readonly provider: ServerProvider
  readonly onPress: () => void
})
{
  const label = props.provider.displayName ?? 'Antigravity'
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 rounded-[14px] bg-subtle px-4 py-3 active:opacity-70"
    >
      <ProviderIcon provider={props.provider.driver} size={18} />
      <Text className="min-w-0 flex-1 text-base text-foreground">Manage {label}</Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground" />
    </Pressable>
  )
}
