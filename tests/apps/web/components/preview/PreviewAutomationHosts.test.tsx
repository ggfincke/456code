// tests/apps/web/components/preview/PreviewAutomationHosts.test.tsx
// verify activity ownership through mounted preview automation hosts

// @vitest-environment happy-dom

import { RegistryContext } from '@effect/atom-react'
import {
  EnvironmentId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationStatus,
  type PreviewAutomationStreamEvent,
  ThreadId,
} from '@t3tools/contracts'
import { AsyncResult, Atom, AtomRegistry } from 'effect/unstable/reactivity'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  requestsAtom: undefined as
    Atom.Writable<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>> | undefined,
  listAtom: undefined as Atom.Atom<void> | undefined,
  sessionsAvailable: true,
  listPreviews: vi.fn(),
  status: vi.fn(async (_tabId: string): Promise<PreviewAutomationStatus> => ({
    available: true,
    visible: true,
    tabId: _tabId,
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
  })),
  evaluate: vi.fn(async (_tabId: string, _input: unknown): Promise<unknown> => 'evaluated'),
  respond: vi.fn(async (_target: { input: PreviewAutomationResponse }) => undefined),
  command: vi.fn(),
}))

vi.mock('~/env', () => ({ isElectron: true }))
vi.mock('~/state/environments', () => ({
  useEnvironments: () => ({ environments: [{ environmentId: 'environment-1' }] }),
}))
vi.mock('~/state/preview', () => ({
  previewEnvironment: {
    automationRequests: () => mocks.requestsAtom,
    list: () => mocks.listAtom,
    open: mocks.command,
    resize: mocks.command,
    respondToAutomation: mocks.respond,
    focusAutomationHost: mocks.command,
  },
}))
vi.mock('~/state/use-atom-command', () => ({ useAtomCommand: (command: unknown) => command }))
vi.mock('~/state/use-atom-query-runner', () => ({ useAtomQueryRunner: () => mocks.listPreviews }))
vi.mock('~/previewStateStore', () => ({
  readThreadPreviewState: () => ({
    serverEpoch: 'epoch-1',
    sessions: mocks.sessionsAvailable
      ? {
          tab_1: {
            threadId: 'thread-1',
            tabId: 'tab_1',
            navStatus: { _tag: 'Success', url: 'https://example.com/', title: 'Example' },
          },
        }
      : {},
    desktopByTabId: { tab_1: { hasWebContents: true } },
  }),
  applyPreviewServerSnapshot: vi.fn(),
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}))
vi.mock('~/rightPanelStore', () => ({ useRightPanelStore: { getState: vi.fn() } }))
vi.mock('~/browser/browserDefaults', () => ({
  browserDefaultOpenViewport: vi.fn(),
  resolveBrowserDefaults: vi.fn(),
}))
vi.mock('~/browser/browserTargetResolver', () => ({ resolveBrowserNavigationTarget: vi.fn() }))
vi.mock('~/browser/previewBridge', () => ({
  previewBridge: { automation: { status: mocks.status, evaluate: mocks.evaluate } },
}))
vi.mock('~/browser/browserRecording', () => ({
  readActiveBrowserRecordingTargets: vi.fn(),
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
}))

import { useBrowserSurfaceStore } from '../../../../../apps/web/src/browser/browserSurfaceStore'
import { previewRuntimeTabId } from '../../../../../apps/web/src/browser/previewRuntimeTabId'
import { PreviewAutomationHosts } from '../../../../../apps/web/src/components/preview/PreviewAutomationHosts'

const threadRef = {
  environmentId: EnvironmentId.make('environment-1'),
  threadId: ThreadId.make('thread-1'),
}
const runtimeTabId = previewRuntimeTabId(threadRef, 'epoch-1', 'tab_1')

