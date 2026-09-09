// tests/apps/web/components/markdown/codeBlocks.test.tsx
// verify safe code-highlighter initialization and accessible table scrolling

// @vitest-environment happy-dom

import { act, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

const fixture = vi.hoisted(() => ({ highlighter: vi.fn() }))
vi.mock('@pierre/diffs', () => ({ getSharedHighlighter: fixture.highlighter }))
vi.mock('../../../../../apps/web/src/hooks/useSettings', () => ({
  getClientSettings: () => ({ wordWrap: false }),
}))
vi.mock('../../../../../apps/web/src/components/ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    hideScrollbars = false,
  }: {
    children: ReactNode
    hideScrollbars?: boolean
  }) => <div data-hide-scrollbars={String(hideScrollbars)}>{children}</div>,
}))

import {
  MarkdownTable,
  SuspenseShikiCodeBlock,
} from '../../../../../apps/web/src/components/markdown/codeBlocks'

it('uses wasm for initial and fallback grammar initialization before rendering code', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.highlighter
    .mockRejectedValueOnce(new Error('unsupported grammar'))
    .mockResolvedValueOnce({
      codeToHtml: () => '<pre><code>safe code</code></pre>',
    })
  const container = document.createElement('div')
  const root = createRoot(container)
  try
  {
    await act(async () =>
      root.render(
        <Suspense fallback="Loading">
          <SuspenseShikiCodeBlock
            className="language-unlisted-language"
            code="safe code"
            themeName="pierre-dark"
          />
        </Suspense>,
      ),
    )
    expect(fixture.highlighter.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ preferredHighlighter: 'shiki-wasm', langs: ['unlisted-language'] }),
      expect.objectContaining({ preferredHighlighter: 'shiki-wasm', langs: ['text'] }),
    ])
    expect(container.querySelector('code')?.textContent).toBe('safe code')
  }
  finally
  {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('leaves table scrollbars enabled without changing table content', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  try
  {
    await act(async () =>
      root.render(
        <MarkdownTable>
          <tbody>
            <tr>
              <td>Wide report column</td>
            </tr>
          </tbody>
        </MarkdownTable>,
      ),
    )
    expect(
      container.querySelector('[data-hide-scrollbars]')?.getAttribute('data-hide-scrollbars'),
    ).toBe('false')
    expect(container.querySelector('td')?.textContent).toBe('Wide report column')
  }
  finally
  {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
