// apps/mobile/src/features/settings/components/SettingsSwitchRow.tsx
// render settings switch row

import type { ComponentProps } from 'react'
import { Switch, View } from 'react-native'

import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'

type SymbolName = ComponentProps<typeof SymbolView>['name']

export function SettingsSwitchRow(props: {
  readonly disabled?: boolean
  readonly icon: SymbolName
  readonly label: string
  readonly value: boolean
  readonly onValueChange: (value: boolean) => void
})
{
  return (
    <View
      className={
        props.disabled
          ? 'flex-row items-center gap-4 p-4 opacity-[0.45]'
          : 'flex-row items-center gap-4 p-4'
      }
    >
      <SymbolView
        name={props.icon}
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">{props.label}</Text>
      <Switch
        disabled={props.disabled}
        ios_backgroundColorClassName="accent-secondary-border"
        onValueChange={props.onValueChange}
        trackColorOffClassName="accent-secondary-border"
        trackColorOnClassName="accent-switch-active"
        value={props.value}
      />
    </View>
  )
}
