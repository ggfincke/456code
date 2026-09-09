// apps/mobile/src/features/threads/composer/threadComposerSubmit.ts
// gate hardware submit handlers on editor support

import type { ComposerEditorCapabilities } from '../../../native/ComposerEditor.types'

export function canSubmitManualCompaction(input: {
  readonly text: string
  readonly attachmentCount: number
  readonly connected: boolean
  readonly busy: boolean
  readonly queuedCount: number
  readonly blocked: boolean
  readonly hasSession: boolean
  readonly supported: boolean
}): boolean
{
  return (
    input.text === '/compact' &&
    input.attachmentCount === 0 &&
    input.connected &&
    !input.busy &&
    input.queuedCount === 0 &&
    !input.blocked &&
    input.hasSession &&
    input.supported
  )
}

export function resolveComposerSubmitHandler(
  capabilities: ComposerEditorCapabilities,
  handler: (() => void) | undefined,
): (() => void) | undefined
{
  return capabilities.supportsHardwareSubmit ? handler : undefined
}
