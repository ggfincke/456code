// tests/apps/web/hooks/useResizableWidth.test.tsx
// verify interrupted resize ownership and successful final width persistence

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'
import { useResizableWidth } from '../../../../apps/web/src/hooks/useResizableWidth'

function Panel()
{
  const resize = useResizableWidth({
    storageKey: 'resize-ownership-test',
    defaultWidth: 400,
    minWidth: 200,
    maxWidth: 800,
    edge: 'left',
  })
  return <div data-width={resize.width} {...resize.handlers} />
}

it('cancels lost-capture, blur, and hidden-page drags without saving, then commits once on normal release', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.removeItem('resize-ownership-test')
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  {
    frame = callback
    return 42
  })
  const cancelFrame = vi.fn()
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const visibility = vi.spyOn(document, 'visibilityState', 'get')
  try
  {
    await act(async () => root.render(<Panel />))
    const handle = container.firstElementChild as HTMLDivElement
    let captured = false
    handle.setPointerCapture = () =>
    {
      captured = true
    }
    handle.hasPointerCapture = () => captured
    handle.releasePointerCapture = () =>
    {
      captured = false
      handle.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }))
    }
    const pointer = (type: string, x: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x }),
      )
    for (const interruption of ['blur', 'lostpointercapture', 'hidden'])
    {
      await act(async () =>
      {
        pointer('pointerdown', 100)
        pointer('pointermove', 50)
        frame?.(0)
      })
      expect(handle.dataset.width).toBe('450')
      await act(async () => pointer('pointermove', 25))
      expect(document.body.style.cursor).toBe('col-resize')
      await act(async () =>
      {
        if (interruption === 'blur') window.dispatchEvent(new Event('blur'))
        else if (interruption === 'hidden')
        {
          visibility.mockReturnValue('hidden')
          document.dispatchEvent(new Event('visibilitychange'))
        }
        else pointer('lostpointercapture', 25)
      })
      expect(document.body.style.cursor).toBe('')
      expect(document.body.style.userSelect).toBe('')
      expect(handle.dataset.width).toBe('400')
      expect(captured).toBe(false)
      expect(cancelFrame).toHaveBeenCalledWith(42)
      expect(localStorage.getItem('resize-ownership-test')).toBeNull()
    }
    await act(async () =>
    {
      pointer('pointerdown', 100)
      pointer('pointermove', 50)
      pointer('pointerup', 50)
    })
    expect(handle.dataset.width).toBe('450')
    expect(localStorage.getItem('resize-ownership-test')).toBe('450')
    expect(document.body.style.cursor).toBe('')
  }
  finally
  {
    await act(async () => root.unmount())
    container.remove()
    localStorage.removeItem('resize-ownership-test')
    visibility.mockRestore()
    vi.unstubAllGlobals()
  }
})
