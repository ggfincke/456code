// apps/mobile/src/native/KeyboardCommands.ios.tsx
// render keyboard commands ios

import { requireNativeView } from 'expo'
import type { PropsWithChildren } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'

import type { HardwareKeyboardCommand } from '../features/keyboard/hardwareKeyboardCommands'

interface NativeKeyboardCommandsProps extends ViewProps, PropsWithChildren
{
  readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>
  readonly onCommand: (
    event: NativeSyntheticEvent<{ readonly command: HardwareKeyboardCommand }>,
  ) => void
}

const NativeKeyboardCommands =
  requireNativeView<NativeKeyboardCommandsProps>('Code456KeyboardCommands')

export function KeyboardCommands(
  props: PropsWithChildren<{
    readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>
    readonly onCommand: (command: HardwareKeyboardCommand) => void
  }>,
)
{
  return (
    <NativeKeyboardCommands
      onCommand={(event) => props.onCommand(event.nativeEvent.command)}
      enabledCommands={props.enabledCommands}
      style={{ flex: 1 }}
    >
      {props.children}
    </NativeKeyboardCommands>
  )
}
