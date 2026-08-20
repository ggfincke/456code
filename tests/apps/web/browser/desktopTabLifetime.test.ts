// tests/apps/web/browser/desktopTabLifetime.test.ts
// verify desktop tab lifetime behavior

import {
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  ThreadId,
} from '@t3tools/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const { closeTab, createTab } = vi.hoisted(() => ({
  closeTab: vi.fn(async () => undefined),
  createTab: vi.fn<() => Promise<void>>(),
}))

vi.mock('~/browser/previewBridge', () => ({
  previewBridge: { closeTab, createTab },
}))

import { acquireDesktopTab } from '../../../../apps/web/src/browser/desktopTabLifetime'
import { previewRuntimeTabId } from '../../../../apps/web/src/browser/previewRuntimeTabId'

const DEFAULT_TAB_STATE = {
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  colorScheme: DEFAULT_PREVIEW_APPEARANCE,
}

describe('desktopTabLifetime', () =>
{
  beforeEach(() =>
  {
    vi.stubGlobal('window', {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    })
    closeTab.mockClear()
    createTab.mockClear()
  })

  afterEach(() =>
  {
    vi.unstubAllGlobals()
  })

  it('shares tab creation readiness across concurrent leases', async () =>
  {
    let resolveCreation: (() => void) | undefined
    createTab.mockReturnValueOnce(
      new Promise<void>((resolve) =>
      {
        resolveCreation = resolve
      }),
    )

    const first = acquireDesktopTab('tab_readiness')
    const second = acquireDesktopTab('tab_readiness')

    expect(first.ready).toBe(second.ready)

    let ready = false
    void first.ready.then(() =>
    {
      ready = true
    })
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledOnce())
    expect(createTab).toHaveBeenCalledWith('tab_readiness', DEFAULT_TAB_STATE)
    expect(ready).toBe(false)

    resolveCreation?.()
    await first.ready
    expect(ready).toBe(true)
  })

  it('serializes a released pending creation before a replacement lease', async () =>
  {
    const operations: string[] = []
    let resolveFirstCreation: (() => void) | undefined
    createTab
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) =>
          {
            operations.push('create:first')
            resolveFirstCreation = resolve
          }),
      )
      .mockImplementationOnce(async () =>
      {
        operations.push('create:second')
      })
    closeTab.mockImplementationOnce(async () =>
    {
      operations.push('close')
    })

    const first = acquireDesktopTab('tab_release_race')
    first.release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const second = acquireDesktopTab('tab_release_race')
    expect(operations).toEqual(['create:first'])

    resolveFirstCreation?.()
    await Promise.all([first.ready, second.ready])
    expect(operations).toEqual(['create:first', 'close', 'create:second'])
  })

  it('keeps identical server tab ids in separate desktop runtime slots', async () =>
  {
    vi.useFakeTimers()
    createTab.mockResolvedValue(undefined)
    const firstTab = previewRuntimeTabId(
      {
        environmentId: EnvironmentId.make('environment-a'),
        threadId: ThreadId.make('thread-a'),
      },
      'epoch-a',
      'tab_1',
    )
    const secondTab = previewRuntimeTabId(
      {
        environmentId: EnvironmentId.make('environment-b'),
        threadId: ThreadId.make('thread-b'),
      },
      'epoch-b',
      'tab_1',
    )

    const first = acquireDesktopTab(firstTab)
    const second = acquireDesktopTab(secondTab)
    await Promise.all([first.ready, second.ready])

    expect(createTab).toHaveBeenCalledWith(firstTab, DEFAULT_TAB_STATE)
    expect(createTab).toHaveBeenCalledWith(secondTab, DEFAULT_TAB_STATE)
    first.release()
    second.release()
    await vi.advanceTimersByTimeAsync(0)
  })
})
