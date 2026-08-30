// tests/apps/web/hooks/useWorkspaceMutationRefresh.test.tsx
// protect deferred workspace refresh and resource identity during local saves

// @vitest-environment happy-dom

import { EventId } from '@t3tools/contracts'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

import {
  latestWorkspaceMutationId,
  useWorkspaceMutationRefresh,
} from '../../../../apps/web/src/hooks/useWorkspaceMutationRefresh'

it('refreshes each terminal mutation once per resource after its save owner releases it', () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const completed = {
    id: EventId.make('completed'),
    kind: 'tool.completed',
    payload: { itemType: 'file_change' },
  }
  const streaming = {
    id: EventId.make('streaming'),
    kind: 'tool.updated',
    payload: { itemType: 'command_execution', status: 'inProgress' },
  }
  const firstMutation = latestWorkspaceMutationId([completed, streaming])
  expect(firstMutation).toBe('completed')
  const secondMutation = latestWorkspaceMutationId([
    completed,
    { ...streaming, payload: { itemType: 'command_execution', status: 'completed' } },
  ])
  expect(secondMutation).toBe('streaming')

  const refresh = vi.fn()
  const container = document.createElement('div')
  const root = createRoot(container)
  function Harness(props: { enabled: boolean; mutationId: string | null; resourceKey: string })
  {
    useWorkspaceMutationRefresh({ ...props, refresh })
    return null
  }
  const render = (enabled: boolean, mutationId: string | null, resourceKey = 'env-a:file-a') =>
    act(() =>
      root.render(
        <StrictMode>
          <Harness {...{ enabled, mutationId, resourceKey }} />
        </StrictMode>,
      ),
    )
  try
  {
    render(false, firstMutation)
    render(false, secondMutation)
    expect(refresh).not.toHaveBeenCalled()
    render(true, secondMutation)
    render(true, secondMutation)
    expect(refresh).toHaveBeenCalledTimes(1)
    render(true, secondMutation, 'env-b:file-a')
    expect(refresh).toHaveBeenCalledTimes(2)
    render(true, null, 'env-b:file-a')
    expect(refresh).toHaveBeenCalledTimes(2)
  }
  finally
  {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
