// apps/mobile/src/native/ComposerEditor.android.tsx
// expose the Android native composer editor and its capabilities

import { resolveComposerEditorCapabilities } from './composerEditorCapabilities'

export const composerEditorCapabilities = resolveComposerEditorCapabilities('android')

export { ComposerEditor } from './ComposerEditor.native'
export type {
  ComposerEditorCapabilities,
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from './ComposerEditor.types'
