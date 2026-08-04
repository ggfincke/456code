// apps/web/src/components/preview/previewAutomationOpenReadiness.ts
// expose preview automation open needs overlay

import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from '@t3tools/contracts'

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean
{
  return input.url !== undefined || snapshot.navStatus._tag !== 'Idle'
}
