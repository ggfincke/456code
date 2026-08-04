import { View } from 'react-native'

import { HeaderButton } from '../../native/HeaderButton.android'
import type { SidebarHeaderActionsProps } from './sidebar-header-actions'

export function SidebarHeaderActions(props: SidebarHeaderActionsProps)
{
  return (
    <View className="h-11 flex-row gap-1">
      <HeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  )
}
