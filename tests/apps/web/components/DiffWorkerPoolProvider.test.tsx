// tests/apps/web/components/DiffWorkerPoolProvider.test.tsx
// verify demand-mounted code waits for its worker pool and falls back after failure

// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

const fixture = vi.hoisted(() => ({
  mounted: vi.fn(),
  initialize: vi.fn<() => Promise<void>>(),
}))
vi.mock('@pierre/diffs/react', () => ({
  WorkerPoolContextProvider: ({
    children,
    highlighterOptions,
  }: {
    children: ReactNode
    highlighterOptions: unknown
  }) =>
  {
    fixture.mounted(highlighterOptions)
    return children
  },
  useWorkerPool: () => ({
    isInitialized: () => false,
    isWorkingPool: () => true,
    initialize: fixture.initialize,
    getDiffRenderOptions: () => ({ theme: 'pierre-dark' }),
  }),
}))
vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({ default: vi.fn() }))
vi.mock('../../../../apps/web/src/hooks/useSyntaxThemeName', () => ({
  useSyntaxThemeName: () => 'pierre-dark',
}))

import { DiffWorkerPoolProvider } from '../../../../apps/web/src/components/DiffWorkerPoolProvider'

it('starts only at code demand and renders plain code after initialization failure', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let rejectInitialization: (cause: Error) => void = () => undefined
  fixture.initialize.mockReturnValue(
    new Promise<void>((_resolve, reject) =>
    {
      rejectInitialization = reject
    }),
  )
  const container = document.createElement('div')
  const root = createRoot(container)
  try
  {
    await act(async () => root.render(<div>Conversation</div>))
    expect(fixture.mounted).not.toHaveBeenCalled()
    await act(async () =>
      root.render(
        <DiffWorkerPoolProvider>
          <pre>plain file</pre>
        </DiffWorkerPoolProvider>,
      ),
    )
    expect(fixture.initialize).toHaveBeenCalledTimes(1)
    expect(fixture.mounted).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferredHighlighter: 'shiki-wasm' }),
    )
    expect(container.textContent).toBe('Loading code...')
    await act(async () => rejectInitialization(new Error('worker unavailable')))
    expect(container.querySelector('pre')?.textContent).toBe('plain file')
  }
  finally
  {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
