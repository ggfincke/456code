// tests/apps/web/browser/HostedBrowserWebview.test.tsx
// verify hosted browser teardown behavior

// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  stopBrowserRecording: vi.fn(async () => null),
}))

vi.mock('../../../../apps/web/src/browser/browserRecording', () => ({
  stopBrowserRecording: mocks.stopBrowserRecording,
  useActiveBrowserRecordingTabId: () => 'runtime-tab-1',
}))
vi.mock('../../../../apps/web/src/browser/browserSurfaceStore', () => ({
  resolveBrowserSurfacePanelRect: () => null,
  useBrowserSurfaceStore: (select: (state: unknown) => unknown) =>
    select({ byTabId: { 'runtime-tab-1': { visible: true } } }),
}))
vi.mock('../../../../apps/web/src/browser/BrowserDeviceToolbar', () => ({
  BrowserDeviceToolbar: () => null,
}))
vi.mock('../../../../apps/web/src/browser/BrowserViewportResizeHandles', () => ({
  BrowserViewportResizeHandles: () => null,
}))
vi.mock('../../../../apps/web/src/browser/desktopTabLifetime', () => ({
  acquireDesktopTab: () => ({ ready: Promise.resolve(), release: mocks.release }),
}))
vi.mock('../../../../apps/web/src/browser/previewBridge', () => ({ previewBridge: undefined }))
vi.mock('../../../../apps/web/src/browser/previewWebviewConfigState', () => ({
  usePreviewWebviewConfig: () => undefined,
}))
vi.mock('../../../../apps/web/src/browser/usePreviewBridge', () => ({
  usePreviewBridge: () => undefined,
}))
vi.mock('../../../../apps/web/src/browser/useBrowserViewportResize', () => ({
  useBrowserViewportResize: () => ({
    activeDrag: null,
    commitViewportChange: vi.fn(),
    effectiveViewport: { _tag: 'fill' },
    handleResizeKeyDown: vi.fn(),
    handleResizePointerDown: vi.fn(),
    layout: {
      canvasHeight: 1,
      canvasWidth: 1,
      viewportHeight: 1,
      viewportScale: 1,
      viewportWidth: 1,
      viewportX: 0,
      viewportY: 0,
    },
  }),
}))
vi.mock('../../../../apps/web/src/lib/utils', () => ({
  cn: (...values: ReadonlyArray<string | false | null | undefined>) =>
    values.filter(Boolean).join(' '),
}))

import { HostedBrowserWebview } from '../../../../apps/web/src/browser/HostedBrowserWebview'

describe('HostedBrowserWebview', () =>
{
  it('stops an active recording before releasing a removed runtime tab', async () =>
  {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () =>
      root.render(
        <HostedBrowserWebview
          threadRef={{
            environmentId: EnvironmentId.make('environment-1'),
            threadId: ThreadId.make('thread-1'),
          }}
          tabId="server-tab-1"
          runtimeTabId="runtime-tab-1"
          initialUrl={null}
          viewport={{ _tag: 'fill' }}
          zoomFactor={1}
        />,
      ),
    )

    expect(mocks.stopBrowserRecording).not.toHaveBeenCalled()
    await act(async () => root.unmount())

    expect(mocks.stopBrowserRecording).toHaveBeenCalledOnce()
    expect(mocks.stopBrowserRecording).toHaveBeenCalledWith('runtime-tab-1')
    expect(mocks.release).toHaveBeenCalledOnce()
    expect(mocks.stopBrowserRecording.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0]!,
    )
    container.remove()
  })
})
