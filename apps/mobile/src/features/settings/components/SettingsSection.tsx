// apps/mobile/src/features/settings/components/SettingsSection.tsx
// render settings section

import type { ReactNode } from 'react'
import { View } from 'react-native'

import { AppText as Text } from '../../../components/AppText'

export function SettingsSection(props: { readonly title: string; readonly children: ReactNode })
{
  return (
    <View className="gap-2">
      <Text className="px-2 text-sm font-sans-medium text-foreground-muted">{props.title}</Text>
      <View className="overflow-hidden rounded-[24px] border-continuous bg-card">
        {props.children}
      </View>
    </View>
  )
}
