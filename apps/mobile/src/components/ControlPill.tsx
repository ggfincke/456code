// apps/mobile/src/components/ControlPill.tsx
// render control pill

import { MenuView } from '@react-native-menu/menu'
import { type ComponentProps, type ReactNode } from 'react'
import { Pressable, useColorScheme, View, type AccessibilityProps } from 'react-native'

import { cn } from '../lib/cn'
import { SymbolView } from './AppSymbol'
import { AppText as Text } from './AppText'

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>['name']
  readonly iconNode?: ReactNode
  readonly label?: string
  readonly accessibilityLabel?: string
  readonly onPress?: () => void
  readonly variant?: 'circle' | 'pill' | 'primary' | 'danger'
  readonly disabled?: boolean
})
{
  const variant = props.variant ?? 'circle'

  const iconTintClassName =
    variant === 'primary'
      ? props.disabled
        ? 'accent-icon-subtle'
        : 'accent-primary-foreground'
      : variant === 'danger'
        ? 'accent-danger-foreground'
        : 'accent-icon'

  const isCircle =
    variant === 'circle' || variant === 'danger' || (variant === 'primary' && !props.label)
  const containerClassName = cn(
    isCircle
      ? 'h-11 w-11 items-center justify-center rounded-full'
      : variant === 'primary'
        ? 'h-11 flex-row items-center justify-center gap-2 rounded-full px-5'
        : 'h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5',
    variant === 'primary'
      ? props.disabled
        ? 'bg-subtle-strong'
        : 'bg-primary'
      : variant === 'danger'
        ? 'bg-danger'
        : 'bg-subtle',
  )
  const labelClassName = cn(
    'text-center text-xs font-sans-bold',
    variant === 'primary'
      ? props.disabled
        ? 'text-foreground-muted'
        : 'text-primary-foreground'
      : '',
  )

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      onPress={props.onPress}
      disabled={props.disabled}
      className={containerClassName}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName={iconTintClassName}
          type="monochrome"
        />
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </Pressable>
  )
}

// render the native UIMenu, including the standard checkmark for `state: "on"`.
export function ControlPillMenu(
  props: Omit<ComponentProps<typeof MenuView>, 'children' | 'themeVariant'> &
    Pick<AccessibilityProps, 'accessible' | 'accessibilityRole' | 'accessibilityLabel'> & {
      readonly children: ReactNode
      readonly className?: string
    },
)
{
  const isDarkMode = useColorScheme() === 'dark'

  const { className: _className, ...menuProps } = props
  return (
    <MenuView {...menuProps} themeVariant={isDarkMode ? 'dark' : 'light'}>
      {menuProps.children}
    </MenuView>
  )
}
