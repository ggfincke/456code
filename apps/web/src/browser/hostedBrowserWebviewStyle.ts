// apps/web/src/browser/hostedBrowserWebviewStyle.ts
// resolve hosted browser webview wrapper style

import type { BrowserSurfaceRect } from './browserSurfaceStore'

export interface HostedBrowserWebviewSize
{
  readonly width: number
  readonly height: number
}

export interface HostedBrowserWebviewWrapperStyle
{
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly zIndex: number
  readonly pointerEvents: 'auto' | 'none'
  readonly visibility?: 'visible' | 'hidden'
  readonly opacity?: number
}

export const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean
  readonly renderingActive: boolean
  readonly rect: BrowserSurfaceRect | null
  readonly hiddenSize: HostedBrowserWebviewSize
}): HostedBrowserWebviewWrapperStyle
{
  const { active, renderingActive, hiddenSize, rect } = input
  if (active && rect)
  {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex: 30,
      pointerEvents: 'auto',
    }
  }

  return {
    // background work needs viewport intersection without exposing the guest
    left: renderingActive ? 0 : HIDDEN_BROWSER_WEBVIEW_OFFSET,
    top: renderingActive ? 0 : HIDDEN_BROWSER_WEBVIEW_OFFSET,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: -1,
    pointerEvents: 'none',
    visibility: renderingActive ? 'visible' : 'hidden',
    opacity: 0,
  }
}
