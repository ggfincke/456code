// tests/apps/web/browser/BrowserViewportResizeHandles.test.tsx
// verify top-edge viewport handles drive pointer and keyboard resize commits

// @vitest-environment happy-dom

import { act } from 'react'
import type { PreviewViewportSetting } from '@t3tools/contracts'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'
import { BrowserViewportResizeHandles } from '../../../../apps/web/src/browser/BrowserViewportResizeHandles'
import { subscribeBrowserViewportChange } from '../../../../apps/web/src/browser/browserViewportActions'
import { useBrowserViewportResize } from '../../../../apps/web/src/browser/useBrowserViewportResize'

function Harness()
{
  const resize = useBrowserViewportResize({
    tabId: 'top-resize',
    viewport: { _tag: 'freeform', width: 800, height: 600 },
    zoomFactor: 1,
    containerSize: { width: 1200, height: 900 },
    deviceToolbarVisible: true,
    aspectRatio: null,
  })
  return (
    <BrowserViewportResizeHandles
      layout={resize.layout}
      activeDirection={resize.activeDrag?.direction ?? null}
      onPointerDown={resize.handleResizePointerDown}
      onKeyDown={resize.handleResizeKeyDown}
    />
  )
}

it('exposes all eight handles and commits north-side pointer and keyboard resizes', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const committed = vi.fn<(viewport: PreviewViewportSetting) => Promise<void>>(
    async () => undefined,
  )
  const stop = subscribeBrowserViewportChange('top-resize', committed)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try
  {
    await act(async () => root.render(<Harness />))
    const handle = (edge: string) =>
      container.querySelector<HTMLButtonElement>(
        `[aria-label^="Resize browser viewport from ${edge}"]`,
      )
    expect(container.querySelectorAll('button')).toHaveLength(8)
    const north = handle('top edge')
    expect(north).not.toBeNull()
    await act(async () =>
      north!.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 1,
          clientX: 500,
          clientY: 150,
        }),
      ),
    )
    await act(async () =>
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 500, clientY: 130 }),
      ),
    )
    await act(async () => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 })))
    expect(committed).toHaveBeenCalledTimes(1)
    expect(committed.mock.calls[0]?.[0]).toMatchObject({ _tag: 'freeform', width: 800 })
    const pointerResult = committed.mock.calls[0]![0]
    expect('height' in pointerResult && pointerResult.height > 600).toBe(true)

    for (const [edge, key] of [
      ['top-left corner', 'ArrowLeft'],
      ['top-right corner', 'ArrowRight'],
    ] as const)
    {
      const corner = handle(edge)
      expect(corner).not.toBeNull()
      await act(async () =>
        corner!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })),
      )
      await act(async () => new Promise((resolve) => setTimeout(resolve, 180)))
      expect(committed).toHaveBeenLastCalledWith({ _tag: 'freeform', width: 810, height: 600 })
    }
    expect(committed).toHaveBeenCalledTimes(3)
  }
  finally
  {
    await act(async () => root.unmount())
    container.remove()
    stop()
    vi.unstubAllGlobals()
  }
})
