// apps/mobile/src/native/composerEditorCapabilities.ts
// resolve composer editor capabilities by platform

import type { ComposerEditorCapabilities } from './ComposerEditor.types'

const CAPABILITIES_BY_PLATFORM: Readonly<Record<string, ComposerEditorCapabilities>> = {
  ios: { supportsHardwareSubmit: true },
  android: { supportsHardwareSubmit: false },
}

const FALLBACK_CAPABILITIES: ComposerEditorCapabilities = {
  supportsHardwareSubmit: false,
}

export function resolveComposerEditorCapabilities(platform: string): ComposerEditorCapabilities
{
  return CAPABILITIES_BY_PLATFORM[platform] ?? FALLBACK_CAPABILITIES
}
