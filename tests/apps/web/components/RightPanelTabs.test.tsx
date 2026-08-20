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

const { confirmTerminalClose, contextMenuShow, setAudioMuted } = vi.hoisted(() => ({
  confirmTerminalClose: vi.fn(async (): Promise<boolean> => true),
  contextMenuShow: vi.fn(async (): Promise<string | null> => null),
  setAudioMuted: vi.fn(async () => undefined),
}))

vi.mock('~/env', () => ({ isElectron: false }))
vi.mock('~/localApi', () => ({
  readLocalApi: () => ({ contextMenu: { show: contextMenuShow } }),
}))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }))
vi.mock('~/lib/workspaceTitlebar', () => ({ COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS: '' }))
vi.mock('~/browser/previewBridge', () => ({ previewBridge: { setAudioMuted } }))
vi.mock('~/lib/terminalCloseConfirm', () => ({ confirmTerminalClose }))
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
  MenuShortcut: (props: { readonly children: ReactNode }) => <kbd>{props.children}</kbd>,
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

import {
  RightPanelTabs,
  surfaceShortcutActionForKey,
  tabMuteMenuItem,
} from '../../../../apps/web/src/components/RightPanelTabs'

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

const previewOverlay = (
  favicon: DesktopPreviewFavicon | null,
  audio: { readonly audible?: boolean; readonly audioMuted?: boolean } = {},
): DesktopPreviewOverlay => ({
  hasWebContents: true,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  zoomFactor: 1,
  colorScheme: 'system',
  audioMuted: audio.audioMuted ?? false,
  audible: audio.audible ?? false,
  controller: 'none',
  favicon,
})

