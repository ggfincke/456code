// tests/apps/web/browser/desktopTabLifetime.test.ts
// verify desktop tab lifetime behavior

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const { closeTab, createTab } = vi.hoisted(() => ({
  closeTab: vi.fn(async () => undefined),
  createTab: vi.fn<() => Promise<void>>(),
}))

vi.mock('~/browser/previewBridge', () => ({
  previewBridge: { closeTab, createTab },
}))

import { acquireDesktopTab } from '../../../../apps/web/src/browser/desktopTabLifetime'

describe('desktopTabLifetime', () =>
{
  beforeEach(() =>
  {
    closeTab.mockClear()
    createTab.mockClear()
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

    expect(createTab).toHaveBeenCalledOnce()
    expect(first.ready).toBe(second.ready)

    let ready = false
    void first.ready.then(() =>
    {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    resolveCreation?.()
    await first.ready
    expect(ready).toBe(true)
  })
})
