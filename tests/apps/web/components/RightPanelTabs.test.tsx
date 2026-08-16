// tests/apps/web/components/RightPanelTabs.test.tsx
// verifies distinguishable resource tabs, roving focus & close focus recovery

// @vitest-environment happy-dom

import type {
  ArchitectureGenerationId,
  ArchitectureGraphDigest,
  DesktopPreviewFavicon,
  PreviewSessionSnapshot,
  ProjectId,
  ProposalGenerationId,
  ThreadId,
} from '@t3tools/contracts'
import { act, useState, type ReactNode, type Ref } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { DesktopPreviewOverlay } from '../../../../apps/web/src/browser/previewStateStore'
import type { RightPanelSurface } from '../../../../apps/web/src/stores/rightPanelStore'

vi.mock('~/env', () => ({ isElectron: false }))
vi.mock('~/localApi', () => ({ readLocalApi: () => null }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }))
vi.mock('~/lib/workspaceTitlebar', () => ({ COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS: '' }))
vi.mock('~/lib/utils', () => ({
  cn: (...values: ReadonlyArray<string | false | null | undefined>) =>
    values.filter(Boolean).join(' '),
}))
vi.mock('~/components/ui/tooltip', () => ({
  Tooltip: (props: { readonly children: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { readonly render: ReactNode }) => props.render,
  TooltipPopup: (props: { readonly children: ReactNode }) => <span>{props.children}</span>,
}))
vi.mock('~/components/ui/menu', () => ({
  Menu: (props: { readonly children: ReactNode }) => <div>{props.children}</div>,
  MenuTrigger: (props: { readonly children: ReactNode; readonly 'aria-label'?: string }) => (
    <button aria-label={props['aria-label']} type="button">
      {props.children}
    </button>
  ),
  MenuPopup: (props: { readonly children: ReactNode }) => <div>{props.children}</div>,
  MenuItem: (props: { readonly children: ReactNode; readonly disabled?: boolean }) => (
    <button disabled={props.disabled} type="button">
      {props.children}
    </button>
  ),
}))
vi.mock('~/components/ui/scroll-area', () => ({
  ScrollArea: (props: { readonly children: ReactNode; readonly ref?: Ref<HTMLDivElement> }) => (
    <div ref={props.ref}>{props.children}</div>
  ),
}))
vi.mock('../../../../apps/web/src/components/preview/PreviewPanelShell', () => ({
  PreviewPanelShell: (props: { readonly children: ReactNode }) => <div>{props.children}</div>,
}))
vi.mock('../../../../apps/web/src/components/chat/PierreEntryIcon', () => ({
  PierreEntryIcon: () => <span data-file-icon />,
}))

import { RightPanelTabs } from '../../../../apps/web/src/components/RightPanelTabs'

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
  {
    callback(0)
    return 1
  },
})
Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn() })

const impactSurface = {
  id: 'architecture-impact:test',
  kind: 'architecture-impact',
  target: {
    threadId: 'thread-right-panel' as ThreadId,
    comparison: {
      kind: 'proposal-generation',
      generationId: 'proposal-generation-1234567890' as ProposalGenerationId,
    },
  },
} satisfies RightPanelSurface

const atlasSurface = {
  id: 'repository-atlas:test',
  kind: 'repository-atlas',
  target: {
    kind: 'standing-project-generation',
    projectId: 'project-right-panel' as ProjectId,
    generationId: 'a'.repeat(64) as ArchitectureGenerationId,
    side: 'analyzed',
    graphDigest: `sha256:${'b'.repeat(64)}` as ArchitectureGraphDigest,
  },
} satisfies RightPanelSurface

const initialSurfaces: readonly RightPanelSurface[] = [
  { id: 'diff', kind: 'diff' },
  impactSurface,
  atlasSurface,
]

