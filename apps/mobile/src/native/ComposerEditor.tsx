// apps/mobile/src/native/ComposerEditor.tsx
// provide the fallback composer editor and its capabilities

import { TextInputWrapper } from 'expo-paste-input'
import { useImperativeHandle, useRef } from 'react'
import { TextInput, type TextInput as RNTextInput } from 'react-native'

import { useFontFamily } from '../lib/useFontFamily'
import { useScaledTextRole } from '../features/settings/appearance/useScaledTextRole'
import { useNativePaste } from '../lib/useNativePaste'
import type { ComposerEditorCapabilities, ComposerEditorProps } from './ComposerEditor.types'

export const composerEditorCapabilities: ComposerEditorCapabilities = {
  supportsHardwareSubmit: false,
}

export function ComposerEditor({
  ref,
  skills: _skills,
  selection,
  onPasteImages,
  style,
  textStyle,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps)
{
  const inputRef = useRef<RNTextInput>(null)
  const bodyText = useScaledTextRole('body')
  const fontFamily = useFontFamily('regular')
  const handlePaste = useNativePaste((uris) => onPasteImages?.(uris))

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      setSelection: (nextSelection) =>
        inputRef.current?.setSelection(nextSelection.start, nextSelection.end),
    }),
    [],
  )

  return (
    <TextInputWrapper onPaste={handlePaste} style={[{ minHeight: 0 }, style]}>
      <TextInput
        ref={inputRef}
        {...props}
        selection={selection}
        onSelectionChange={(event) => props.onSelectionChange?.(event.nativeEvent.selection)}
        multiline={props.multiline ?? true}
        placeholderTextColorClassName="accent-placeholder"
        className="text-foreground"
        style={[
          {
            flex: 1,
            minHeight: 0,
            fontFamily,
            ...bodyText,
            paddingVertical: contentInsetVertical,
          },
          textStyle,
        ]}
      />
    </TextInputWrapper>
  )
}

export type {
  ComposerEditorCapabilities,
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from './ComposerEditor.types'
