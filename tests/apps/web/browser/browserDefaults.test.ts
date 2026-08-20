// tests/apps/web/browser/browserDefaults.test.ts
// verify preview-browser default resolution

import { describe, expect, it } from 'vite-plus/test'

import {
  FALLBACK_RESPONSIVE_VIEWPORT_SIZE,
  browserDefaultOpenViewport,
  browserDefaultTabState,
  browserResponsiveViewportForToggle,
  type BrowserDefaults,
} from '../../../../apps/web/src/browser/browserDefaults'

const defaults = (viewport: BrowserDefaults['viewport']): BrowserDefaults => ({
  viewport,
  zoomFactor: 1.25,
  appearance: 'dark',
  autoShowFloatingPreview: false,
})

describe('browserDefaults', () =>
{
  it('shapes tab creation and server-open defaults from one preference snapshot', () =>
  {
    const configured = defaults({ _tag: 'preset', width: 1024, height: 600, presetId: 'nest-hub' })
    expect(browserDefaultTabState(configured)).toEqual({ zoomFactor: 1.25, colorScheme: 'dark' })
    expect(browserDefaultOpenViewport(configured)).toBe(configured.viewport)
  })

  it('uses a configured size before panel-derived and fixed responsive fallbacks', () =>
  {
    const configured = defaults({ _tag: 'freeform', width: 900, height: 700 })
    expect(
      browserResponsiveViewportForToggle({
        defaults: configured,
        panelRect: { width: 1400, height: 900 },
        zoomFactor: 1,
      }),
    ).toBe(configured.viewport)

    const fill = defaults({ _tag: 'fill' })
    expect(
      browserResponsiveViewportForToggle({
        defaults: fill,
        panelRect: null,
        zoomFactor: undefined,
      }),
    ).toEqual({ _tag: 'freeform', ...FALLBACK_RESPONSIVE_VIEWPORT_SIZE })
  })
})
