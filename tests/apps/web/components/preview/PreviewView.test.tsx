// tests/apps/web/components/preview/PreviewView.test.tsx
// verify preview view behavior

// @vitest-environment happy-dom

import {
  EnvironmentId,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
  ThreadId,
} from '@t3tools/contracts'
import { act, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  addImage: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  cancelPickElement: vi.fn(async (_tabId: string): Promise<void> => undefined),
  capturePreviewAnnotationScreenshot: vi.fn(),
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: 'http://172.25.85.75:3773' })),
  stackedThreadToast: vi.fn((toast: unknown) => toast),
  toastAdd: vi.fn(),
  submittedUrl: null as ((url: string) => void) | null,
  emptyStateUrl: null as ((url: string) => void) | null,
  pickElementAction: null as (() => void) | null,
  pickActive: false,
  showEmptyState: false,
  loading: false,
}))

vi.mock('~/state/session', () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}))

vi.mock('~/browser/browserDefaults', () => ({
  browserResponsiveViewportForToggle: () => ({ _tag: 'Fill' }),
  useBrowserDefaults: () => ({
    viewport: { _tag: 'Fill' },
    zoomFactor: 1,
    colorScheme: 'system',
    autoShowOnAgentNavigation: true,
  }),
}))

vi.mock('~/composerDraftStore', () => ({
  useComposerDraftStore: (
    select: (store: { addPreviewAnnotation: () => void; addImage: () => void }) => unknown,
  ) =>
    select({
      addPreviewAnnotation: mocks.addPreviewAnnotation,
      addImage: mocks.addImage,
    }),
}))

vi.mock('~/lib/previewAnnotation', () => ({
  capturePreviewAnnotationScreenshot: mocks.capturePreviewAnnotationScreenshot,
}))

vi.mock('~/localApi', () => ({
  ensureLocalApi: vi.fn(),
}))

vi.mock('~/previewStateStore', () => ({
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => ({
    activeTabId: 'tab-1',
    serverEpoch: null,
    desktopByTabId: {
      'tab-1': {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        colorScheme: 'system',
        audioMuted: false,
        audible: false,
        controller: 'none',
        favicon: null,
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          'tab-1': {
            threadId: 'thread-1',
            tabId: 'tab-1',
            navStatus: {
              _tag: 'Success',
              url: 'http://example.com/',
              title: 'Example',
            },
            canGoBack: false,
            canGoForward: false,
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        },
  }),
}))

vi.mock('~/state/environments', () => ({
  useEnvironment: () => ({ label: 'WSL' }),
  useEnvironmentHttpBaseUrl: () => 'http://172.25.85.75:3773',
}))

vi.mock('~/state/preview', () => ({
  previewEnvironment: { open: {}, resize: {} },
}))

vi.mock('~/state/use-atom-command', () => ({
  useAtomCommand: () => vi.fn(),
}))

vi.mock('~/browser/browserRecording', () => ({
  findActiveBrowserRecordingRuntimeTabId: vi.fn(() => null),
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
  useActiveBrowserRecordingTabId: () => null,
}))

vi.mock('~/browser/browserSurfaceStore', () => ({
  useBrowserSurfaceStore: (
    select: (state: { byTabId: Record<string, { rect?: unknown }> }) => unknown,
  ) => select({ byTabId: {} }),
}))

vi.mock('~/components/ui/toast', () => ({
  stackedThreadToast: mocks.stackedThreadToast,
  toastManager: { add: mocks.toastAdd },
}))

vi.mock('../../../../../apps/web/src/browser/previewBridge', () => ({
  previewBridge: {
    cancelPickElement: mocks.cancelPickElement,
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
  },
}))

vi.mock('../../../../../apps/web/src/components/preview/PreviewChromeRow', () => ({
  PreviewChromeRow: (props: {
    onSubmit: (url: string) => void
    onPickElement?: (() => void) | undefined
    pickActive?: boolean | undefined
  }) =>
  {
    mocks.submittedUrl = props.onSubmit
    mocks.pickElementAction = props.onPickElement ?? null
    mocks.pickActive = props.pickActive ?? false
    return null
  },
}))

vi.mock('../../../../../apps/web/src/components/preview/PreviewEmptyState', () => ({
  PreviewEmptyState: (props: {
    threadRef: { readonly environmentId: string; readonly threadId: string }
    onOpenUrl: (url: string) => void
  }) =>
  {
    mocks.emptyStateUrl = props.onOpenUrl
    return null
  },
}))
vi.mock('../../../../../apps/web/src/components/preview/PreviewMoreMenu', () => ({
  PreviewMoreMenu: () => null,
}))
vi.mock('../../../../../apps/web/src/components/preview/PreviewUnreachable', () => ({
  PreviewUnreachable: () => null,
}))
vi.mock('../../../../../apps/web/src/components/preview/ZoomIndicator', () => ({
  ZoomIndicator: () => null,
}))
vi.mock('../../../../../apps/web/src/components/preview/AgentBrowserCursor', () => ({
  AgentBrowserCursor: () => null,
}))
vi.mock('~/browser/BrowserSurfaceSlot', () => ({ BrowserSurfaceSlot: () => null }))
vi.mock('../../../../../apps/web/src/components/preview/usePreviewSession', () => ({
  usePreviewSession: vi.fn(),
}))

import { PreviewView } from '../../../../../apps/web/src/components/preview/PreviewView'
import { previewRuntimeTabId } from '../../../../../apps/web/src/browser/previewRuntimeTabId'

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make('environment-1'),
  threadId: ThreadId.make('thread-1'),
} as const
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, 'tab-1')
const TEST_ANNOTATION: PreviewAnnotationPayload = {
  id: 'annotation-1',
  pageUrl: 'http://localhost:5173',
  pageTitle: 'Preview',
  comment: 'Tighten this card.',
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: 'data:image/png;base64,cG5n',
    width: 200,
    height: 100,
    cropRect: { x: 10, y: 20, width: 200, height: 100 },
  },
  createdAt: '2026-09-05T00:00:00.000Z',
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function mountPreview(threadRef: ScopedThreadRef = TEST_THREAD_REF)
{
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
  {
    root.render(<PreviewView threadRef={threadRef} tabId="tab-1" visible />)
  })
  return { container, root }
}

