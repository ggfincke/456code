// tests/apps/web/components/preview/PreviewPanelShell.test.ts
// verify right panel width preserves its sibling column

import { describe, expect, it } from 'vite-plus/test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  getPreviewPanelMaxWidth,
  PreviewPanelShell,
} from '../../../../../apps/web/src/components/preview/PreviewPanelShell'

describe('getPreviewPanelMaxWidth', () =>
{
  it.each([
    { viewport: 1_512, container: 1_256, expected: 896 },
    { viewport: 3_000, container: 2_900, expected: 2_100 },
    { viewport: 1_000, container: 700, expected: 360 },
  ])('caps a $viewport px viewport at $expected px', ({ viewport, container, expected }) =>
  {
    expect(getPreviewPanelMaxWidth(viewport, container)).toBe(expected)
  })

  it('keeps inline panels inside their containing workspace', () =>
  {
    const markup = renderToStaticMarkup(
      createElement(PreviewPanelShell, { mode: 'inline', children: 'Panel' }),
    )

    expect(markup).toContain('max-w-full')
  })
})
