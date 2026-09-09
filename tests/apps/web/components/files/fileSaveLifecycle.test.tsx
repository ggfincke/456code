// tests/apps/web/components/files/fileSaveLifecycle.test.tsx
// verify retired file callbacks cannot write into a replacement file

// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { AsyncResult } from 'effect/unstable/reactivity'
import { act, StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

const fixture = vi.hoisted(() => ({ writeFile: vi.fn(), confirm: vi.fn() }))
vi.mock('../../../../../apps/web/src/state/use-atom-command', () => ({
  useAtomCommand: () => fixture.writeFile,
}))
vi.mock('../../../../../apps/web/src/components/files/projectFilesQueryState', () => ({
  confirmProjectFileQueryData: fixture.confirm,
}))
import { useFileSaveCoordinator } from '../../../../../apps/web/src/components/files/EditableFileSurface'

it('replays setup safely and retires callbacks across identity changes and unmount', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fixture.writeFile.mockResolvedValue(AsyncResult.success(undefined))
  const container = document.createElement('div')
  const root = createRoot(container)
  const onPendingChange = vi.fn()
  const threadRef = {
    environmentId: EnvironmentId.make('file-lifecycle'),
    threadId: ThreadId.make('file-lifecycle'),
  }
  let change: (contents: string) => void = () => undefined
  function Harness(props: { relativePath: string })
  {
    const coordinator = useFileSaveCoordinator({
      ...props,
      cwd: '/workspace',
      environmentId: threadRef.environmentId,
      threadRef,
      onPendingChange,
    })
    useLayoutEffect(() =>
    {
      change = coordinator.change
    }, [coordinator])
    return null
  }
  try
  {
    act(() =>
      root.render(
        <StrictMode>
          <Harness relativePath="first.md" />
        </StrictMode>,
      ),
    )
    const retired = change
    retired('first edit')
    act(() =>
      root.render(
        <StrictMode>
          <Harness relativePath="second.md" />
        </StrictMode>,
      ),
    )
    retired('must not enter second file')
    change('second edit')
    await vi.advanceTimersByTimeAsync(500)
    expect(fixture.writeFile.mock.calls.map(([request]) => request.input)).toEqual([
      { cwd: '/workspace', relativePath: 'first.md', contents: 'first edit' },
      { cwd: '/workspace', relativePath: 'second.md', contents: 'second edit' },
    ])
    const unmounted = change
    act(() => root.unmount())
    unmounted('must not write after unmount')
    await vi.advanceTimersByTimeAsync(500)
    expect(fixture.writeFile).toHaveBeenCalledTimes(2)
  }
  finally
  {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
