// tests/apps/web/components/preview/PreviewView.test.tsx
// verify preview view navigation behavior

import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: 'http://172.25.85.75:3773' })),
  submittedUrl: null as ((url: string) => void) | null,
  emptyStateUrl: null as ((url: string) => void) | null,
  showEmptyState: false,
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
  ) => select({ addPreviewAnnotation: vi.fn(), addImage: vi.fn() }),
}))

vi.mock('~/lib/previewAnnotation', () => ({
  previewAnnotationScreenshotFile: vi.fn(),
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
        loading: false,
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
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}))

vi.mock('../../../../../apps/web/src/browser/previewBridge', () => ({
  previewBridge: { navigate: mocks.navigate },
}))

vi.mock('../../../../../apps/web/src/components/preview/PreviewChromeRow', () => ({
  PreviewChromeRow: (props: { onSubmit: (url: string) => void }) =>
  {
    mocks.submittedUrl = props.onSubmit
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
vi.mock('../../../../../apps/web/src/components/preview/useLoadingProgress', () => ({
  useLoadingProgress: () => 0,
}))
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

describe('PreviewView navigation', () =>
{
  beforeEach(() =>
  {
    mocks.navigate.mockClear()
    mocks.rememberPreviewUrl.mockClear()
    mocks.readPreparedConnection.mockClear()
    mocks.submittedUrl = null
    mocks.emptyStateUrl = null
    mocks.showEmptyState = false
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
})