const previewSurface = {
  id: 'browser:tab-private',
  kind: 'preview',
  resourceId: 'tab-private',
} satisfies RightPanelSurface
const previewUrl = 'http://192.168.1.20:5173/app'
const previewSessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  'tab-private': {
    threadId: 'thread-right-panel' as ThreadId,
    tabId: 'tab-private',
    navStatus: { _tag: 'Success', url: previewUrl, title: 'Private preview' },
    canGoBack: false,
    canGoForward: false,
    updatedAt: '2026-08-16T00:00:00.000Z',
  },
}

const previewOverlay = (favicon: DesktopPreviewFavicon | null): DesktopPreviewOverlay => ({
  hasWebContents: true,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  zoomFactor: 1,
  colorScheme: 'system',
  controller: 'none',
  favicon,
})

const renderPreviewTab = (favicon: DesktopPreviewFavicon | null): string =>
  renderToStaticMarkup(
    <RightPanelTabs
      mode="embedded"
      surfaces={[previewSurface]}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={previewSessions}
      desktopByTabId={{ 'tab-private': previewOverlay(favicon) }}
      terminalLabelsById={new globalThis.Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddTerminal={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddWorkers={() => undefined}
      browserAvailable
      diffAvailable
      filesAvailable
    >
      <div>Private preview</div>
    </RightPanelTabs>,
  )

function Harness()
{
  const [surfaces, setSurfaces] = useState(initialSurfaces)
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>('diff')

  return (
    <RightPanelTabs
      mode="embedded"
      surfaces={surfaces}
      activeSurfaceId={activeSurfaceId}
      pendingSurfaceIds={new Set()}
      previewSessions={{} as Readonly<Record<string, PreviewSessionSnapshot>>}
      desktopByTabId={{}}
      terminalLabelsById={new globalThis.Map()}
      onActivate={(surface) => setActiveSurfaceId(surface.id)}
      onCloseSurface={(surface) =>
      {
        const index = surfaces.findIndex((candidate) => candidate.id === surface.id)
        const remaining = surfaces.filter((candidate) => candidate.id !== surface.id)
        setSurfaces(remaining)
        if (activeSurfaceId === surface.id)
        {
          setActiveSurfaceId(remaining[index]?.id ?? remaining[index - 1]?.id ?? null)
        }
      }}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddTerminal={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddWorkers={() => undefined}
      browserAvailable
      diffAvailable
      filesAvailable
    >
      <div>Active resource</div>
    </RightPanelTabs>
  )
}

describe('RightPanelTabs', () =>
{
  it('distinguishes exact resources and preserves keyboard focus through activation and close', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    act(() => root.render(<Harness />))
    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist?.getAttribute('aria-label')).toBe('Right panel resources')

    let tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs).toHaveLength(3)
    expect(tabs[1]?.textContent).toContain('Impact Diff · proposal')
    expect(tabs[2]?.textContent).toContain('Repository Atlas · aaaaaaaa')

    tabs[0]?.focus()
    act(() =>
    {
      tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])

    const closeImpact = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Close Impact Diff"]',
    )
    act(() => closeImpact?.click())
    tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs).toHaveLength(2)
    expect(tabs[1]?.textContent).toContain('Repository Atlas · aaaaaaaa')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])

    act(() => root.unmount())
    container.remove()
  })

  it('prefers a current capture and keeps stale private-origin fallback first-party', () =>
  {
    const captured = renderPreviewTab({
      dataUrl: 'data:image/png;base64,AAAA',
      pageUrl: 'http://192.168.1.20:5173/dashboard',
      capturedAt: 1,
    })
    expect(captured).toContain('src="data:image/png;base64,AAAA"')
    expect(captured).not.toContain('google')

    const stale = renderPreviewTab({
      dataUrl: 'data:image/png;base64,BBBB',
      pageUrl: 'https://example.com/',
      capturedAt: 2,
    })
    expect(stale).not.toContain('data:image/png;base64,BBBB')
    expect(stale).toContain('src="http://192.168.1.20:5173/favicon.ico"')
    expect(stale).not.toContain('google')
    expect(stale).not.toContain('s2/favicons')
  })
})
