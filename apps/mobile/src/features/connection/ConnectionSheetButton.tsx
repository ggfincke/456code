// apps/mobile/src/features/connection/ConnectionSheetButton.tsx
// render connection sheet button

import { SymbolView } from '../../components/AppSymbol'
import { Pressable } from 'react-native'

import { AppText as Text } from '../../components/AppText'
import { cn } from '../../lib/cn'

const CARD_SHADOW = {
  shadowColor: 'rgba(23,23,23,0.08)',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 1,
  shadowRadius: 16,
}

const CARD_SHADOW_DARK = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.18,
  shadowRadius: 8,
}

export { CARD_SHADOW, CARD_SHADOW_DARK }

export function ConnectionSheetButton(props: {
  readonly icon: React.ComponentProps<typeof SymbolView>['name']
  readonly label: string
  readonly disabled?: boolean
  readonly tone?: 'primary' | 'secondary' | 'danger'
  readonly compact?: boolean
  readonly onPress: () => void
})
{
  const tone = props.tone ?? 'secondary'

  const tintColorClassName =
    tone === 'primary'
      ? 'accent-primary-foreground'
      : tone === 'danger'
        ? 'accent-danger-foreground'
        : 'accent-secondary-foreground'

  const primaryShadow =
    tone === 'primary'
      ? {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.14,
          shadowRadius: 6,
        }
      : undefined

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false }}
      className={cn(
        props.compact
          ? 'min-h-[42px] flex-row items-center justify-center gap-1.5 rounded-[14px] px-3.5 py-2.5'
          : 'min-h-[48px] flex-row items-center justify-center gap-2 rounded-[16px] px-4 py-3',
        'disabled:opacity-50',
        tone === 'primary'
          ? 'bg-primary'
          : tone === 'danger'
            ? 'border border-danger-border bg-danger'
            : 'border border-border bg-secondary',
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={primaryShadow}
    >
      <SymbolView
        name={props.icon}
        size={props.compact ? 13 : 14}
        tintColorClassName={tintColorClassName}
        type="monochrome"
      />
      <Text
        className={cn(
          'text-xs font-sans-bold tracking-[0.8px] uppercase',
          tone === 'primary'
            ? 'text-primary-foreground'
            : tone === 'danger'
              ? 'text-danger-foreground'
              : 'text-secondary-foreground',
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  )
}
