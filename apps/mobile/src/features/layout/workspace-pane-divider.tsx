// apps/mobile/src/features/layout/workspace-pane-divider.tsx
// render workspace pane divider

import { useState } from 'react'
import {
  PlatformColor,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from 'react-native'
import { GestureDetector, type GestureType } from 'react-native-gesture-handler'

const ACCESSIBILITY_RESIZE_STEP = 24

interface WorkspacePaneDividerProps
{
  readonly accessibilityLabel: string
  readonly active: boolean
  readonly currentWidth: number
  readonly gesture: GestureType
  readonly onResizeBy: (delta: number) => void
}

// a forgiving divider target for touch, pointer, and VoiceOver users.
export function WorkspacePaneDivider(props: WorkspacePaneDividerProps)
{
  const [hovered, setHovered] = useState(false)

  const handleAccessibilityAction = (event: AccessibilityActionEvent) =>
  {
    if (event.nativeEvent.actionName === 'increment')
    {
      props.onResizeBy(ACCESSIBILITY_RESIZE_STEP)
    }
    else if (event.nativeEvent.actionName === 'decrement')
    {
      props.onResizeBy(-ACCESSIBILITY_RESIZE_STEP)
    }
  }

  return (
    <GestureDetector gesture={props.gesture}>
      <Pressable
        className="relative z-[100] -mx-[22px] w-11 self-stretch cursor-pointer justify-center"
        accessibilityActions={[
          { name: 'increment', label: 'Make pane wider' },
          { name: 'decrement', label: 'Make pane narrower' },
        ]}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="adjustable"
        accessibilityValue={{
          now: Math.round(props.currentWidth),
          text: `${Math.round(props.currentWidth)} points wide`,
        }}
        onAccessibilityAction={handleAccessibilityAction}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
      >
        <View style={[styles.line, (hovered || props.active) && styles.activeLine]} />
      </Pressable>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  line: {
    alignSelf: 'center',
    backgroundColor: PlatformColor('separator'),
    height: '100%',
    opacity: 0.7,
    width: StyleSheet.hairlineWidth,
  },
  activeLine: {
    backgroundColor: PlatformColor('systemBlueColor'),
    opacity: 1,
    width: 2,
  },
})
