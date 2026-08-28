// tests/apps/web/browser/hostedBrowserWebviewStyle.test.ts
// verify resolve hosted browser webview wrapper style behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from '../../../../apps/web/src/browser/hostedBrowserWebviewStyle'

describe('resolveHostedBrowserWebviewWrapperStyle', () =>
{
  it('places an active webview on its presented surface', () =>
  {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        renderingActive: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: 'auto',
    })
  })

  it('suspends an idle offscreen webview and conceals active work inside the viewport', () =>
  {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    })

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 393,
      height: 852,
      zIndex: -1,
      pointerEvents: 'none',
      visibility: 'hidden',
      opacity: 0,
    })
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        renderingActive: true,
        rect: null,
        hiddenSize: { width: 393, height: 852 },
      }),
    ).toEqual({ ...style, left: 0, top: 0, visibility: 'visible' })
  })
})
