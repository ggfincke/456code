// apps/mobile/src/features/threads/threadComposerSubmit.ts
// gate hardware submit handlers on editor support

import type { ComposerEditorCapabilities } from '../../native/ComposerEditor.types'

export function resolveComposerSubmitHandler(
  capabilities: ComposerEditorCapabilities,
  handler: (() => void) | undefined,
): (() => void) | undefined
{
  return capabilities.supportsHardwareSubmit ? handler : undefined
}
