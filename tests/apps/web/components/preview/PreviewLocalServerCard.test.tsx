// tests/apps/web/components/preview/PreviewLocalServerCard.test.tsx
// verify local server favicon persistence and visual fallback

// @vitest-environment happy-dom

import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { PreviewableServer } from '../../../../../apps/web/src/components/preview/useDiscoveredLocalServers'

const mocks = vi.hoisted(() => ({ favicon: null as string | null }))

vi.mock('~/browser/browserFaviconStore', () => ({
  useFaviconForThreadUrl: () => mocks.favicon,
}))

import { PreviewLocalServerCard } from '../../../../../apps/web/src/components/preview/PreviewLocalServerCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const threadRef = scopeThreadRef(EnvironmentId.make('env-1'), ThreadId.make('thread-1'))
const server: PreviewableServer = {
  host: 'localhost',
  port: 5173,
  url: 'http://localhost:5173/app',
  processName: 'vite',
  pid: 1234,
  terminal: null,
  source: 'scanner',
  listening: true,
}

beforeEach(() =>
{
  mocks.favicon = null
})

describe('PreviewLocalServerCard', () =>
{
  it('uses a persisted capture before same-origin and BrowserMockup fallbacks', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = () =>
      root.render(
        <PreviewLocalServerCard
          key={mocks.favicon ?? 'no-capture'}
          threadRef={threadRef}
          server={server}
          onOpen={() => undefined}
        />,
      )

    mocks.favicon = 'data:image/png;base64,AAAA'
    act(render)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')

    mocks.favicon = null
    act(render)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'http://localhost:5173/favicon.ico',
    )
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('div[aria-hidden]')).not.toBeNull()

    act(() => root.unmount())
    container.remove()
  })
})