const renderPreviewTab = (
  favicon: DesktopPreviewFavicon | null,
  audio: { readonly audible?: boolean; readonly audioMuted?: boolean } = {},
  runtimeTabId: ((tabId: string) => string) | null = (tabId) => `runtime:${tabId}`,
): string =>
  renderToStaticMarkup(
    <RightPanelTabs
      mode="embedded"
      contextKey="thread-right-panel"
      surfaces={[previewSurface]}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={previewSessions}
      desktopByTabId={{ 'tab-private': previewOverlay(favicon, audio) }}
      {...(runtimeTabId ? { previewRuntimeTabId: runtimeTabId } : {})}
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
      contextKey="thread-right-panel"
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

type ContextMenuHarnessInput = {
  readonly contextKey?: string
  readonly surfaces: readonly RightPanelSurface[]
  readonly terminalLabelsById?: ReadonlyMap<string, string>
  readonly onCloseAllSurfaces: () => void
}

function renderContextMenuHarness(input: ContextMenuHarnessInput)
{
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (current: ContextMenuHarnessInput): void =>
  {
    act(() =>
      root.render(
        <RightPanelTabs
          mode="embedded"
          contextKey={current.contextKey ?? 'thread-a'}
          surfaces={current.surfaces}
          activeSurfaceId={current.surfaces[0]?.id ?? null}
          pendingSurfaceIds={new Set()}
          previewSessions={{} as Readonly<Record<string, PreviewSessionSnapshot>>}
          desktopByTabId={{}}
          terminalLabelsById={current.terminalLabelsById ?? new globalThis.Map()}
          onActivate={() => undefined}
          onCloseSurface={() => undefined}
          onCloseOtherSurfaces={() => undefined}
          onCloseSurfacesToRight={() => undefined}
          onCloseAllSurfaces={current.onCloseAllSurfaces}
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
        </RightPanelTabs>,
      ),
    )
  }
  render(input)

  return {
    render,
    async requestCloseAll(): Promise<void>
    {
      contextMenuShow.mockResolvedValueOnce('close-all')
      await act(async () =>
      {
        container
          .querySelector<HTMLElement>('[role="tab"]')
          ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
        await Promise.resolve()
        await Promise.resolve()
      })
    },
    cleanup(): void
    {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('RightPanelTabs', () =>
{
  it('resolves available surface shortcuts without stealing modified keystrokes', () =>
  {
    const actions = [
      { shortcut: 'B', available: true, label: 'Browser' },
      { shortcut: 'T', available: false, label: 'Terminal' },
    ] as const

    expect(
      surfaceShortcutActionForKey(actions, {
        key: 'b',
        defaultPrevented: false,
        isComposing: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      })?.label,
    ).toBe('Browser')
    expect(
      surfaceShortcutActionForKey(actions, {
        key: 't',
        defaultPrevented: false,
        isComposing: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBeNull()
    expect(
      surfaceShortcutActionForKey(actions, {
        key: 'b',
        defaultPrevented: false,
        isComposing: false,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBeNull()
  })

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

  it('confirms a mixed terminal batch once before closing and leaves it intact on cancellation', async () =>
  {
    contextMenuShow.mockReset()
    confirmTerminalClose.mockReset()
    confirmTerminalClose.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const closeAll = vi.fn()
    const terminalSurface = {
      id: 'terminal:build',
      kind: 'terminal',
      resourceId: 'build',
      terminalIds: ['build', 'server'],
      activeTerminalId: 'build',
    } satisfies RightPanelSurface
    const harness = renderContextMenuHarness({
      surfaces: [{ id: 'diff', kind: 'diff' }, terminalSurface, { id: 'files', kind: 'files' }],
      terminalLabelsById: new globalThis.Map([
        ['build', 'Build'],
        ['server', 'Development server'],
      ]),
      onCloseAllSurfaces: closeAll,
    })

    await harness.requestCloseAll()
    expect(confirmTerminalClose).toHaveBeenCalledExactlyOnceWith(['Build', 'Development server'])
    expect(closeAll).not.toHaveBeenCalled()

    await harness.requestCloseAll()
    expect(confirmTerminalClose).toHaveBeenCalledTimes(2)
    expect(closeAll).toHaveBeenCalledOnce()
    harness.cleanup()
  })

  it('abandons a confirmed close when its terminal batch changes while prompting', async () =>
  {
    contextMenuShow.mockReset()
    confirmTerminalClose.mockReset()
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined
    confirmTerminalClose.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) =>
        {
          resolveConfirmation = resolve
        }),
    )
    const staleCloseAll = vi.fn()
    const currentCloseAll = vi.fn()
    const terminalSurface = {
      id: 'terminal:build',
      kind: 'terminal',
      resourceId: 'build',
      terminalIds: ['build'],
      activeTerminalId: 'build',
    } satisfies RightPanelSurface
    const labels = new globalThis.Map([
      ['build', 'Build'],
      ['server', 'Development server'],
    ])
    const harness = renderContextMenuHarness({
      surfaces: [{ id: 'diff', kind: 'diff' }, terminalSurface],
      terminalLabelsById: labels,
      onCloseAllSurfaces: staleCloseAll,
    })

    await harness.requestCloseAll()
    expect(confirmTerminalClose).toHaveBeenCalledExactlyOnceWith(['Build'])
    harness.render({
      surfaces: [
        { id: 'diff', kind: 'diff' },
        { ...terminalSurface, terminalIds: ['build', 'server'] },
      ],
      terminalLabelsById: labels,
      onCloseAllSurfaces: currentCloseAll,
    })
    await act(async () =>
    {
      resolveConfirmation?.(true)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(staleCloseAll).not.toHaveBeenCalled()
    expect(currentCloseAll).not.toHaveBeenCalled()
    harness.cleanup()
  })

  it('abandons a confirmed close when the thread changes with an identical batch', async () =>
  {
    contextMenuShow.mockReset()
    confirmTerminalClose.mockReset()
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined
    confirmTerminalClose.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) =>
        {
          resolveConfirmation = resolve
        }),
    )
    const staleCloseAll = vi.fn()
    const currentCloseAll = vi.fn()
    const surfaces = [
      { id: 'diff', kind: 'diff' },
      {
        id: 'terminal:build',
        kind: 'terminal',
        resourceId: 'build',
        terminalIds: ['build'],
        activeTerminalId: 'build',
      },
    ] satisfies readonly RightPanelSurface[]
    const terminalLabelsById = new globalThis.Map([['build', 'Build']])
    const harness = renderContextMenuHarness({
      contextKey: 'thread-a',
      surfaces,
      terminalLabelsById,
      onCloseAllSurfaces: staleCloseAll,
    })

    await harness.requestCloseAll()
    expect(confirmTerminalClose).toHaveBeenCalledExactlyOnceWith(['Build'])
    harness.render({
      contextKey: 'thread-b',
      surfaces,
      terminalLabelsById,
      onCloseAllSurfaces: currentCloseAll,
    })
    await act(async () =>
    {
      resolveConfirmation?.(true)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(staleCloseAll).not.toHaveBeenCalled()
    expect(currentCloseAll).not.toHaveBeenCalled()
    harness.cleanup()
  })

  it('closes a non-terminal batch without prompting', async () =>
  {
    contextMenuShow.mockReset()
    confirmTerminalClose.mockReset()
    const closeAll = vi.fn()
    const harness = renderContextMenuHarness({
      surfaces: [
        { id: 'diff', kind: 'diff' },
        { id: 'files', kind: 'files' },
      ],
      onCloseAllSurfaces: closeAll,
    })

    await harness.requestCloseAll()
    expect(confirmTerminalClose).not.toHaveBeenCalled()
    expect(closeAll).toHaveBeenCalledOnce()
    harness.cleanup()
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

  it.each([
    { audible: false, audioMuted: false, label: null },
    { audible: false, audioMuted: true, label: null },
    { audible: true, audioMuted: false, label: 'Mute Private preview' },
    { audible: true, audioMuted: true, label: 'Unmute Private preview' },
  ])('shows an audio toggle only while the tab is audible', ({ audible, audioMuted, label }) =>
  {
    const html = renderPreviewTab(null, { audible, audioMuted })
    if (label === null)
    {
      expect(html).not.toContain('Mute Private preview')
      expect(html).not.toContain('Unmute Private preview')
      return
    }
    expect(html).toContain(`aria-label="${label}"`)
  })

  it('resolves desktop actions through the runtime tab identity', () =>
  {
    const seen: string[] = []
    renderPreviewTab(null, { audible: true }, (tabId) =>
    {
      seen.push(tabId)
      return `runtime:${tabId}`
    })
    expect(seen).toContain('tab-private')

    const withoutRuntimeIdentity = renderPreviewTab(null, { audible: true }, null)
    expect(withoutRuntimeIdentity).not.toContain('Mute Private preview')
  })

  it('keeps mute disabled until a desktop tab is addressable', () =>
  {
    expect(tabMuteMenuItem({ overlay: null, canResolveRuntimeTabId: true })).toEqual({
      label: 'Mute tab',
      disabled: true,
    })
    expect(
      tabMuteMenuItem({
        overlay: previewOverlay(null, { audioMuted: true }),
        canResolveRuntimeTabId: false,
      }),
    ).toEqual({ label: 'Unmute tab', disabled: true })
    expect(
      tabMuteMenuItem({
        overlay: previewOverlay(null, { audioMuted: false }),
        canResolveRuntimeTabId: true,
      }),
    ).toEqual({ label: 'Mute tab', disabled: false })
  })
})