describe('PreviewAutomationHosts activity', () =>
{
  let registry: AtomRegistry.AtomRegistry
  let root: Root
  let container: HTMLDivElement
  let wrapper: HTMLDivElement
  let executeJavaScript: ReturnType<typeof vi.fn>

  const dispatch = async (
    requestId: string,
    operation: PreviewAutomationRequest['operation'],
    connectionId = 'connection-1',
  ) =>
  {
    await act(async () =>
    {
      registry.set(
        mocks.requestsAtom!,
        AsyncResult.success({
          type: 'request',
          connectionId,
          request: {
            requestId,
            threadId: threadRef.threadId,
            tabId: 'tab_1',
            operation,
            input: operation === 'evaluate' ? { expression: 'document.title' } : {},
            timeoutMs: 15_000,
          },
        }),
      )
    })
  }

  beforeEach(async () =>
  {
    vi.clearAllMocks()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} })
    mocks.requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    )
    mocks.listAtom = Atom.make(undefined)
    mocks.sessionsAvailable = true
    registry = AtomRegistry.make()
    container = document.createElement('div')
    wrapper = document.createElement('div')
    wrapper.setAttribute('data-preview-rendering', 'suspended')
    const webview = document.createElement('webview')
    webview.setAttribute('data-preview-tab', runtimeTabId)
    executeJavaScript = vi.fn(async () => ({ width: 800, height: 600 }))
    Object.assign(webview, { executeJavaScript })
    wrapper.append(webview)
    document.body.append(container, wrapper)
    root = createRoot(container)
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <PreviewAutomationHosts />
        </RegistryContext.Provider>,
      ),
    )
  })

  afterEach(async () =>
  {
    await act(async () => root.unmount())
    registry.dispose()
    container.remove()
    wrapper.remove()
    vi.useRealTimers()
  })

  it('keeps passive hidden status reads out of the guest JavaScript runtime', async () =>
  {
    await dispatch('hidden-status', 'status')
    await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledOnce())

    expect(executeJavaScript).not.toHaveBeenCalled()
    expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({})
    expect(mocks.respond).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ tabId: 'tab_1', visible: false }),
      }),
    })
  })

  it('leases before waiting for a rendered guest and releases after failures and success', async () =>
  {
    mocks.evaluate.mockImplementationOnce(async () =>
    {
      expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1)
      throw new Error('guest evaluation failed')
    })
    await dispatch('failed-evaluation', 'evaluate')

    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1)
    expect(mocks.status).not.toHaveBeenCalled()
    expect(mocks.evaluate).not.toHaveBeenCalled()
    wrapper.setAttribute('data-preview-rendering', 'active')
    await act(async () =>
    {
      await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledOnce())
    })
    expect(mocks.respond.mock.calls[0]?.[0].input.ok).toBe(false)
    expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({})

    mocks.status.mockImplementationOnce(async (tabId) =>
    {
      expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1)
      return { available: true, visible: true, tabId, url: null, title: null, loading: false }
    })
    await dispatch('successful-evaluation', 'evaluate')
    await vi.waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(2))
    expect(mocks.respond.mock.calls[1]?.[0].input).toMatchObject({ ok: true, result: 'evaluated' })
    expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({})
  })

  it('expires hung work and invalidates replaced or removed hosts without late lease acquisition', async () =>
  {
    vi.useFakeTimers()
    wrapper.setAttribute('data-preview-rendering', 'active')
    mocks.evaluate.mockImplementationOnce(() => new Promise(() =>
    {}))
    await dispatch('never-settles', 'evaluate')
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1)

    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({})

    let finishOldEvaluation: ((value: unknown) => void) | undefined
    mocks.evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
        {
          finishOldEvaluation = resolve
        }),
    )
    await dispatch('old-connection', 'evaluate')
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1)
    await act(async () =>
      registry.set(
        mocks.requestsAtom!,
        AsyncResult.success({
          type: 'connected',
          connectionId: 'connection-2',
        }),
      ),
    )
    expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({})

    mocks.evaluate.mockImplementationOnce(() => new Promise(() =>
    {}))
    await dispatch('new-connection', 'evaluate', 'connection-2')
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1)
    await act(async () => finishOldEvaluation?.('late result'))
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1)

    mocks.sessionsAvailable = false
    let finishList: ((value: unknown) => void) | undefined
    mocks.listPreviews.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
        {
          finishList = resolve
        }),
    )
    await dispatch('delayed-list', 'evaluate', 'connection-2')
    expect(mocks.listPreviews).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({})

    mocks.sessionsAvailable = true
    await act(async () => finishList?.({ _tag: 'Success', value: {} }))
    expect(useBrowserSurfaceStore.getState().activityByTabId).toEqual({})
    expect(mocks.evaluate).toHaveBeenCalledTimes(3)
  })
})
