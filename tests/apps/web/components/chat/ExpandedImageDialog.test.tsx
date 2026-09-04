// tests/apps/web/components/chat/ExpandedImageDialog.test.tsx
// verify image closing preserves the conversation owner's focus destination

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

import { ExpandedImageDialog } from '../../../../../apps/web/src/components/chat/ExpandedImageDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('ExpandedImageDialog', () =>
{
  it('returns keyboard and pointer close control to the composer owner', async () =>
  {
    const container = document.createElement('div')
    const opener = document.createElement('button')
    const composer = document.createElement('textarea')
    document.body.append(opener, composer, container)
    const root = createRoot(container)
    const close = vi.fn(() =>
    {
      root.render(null)
      composer.focus()
    })
    const render = async () =>
    {
      opener.focus()
      await act(async () =>
      {
        root.render(
          <ExpandedImageDialog
            preview={{
              index: 0,
              images: [{ src: 'https://example.test/image.png', name: 'Diagram' }],
            }}
            onClose={close}
          />,
        )
      })
    }

    try
    {
      await render()
      expect(container.querySelector('[role="dialog"]')?.classList.contains('z-[60]')).toBe(true)
      await act(async () =>
      {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      })
      expect(close).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(composer)

      await render()
      await act(async () =>
      {
        container.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')?.click()
      })
      expect(close).toHaveBeenCalledTimes(2)
      expect(document.activeElement).toBe(composer)
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
      opener.remove()
      composer.remove()
    }
  })
})
