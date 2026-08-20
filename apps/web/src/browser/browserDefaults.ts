// apps/web/src/browser/browserDefaults.ts
// resolve configured preview-browser defaults

import type {
  DesktopPreviewTabDefaults,
  PreviewAppearancePreference,
  PreviewViewportSetting,
} from '@t3tools/contracts'

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  useClientSettings,
} from '~/hooks/useSettings'

import { resolveResponsiveBrowserViewportSize } from './browserViewportLayout'

export interface BrowserDefaults
{
  readonly viewport: PreviewViewportSetting
  readonly zoomFactor: number
  readonly appearance: PreviewAppearancePreference
  readonly autoShowFloatingPreview: boolean
}

const toBrowserDefaults = (settings: {
  readonly browserDefaultViewport: PreviewViewportSetting
  readonly browserDefaultZoomFactor: number
  readonly browserDefaultAppearance: PreviewAppearancePreference
  readonly browserAutoShowFloatingPreview: boolean
}): BrowserDefaults => ({
  viewport: settings.browserDefaultViewport,
  zoomFactor: settings.browserDefaultZoomFactor,
  appearance: settings.browserDefaultAppearance,
  autoShowFloatingPreview: settings.browserAutoShowFloatingPreview,
})

export function getBrowserDefaults(): BrowserDefaults
{
  return toBrowserDefaults(getClientSettings())
}

export async function resolveBrowserDefaults(): Promise<BrowserDefaults>
{
  await ensureClientSettingsHydrated()
  return getBrowserDefaults()
}

export function useBrowserDefaults(): BrowserDefaults
{
  return useClientSettings(toBrowserDefaults)
}

export function browserDefaultTabState(
  defaults: BrowserDefaults = getBrowserDefaults(),
): DesktopPreviewTabDefaults
{
  return { zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance }
}

export function browserDefaultOpenViewport(
  defaults: BrowserDefaults = getBrowserDefaults(),
): PreviewViewportSetting
{
  return defaults.viewport
}

export const FALLBACK_RESPONSIVE_VIEWPORT_SIZE = { width: 1024, height: 768 } as const

export function browserResponsiveViewportForToggle(input: {
  readonly defaults?: BrowserDefaults
  readonly panelRect: { readonly width: number; readonly height: number } | null
  readonly zoomFactor: number | undefined
}): PreviewViewportSetting
{
  const defaults = input.defaults ?? getBrowserDefaults()
  if (defaults.viewport._tag !== 'fill') return defaults.viewport
  const size = input.panelRect
    ? resolveResponsiveBrowserViewportSize(input.panelRect, input.zoomFactor)
    : FALLBACK_RESPONSIVE_VIEWPORT_SIZE
  return { _tag: 'freeform', ...size }
}