describe('PreviewView', () =>
{
  beforeEach(() =>
  {
    mocks.addImage.mockClear()
    mocks.addPreviewAnnotation.mockClear()
    mocks.cancelPickElement.mockClear()
    mocks.capturePreviewAnnotationScreenshot.mockReset()
    mocks.capturePreviewAnnotationScreenshot.mockResolvedValue({ status: 'none' })
    mocks.navigate.mockClear()
    mocks.pickElement.mockReset()
    mocks.pickElement.mockResolvedValue(null)
    mocks.rememberPreviewUrl.mockClear()
    mocks.readPreparedConnection.mockClear()
    mocks.stackedThreadToast.mockClear()
    mocks.toastAdd.mockClear()
    mocks.submittedUrl = null
    mocks.emptyStateUrl = null
    mocks.pickElementAction = null
    mocks.pickActive = false
    mocks.showEmptyState = false
    mocks.loading = false
  })

  it('does not rerender while loading time passes', async () =>
  {
    mocks.loading = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onRender = vi.fn()

    try
    {
      await act(async () =>
      {
        root.render(
          <Profiler id="preview" onRender={onRender}>
            <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
          </Profiler>,
        )
      })
      const initialRenderCount = onRender.mock.calls.length

      // a reintroduced progress ticker re-renders every 120ms, so a few hundred
      // ms of real time must pass without a single additional render
      await act(async () =>
      {
        await new Promise((resolve) => setTimeout(resolve, 350))
      })

      expect(onRender).toHaveBeenCalledTimes(initialRenderCount)
    }
    finally
    {
      await act(async () =>
      {
        root.unmount()
      })
      container.remove()
    }
  })

  it.each([
    [
      'https://localhost:8000/dashboard?mode=test#top',
      'https://localhost:8000/dashboard?mode=test#top',
    ],
    ['localhost:5173/app', 'http://localhost:5173/app'],
  ])('preserves a direct localhost URL in a WSL environment', async (submitted, expected) =>
  {
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make('environment-1'),
          threadId: ThreadId.make('thread-1'),
        }}
        tabId="tab-1"
        visible
      />,
    )

    expect(mocks.submittedUrl).not.toBeNull()
    mocks.submittedUrl?.(submitted)

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, expected),
    )
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: 'environment-1',
        threadId: 'thread-1',
      },
      expected,
    )
  })

  it('maps an empty-state localhost server onto the WSL host', async () =>
  {
    mocks.showEmptyState = true
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make('environment-1'),
          threadId: ThreadId.make('thread-1'),
        }}
        tabId="tab-1"
        visible
      />,
    )

    expect(mocks.emptyStateUrl).not.toBeNull()
    mocks.emptyStateUrl?.('http://localhost:5173/app?mode=test#top')

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        'http://172.25.85.75:5173/app?mode=test#top',
      ),
    )
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: 'environment-1',
        threadId: 'thread-1',
      },
      'http://172.25.85.75:5173/app?mode=test#top',
    )
  })

  it('attaches a captured crop and restores focus after the pick settles', async () =>
  {
    const screenshotFile = new File(['png'], 'preview-annotation-annotation-1.png', {
      type: 'image/png',
    })
    mocks.pickElement.mockResolvedValueOnce(TEST_ANNOTATION)
    mocks.capturePreviewAnnotationScreenshot.mockResolvedValueOnce({
      status: 'captured',
      file: screenshotFile,
    })
    const focusTarget = document.createElement('button')
    document.body.append(focusTarget)
    const { container, root } = await mountPreview()

    try
    {
      focusTarget.focus()
      await act(async () => mocks.pickElementAction?.())

      await vi.waitFor(() => expect(mocks.addImage).toHaveBeenCalledTimes(1))
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, TEST_ANNOTATION)
      expect(mocks.addImage).toHaveBeenCalledWith(
        TEST_THREAD_REF,
        expect.objectContaining({
          id: TEST_ANNOTATION.id,
          previewUrl: TEST_ANNOTATION.screenshot?.dataUrl,
          file: screenshotFile,
        }),
      )
      expect(mocks.toastAdd).not.toHaveBeenCalled()
      expect(mocks.pickActive).toBe(false)
      expect(document.activeElement).toBe(focusTarget)
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
      focusTarget.remove()
    }
  })

  it.each([
    {
      name: 'desktop capture failure',
      picked: { ...TEST_ANNOTATION, screenshot: null, screenshotFailed: true },
      capture: { status: 'none' as const },
    },
    {
      name: 'local conversion failure',
      picked: TEST_ANNOTATION,
      capture: { status: 'failed' as const },
    },
  ])(
    'retains crop-free metadata and unlocks the next pick after $name',
    async ({ picked, capture }) =>
    {
      mocks.pickElement.mockResolvedValueOnce(picked).mockResolvedValueOnce(null)
      mocks.capturePreviewAnnotationScreenshot.mockResolvedValueOnce(capture)
      const { container, root } = await mountPreview()

      try
      {
        await act(async () => mocks.pickElementAction?.())

        await vi.waitFor(() => expect(mocks.addPreviewAnnotation).toHaveBeenCalledTimes(1))
        expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(
          TEST_THREAD_REF,
          expect.objectContaining({
            id: picked.id,
            screenshot: null,
          }),
        )
        expect(mocks.addImage).not.toHaveBeenCalled()
        expect(mocks.stackedThreadToast).toHaveBeenCalledWith({
          type: 'error',
          title: 'Could not capture the picked element',
          description: 'The annotation was kept without the screenshot.',
        })
        expect(mocks.toastAdd).toHaveBeenCalledTimes(1)
        expect(mocks.pickActive).toBe(false)

        await act(async () => mocks.pickElementAction?.())
        await vi.waitFor(() => expect(mocks.pickElement).toHaveBeenCalledTimes(2))
      }
      finally
      {
        await act(async () => root.unmount())
        container.remove()
      }
    },
  )

  it('cancels a pending conversion locally before starting the next pick', async () =>
  {
    let resolveCapture!: (capture: { readonly status: 'captured'; readonly file: File }) => void
    const pendingCapture = new Promise<{
      readonly status: 'captured'
      readonly file: File
    }>((resolve) =>
    {
      resolveCapture = resolve
    })
    mocks.pickElement.mockResolvedValueOnce(TEST_ANNOTATION).mockResolvedValueOnce(null)
    mocks.capturePreviewAnnotationScreenshot.mockReturnValueOnce(pendingCapture)
    const originalFocusTarget = document.createElement('button')
    const cancelFocusTarget = document.createElement('button')
    document.body.append(originalFocusTarget, cancelFocusTarget)
    const { container, root } = await mountPreview()

    try
    {
      originalFocusTarget.focus()
      await act(async () => mocks.pickElementAction?.())
      await vi.waitFor(() =>
        expect(mocks.capturePreviewAnnotationScreenshot).toHaveBeenCalledWith(TEST_ANNOTATION),
      )
      expect(mocks.pickActive).toBe(true)

      cancelFocusTarget.focus()
      await act(async () => mocks.pickElementAction?.())
      expect(mocks.cancelPickElement).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID)
      expect(mocks.pickActive).toBe(false)
      expect(document.activeElement).toBe(originalFocusTarget)

      const screenshotFile = new File(['png'], 'late.png', { type: 'image/png' })
      await act(async () =>
      {
        resolveCapture({ status: 'captured', file: screenshotFile })
        await pendingCapture
      })
      expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled()
      expect(mocks.addImage).not.toHaveBeenCalled()
      expect(mocks.toastAdd).not.toHaveBeenCalled()

      await act(async () => mocks.pickElementAction?.())
      await vi.waitFor(() => expect(mocks.pickElement).toHaveBeenCalledTimes(2))
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
      originalFocusTarget.remove()
      cancelFocusTarget.remove()
    }
  })

  it('fences late screenshot conversion from a replacement thread and its focus cleanup', async () =>
  {
    let resolveSecond!: (annotation: PreviewAnnotationPayload | null) => void
    let resolveFirstCapture!: (capture: { readonly status: 'failed' }) => void
    const firstCapture = new Promise<{ readonly status: 'failed' }>((resolve) =>
    {
      resolveFirstCapture = resolve
    })
    const secondPick = new Promise<PreviewAnnotationPayload | null>((resolve) =>
    {
      resolveSecond = resolve
    })
    mocks.pickElement.mockResolvedValueOnce(TEST_ANNOTATION).mockReturnValueOnce(secondPick)
    mocks.capturePreviewAnnotationScreenshot
      .mockReturnValueOnce(firstCapture)
      .mockResolvedValueOnce({ status: 'none' })
    const firstFocusTarget = document.createElement('button')
    const replacementFocusTarget = document.createElement('button')
    document.body.append(firstFocusTarget, replacementFocusTarget)
    const { container, root } = await mountPreview()
    const replacementThreadRef = {
      environmentId: EnvironmentId.make('environment-2'),
      threadId: ThreadId.make('thread-2'),
    } as const

    try
    {
      firstFocusTarget.focus()
      await act(async () => mocks.pickElementAction?.())
      await vi.waitFor(() =>
        expect(mocks.capturePreviewAnnotationScreenshot).toHaveBeenCalledWith(TEST_ANNOTATION),
      )
      expect(mocks.pickActive).toBe(true)

      await act(async () =>
      {
        root.render(<PreviewView threadRef={replacementThreadRef} tabId="tab-1" visible />)
      })
      replacementFocusTarget.focus()
      await act(async () => mocks.pickElementAction?.())
      expect(mocks.pickActive).toBe(true)

      await act(async () =>
      {
        resolveFirstCapture({ status: 'failed' })
        await firstCapture
      })
      expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled()
      expect(mocks.toastAdd).not.toHaveBeenCalled()
      expect(mocks.pickActive).toBe(true)
      expect(document.activeElement).toBe(replacementFocusTarget)

      const replacementAnnotation = {
        ...TEST_ANNOTATION,
        id: 'annotation-2',
        screenshot: null,
      }
      await act(async () =>
      {
        resolveSecond(replacementAnnotation)
        await secondPick
      })
      await vi.waitFor(() => expect(mocks.addPreviewAnnotation).toHaveBeenCalledTimes(1))
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(
        replacementThreadRef,
        replacementAnnotation,
      )
      expect(mocks.pickActive).toBe(false)
      expect(document.activeElement).toBe(replacementFocusTarget)
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
      firstFocusTarget.remove()
      replacementFocusTarget.remove()
    }
  })
})
