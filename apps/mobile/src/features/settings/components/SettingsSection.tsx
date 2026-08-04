// apps/mobile/src/features/settings/components/SettingsSection.tsx
// render settings section

import type { ReactNode } from 'react'
import { View } from 'react-native'

import { AppText as Text } from '../../../components/AppText'

export function SettingsSection(props: {
  readonly title: string
  readonly children: ReactNode
  // force the grouped card background; Android otherwise lists options flat.
  readonly card?: boolean
})
{
  return (
    <View className="gap-2">
      <Text className="px-2 text-sm font-sans-medium text-foreground-muted">{props.title}</Text>
      <View
        className={
          props.card
            ? 'overflow-hidden rounded-[24px] border-continuous bg-card'
            : 'overflow-hidden rounded-[24px] border-continuous bg-card android:bg-transparent'
        }
      >
        {props.children}
      </View>
    </View>
  )
}
