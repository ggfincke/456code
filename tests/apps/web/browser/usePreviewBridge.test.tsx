// tests/apps/web/browser/usePreviewBridge.test.tsx
// verify favicon projection and metadata-hydration bridge behavior

// @vitest-environment happy-dom

import { scopeProjectRef, scopeThreadRef } from '@t3tools/client-runtime/environment'
import {
  type DesktopPreviewFavicon,
  type DesktopPreviewTabState,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from '@t3tools/contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  applyDesktopState: vi.fn(),
  clearPointer: vi.fn(),
  flushPending: vi.fn(),
  listener: null as ((tabId: string, state: DesktopPreviewTabState) => void) | null,
  onStateChange: vi.fn(),
  preparedConnection: { _tag: 'None' } as
    | { readonly _tag: 'None' }
    | { readonly _tag: 'Some'; readonly value: { readonly httpBaseUrl: string } },
  projectRef: null as ReturnType<typeof scopeProjectRef> | null,
  recordFavicon: vi.fn(),
  reportStatus: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('../../../../apps/web/src/browser/browserFaviconStore', () => ({
  flushPendingFaviconsForThread: mocks.flushPending,
  recordFaviconForThread: mocks.recordFavicon,
  useFaviconProjectRefForThread: () => mocks.projectRef,
}))
vi.mock('../../../../apps/web/src/browser/browserPointerStore', () => ({
  useBrowserPointerStore: (
    select: (state: { readonly clear: typeof mocks.clearPointer }) => unknown,
  ) => select({ clear: mocks.clearPointer }),
}))
vi.mock('../../../../apps/web/src/browser/previewBridge', () => ({
  previewBridge: { onStateChange: mocks.onStateChange },
}))
vi.mock('../../../../apps/web/src/browser/previewStateStore', () => ({
  applyPreviewDesktopState: mocks.applyDesktopState,
}))
vi.mock('~/state/preview', () => ({ previewEnvironment: { reportStatus: Symbol('report') } }))
vi.mock('~/state/session', () => ({ usePreparedConnection: () => mocks.preparedConnection }))
vi.mock('~/state/use-atom-command', () => ({ useAtomCommand: () => mocks.reportStatus }))

import {
  projectDesktopState,
  usePreviewBridge,
} from '../../../../apps/web/src/browser/usePreviewBridge'

const environmentId = EnvironmentId.make('env-1')
const threadRef = scopeThreadRef(environmentId, ThreadId.make('thread-1'))
const projectRef = scopeProjectRef(environmentId, ProjectId.make('project-1'))
const runtimeTabId = JSON.stringify([environmentId, threadRef.threadId, 'server-a', 'tab-1'])
const favicon: DesktopPreviewFavicon = {
  dataUrl: 'data:image/png;base64,AAAA',
  pageUrl: 'http://localhost:3000/app',
  capturedAt: 1,
}

const state = (
  navStatus: DesktopPreviewTabState['navStatus'],
  overrides: Partial<DesktopPreviewTabState> = {},
): DesktopPreviewTabState => ({
  tabId: 'tab-1',
  webContentsId: 1,
  navStatus,
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  colorScheme: 'system',
  audioMuted: false,
  audible: false,
  controller: 'none',
  favicon,
  updatedAt: '2026-08-16T00:00:00.000Z',
  ...overrides,
})

let root: Root | null = null
let container: HTMLDivElement | null = null

const Harness = (props: { readonly revision: number }) =>
{
  usePreviewBridge({ threadRef, tabId: 'tab-1', runtimeTabId })
  return <span>{props.revision}</span>
}

beforeEach(() =>
{
  mocks.applyDesktopState.mockReset()
  mocks.clearPointer.mockReset()
  mocks.flushPending.mockReset()
  mocks.listener = null
  mocks.onStateChange
    .mockReset()
    .mockImplementation((listener: (tabId: string, state: DesktopPreviewTabState) => void) =>
    {
      mocks.listener = listener
      return mocks.unsubscribe
    })
  mocks.preparedConnection = { _tag: 'None' }
  mocks.projectRef = null
  mocks.recordFavicon.mockReset()
  mocks.reportStatus.mockReset()
  mocks.unsubscribe.mockReset()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(async () =>
{
  if (root)
  {
    await act(async () => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
})

describe('usePreviewBridge favicon behavior', () =>
{
  it('projects a capture only for the current document origin', () =>
  {
    expect(
      projectDesktopState(
        state({ kind: 'Loading', url: 'http://localhost:3000/reload', title: '' }),
      ),
    ).toMatchObject({ hasWebContents: true, favicon })
    expect(
      projectDesktopState(state({ kind: 'Success', url: 'https://example.com/', title: 'Example' }))
        .favicon,
    ).toBeNull()
    expect(
      projectDesktopState(
        state(
          { kind: 'Success', url: 'data:text/html,preview', title: 'Opaque' },
          { favicon: { ...favicon, pageUrl: 'about:blank' } },
        ),
      ).favicon,
    ).toBeNull()
    expect(
      projectDesktopState(
        state(
          { kind: 'Success', url: 'ftp://example.com/', title: 'FTP' },
          { favicon: { ...favicon, pageUrl: 'ftp://example.com/favicon.ico' } },
        ),
      ).favicon,
    ).toBeNull()
    expect(projectDesktopState(state({ kind: 'Idle' })).favicon).toBeNull()
  })

  it('buffers captures before metadata and flushes without resetting report dedupe', async () =>
  {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<Harness revision={0} />))

    const initial = state({ kind: 'Success', url: 'http://localhost:3000/', title: 'Home' })
    await act(async () => mocks.listener?.(runtimeTabId, initial))
    await act(async () => mocks.listener?.(runtimeTabId, initial))
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, 'tab-1', expect.any(Object))
    expect(mocks.recordFavicon).toHaveBeenLastCalledWith(threadRef, favicon, null, undefined)
    expect(mocks.reportStatus).toHaveBeenCalledTimes(1)
    expect(mocks.flushPending).not.toHaveBeenCalled()

    mocks.projectRef = projectRef
    mocks.preparedConnection = {
      _tag: 'Some',
      value: { httpBaseUrl: 'http://192.168.64.2:3773' },
    }
    await act(async () => root?.render(<Harness revision={1} />))

    expect(mocks.flushPending).toHaveBeenCalledWith(threadRef, projectRef, '192.168.64.2')
    expect(mocks.onStateChange).toHaveBeenCalledTimes(1)
    await act(async () => mocks.listener?.(runtimeTabId, initial))
    expect(mocks.recordFavicon).toHaveBeenLastCalledWith(
      threadRef,
      favicon,
      projectRef,
      '192.168.64.2',
    )
    expect(mocks.reportStatus).toHaveBeenCalledTimes(1)

    const titleChanged = state({
      kind: 'Success',
      url: 'http://localhost:3000/',
      title: 'Dashboard',
    })
    await act(async () => mocks.listener?.(runtimeTabId, titleChanged))
    expect(mocks.reportStatus).toHaveBeenCalledTimes(2)
    expect(mocks.reportStatus).toHaveBeenLastCalledWith({
      environmentId,
      input: expect.objectContaining({
        canGoBack: false,
        navStatus: expect.objectContaining({ title: 'Dashboard' }),
      }),
    })

    await act(async () => mocks.listener?.(runtimeTabId, { ...titleChanged, canGoBack: true }))
    expect(mocks.reportStatus).toHaveBeenCalledTimes(3)
    expect(mocks.reportStatus).toHaveBeenLastCalledWith({
      environmentId,
      input: expect.objectContaining({ canGoBack: true }),
    })

    await act(async () => root?.unmount())
    root = null
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
