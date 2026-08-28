// apps/mobile/src/features/home/WorkspaceConnectionStatus.tsx
// render workspace connection status

import { SymbolView } from '../../components/AppSymbol'
import { ActivityIndicator, Pressable } from 'react-native'

import { AppText as Text } from '../../components/AppText'
import type { WorkspaceState } from '../../state/workspaceModel'
import { workspaceConnectionStatusLabel } from './workspace-connection-status'

export function WorkspaceConnectionStatus(props: {
  readonly state: WorkspaceState
  readonly onPress: () => void
  readonly variant?: 'floating' | 'sidebar'
})
{
  const isSynchronizing =
    props.state.networkStatus !== 'offline' &&
    props.state.connectionError === null &&
    (props.state.connectingEnvironments.length > 0 || props.state.hasPendingShellSnapshot)
  const variant = props.variant ?? 'floating'

  return (
    <Pressable
      accessibilityHint="Opens environment settings"
      accessibilityLabel={workspaceConnectionStatusLabel(props.state)}
      accessibilityRole="button"
      onPress={props.onPress}
      className={
        variant === 'sidebar'
          ? 'mx-3 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5'
          : 'flex-row items-center gap-2 rounded-full bg-card px-4 py-2.5'
      }
      style={
        variant === 'floating'
          ? {
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.12,
              shadowRadius: 24,
            }
          : undefined
      }
    >
      {isSynchronizing ? (
        <ActivityIndicator colorClassName="accent-icon-muted" size="small" />
      ) : (
        <SymbolView
          name="wifi.slash"
          size={15}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      )}
      <Text className="min-w-0 flex-1 text-sm font-sans-bold text-foreground" numberOfLines={1}>
        {workspaceConnectionStatusLabel(props.state)}
      </Text>
      {variant === 'sidebar' ? (
        <SymbolView
          name="chevron.right"
          size={11}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      ) : null}
    </Pressable>
  )
}
