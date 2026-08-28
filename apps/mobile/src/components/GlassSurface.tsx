// apps/mobile/src/components/GlassSurface.tsx
// render glass surface

import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import {
  Platform,
  useColorScheme,
  View,
  type ColorValue,
  type ViewProps,
  type ViewStyle,
} from 'react-native'
import { withUniwind } from 'uniwind'

import { cn } from '../lib/cn'

const ThemedGlassView = withUniwind(GlassView)

export interface GlassSurfaceProps extends ViewProps
{
  readonly children: ReactNode
  readonly glassEffectStyle?: 'clear' | 'regular' | 'none'
  readonly tintColor?: ColorValue
  readonly tintColorClassName?: string
  readonly chrome?: 'default' | 'none'
}

export function GlassSurface({
  children,
  glassEffectStyle = 'regular',
  chrome = 'default',
  tintColor,
  tintColorClassName,
  className,
  style,
  ...props
}: GlassSurfaceProps)
{
  const isDarkMode = useColorScheme() === 'dark'
  const supportsGlass = Platform.OS === 'ios' && isGlassEffectAPIAvailable()
  const surfaceStyle: ViewStyle = {
    borderRadius: 32,
    overflow: 'hidden',
    shadowColor: chrome === 'none' ? 'transparent' : '#000000',
    shadowOpacity: chrome === 'none' ? 0 : isDarkMode ? 0.22 : 0.08,
    shadowRadius: chrome === 'none' ? 0 : 28,
    shadowOffset:
      chrome === 'none'
        ? {
            width: 0,
            height: 0,
          }
        : {
            width: 0,
            height: 14,
          },
  }

  if (supportsGlass)
  {
    return (
      <ThemedGlassView
        {...props}
        className={cn(
          chrome === 'none'
            ? 'border-0 border-transparent bg-transparent'
            : 'border border-border bg-glass-surface',
          className,
        )}
        glassEffectStyle={glassEffectStyle}
        tintColor={tintColor === undefined ? undefined : String(tintColor)}
        tintColorClassName={
          tintColorClassName ?? (tintColor === undefined ? 'accent-glass-tint' : undefined)
        }
        colorScheme={isDarkMode ? 'dark' : 'light'}
        style={[surfaceStyle, style]}
      >
        {children}
      </ThemedGlassView>
    )
  }

  return (
    <View
      {...props}
      className={cn(
        chrome === 'none'
          ? 'border-0 border-transparent bg-transparent'
          : 'border border-border bg-glass-surface',
        className,
      )}
      style={[surfaceStyle, style]}
    >
      {children}
    </View>
  )
}
