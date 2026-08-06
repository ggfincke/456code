// apps/mobile/src/features/threads/composer/composerSurface.tsx
// shared liquid-glass / opaque composer chrome surface

import { isLiquidGlassSupported, LiquidGlassView } from '@callstack/liquid-glass'
import type { ReactNode } from 'react'
import { Platform, View, type ViewStyle } from 'react-native'
import Animated, { LinearTransition } from 'react-native-reanimated'

// one timing for every piece of the expanded↔compact morph so the surface,
// toolbar, and siblings move together instead of popping between layouts.
// android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter.
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === 'android' ? undefined : LinearTransition.duration(220)

export function ComposerSurface(props: {
  readonly children: ReactNode
  readonly style: ViewStyle
  readonly isDarkMode: boolean
})
{
  // drop shadow lives on a wrapper: `overflow: "hidden"` on the surface itself
  // (needed to clip content to the pill shape) would clip the shadow on iOS.
  const shadowStyle: ViewStyle = {
    borderRadius: props.style.borderRadius,
    shadowColor: '#000000',
    shadowOpacity: props.isDarkMode ? 0.35 : 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  }

  if (isLiquidGlassSupported)
  {
    return (
      <Animated.View layout={COMPOSER_LAYOUT_TRANSITION} style={shadowStyle}>
        <LiquidGlassView
          effect="regular"
          interactive
          colorScheme={props.isDarkMode ? 'dark' : 'light'}
          style={props.style}
        >
          {props.children}
        </LiquidGlassView>
      </Animated.View>
    )
  }

  return (
    <Animated.View layout={COMPOSER_LAYOUT_TRANSITION} style={shadowStyle}>
      <View
        style={[
          props.style,
          {
            backgroundColor: props.isDarkMode ? 'rgba(44,44,46,0.96)' : 'rgba(255,255,255,0.96)',
            borderWidth: 1,
            borderColor: props.isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
          },
        ]}
      >
        {props.children}
      </View>
    </Animated.View>
  )
}
