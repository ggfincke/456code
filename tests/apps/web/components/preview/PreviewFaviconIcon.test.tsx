// tests/apps/web/components/preview/PreviewFaviconIcon.test.tsx
// verify ordered favicon failure and source-list reset behavior

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vite-plus/test'

import { FaviconImage } from '../../../../../apps/web/src/components/preview/PreviewFaviconIcon'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('FaviconImage', () =>
{
  it('advances after failure and resets when the ordered source list changes', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = (sources: ReadonlyArray<string>) =>
      root.render(<FaviconImage sources={sources} fallback={<span data-fallback>Browser</span>} />)

    act(() => render(['https://first.example/captured.png', 'https://first.example/favicon.ico']))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://first.example/captured.png',
    )

    act(() =>
    {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
      render(['https://second.example/captured.png', 'https://second.example/favicon.ico'])
    })
    expect(container.innerHTML).not.toContain('https://first.example/favicon.ico')
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://second.example/captured.png',
    )
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://second.example/favicon.ico',
    )
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')))
    expect(container.querySelector('[data-fallback]')?.textContent).toBe('Browser')

    act(() => root.unmount())
    container.remove()
  })
})
