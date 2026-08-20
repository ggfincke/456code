// apps/web/src/components/preview/previewAutomationOpenReadiness.ts
// expose preview automation open needs overlay

import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewAutomationOpenInput,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from '@t3tools/contracts'

export const DEFAULT_PREVIEW_AUTOMATION_VIEWPORT = {
  _tag: 'freeform',
  width: 1280,
  height: 800,
} as const satisfies PreviewViewportSetting

export function shouldOpenPreviewPanel(
  input: PreviewAutomationOpenInput,
  autoShowPreview = true,
): boolean
{
  return input.show ?? autoShowPreview
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean
{
  return input.url !== undefined || snapshot.navStatus._tag !== 'Idle'
}

export function previewAutomationDefaultViewport(
  reusedExistingTab: boolean,
  snapshot: PreviewSessionSnapshot,
): PreviewViewportSetting | null
{
  const viewport = snapshot.viewport ?? FILL_PREVIEW_VIEWPORT
  return !reusedExistingTab && viewport._tag === 'fill' ? DEFAULT_PREVIEW_AUTOMATION_VIEWPORT : null
}
