// apps/web/src/components/RightPanelTabs.tsx
// renders right-panel tabs, surface creation, and empty-state availability
import type { ContextMenuItem, PreviewSessionSnapshot } from '@t3tools/contracts'
import { getTerminalLabel } from '@t3tools/shared/terminalLabels'
import {
  Blocks,
  Bot,
  ClipboardList,
  FileDiff,
  Files,
  GitCompareArrows,
  Globe2,
  Map,
  Network,
  Plus,
  TerminalSquare,
  Volume2,
  VolumeOff,
  X,
} from 'lucide-react'
import {
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { isElectron } from '~/env'
import type { DesktopPreviewOverlay } from '~/previewStateStore'
import type { RightPanelSurface } from '~/rightPanelStore'
import { cn } from '~/lib/utils'
import { readLocalApi } from '~/localApi'
import { Tooltip, TooltipPopup, TooltipTrigger } from '~/components/ui/tooltip'
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from '~/components/ui/menu'
import { ScrollArea } from '~/components/ui/scroll-area'
import { faviconUrlForOrigin } from '~/lib/favicon'
import { confirmTerminalClose } from '~/lib/terminalCloseConfirm'
import { useTheme } from '~/hooks/useTheme'
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from '~/lib/workspaceTitlebar'
import { previewBridge } from '~/browser/previewBridge'

import { PreviewPanelShell, type PreviewPanelMode } from './preview/PreviewPanelShell'
import { FaviconImage } from './preview/PreviewFaviconIcon'
import { PierreEntryIcon } from './chat/PierreEntryIcon'

interface RightPanelTabsProps
{
  mode: PreviewPanelMode
  contextKey: string
  maximized?: boolean
  layoutControls?: ReactNode
  surfaces: readonly RightPanelSurface[]
  activeSurfaceId: string | null
  pendingSurfaceIds: ReadonlySet<string>
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>
  previewRuntimeTabId?: ((tabId: string) => string) | undefined
  terminalLabelsById: ReadonlyMap<string, string>
  onActivate: (surface: RightPanelSurface) => void
  onCloseSurface: (surface: RightPanelSurface) => void
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void
  onCloseAllSurfaces: () => void
  onCopyFilePath: (relativePath: string) => void
  onAddBrowser: () => void
  onAddTerminal: () => void
  onAddDiff: () => void
  onAddFiles: () => void
  onAddWorkers: () => void
  onAddRepositoryAtlas?: () => void
  onAddExplorer?: () => void
  browserAvailable: boolean
  diffAvailable: boolean
  filesAvailable: boolean
  repositoryAtlasAvailable?: boolean
  explorerAvailable?: boolean
  children: ReactNode
}

const SURFACE_DISABLED_REASONS = {
  browser: 'Browser previews are only available in the 456code desktop app.',
  files: 'Files are only available when a project is open.',
  diff: 'Diff is only available for server threads in Git repositories.',
  atlas: 'Repository Map requires native architecture analysis for an open project.',
  explorer: 'Proposal Review requires proposal previews for an open server project.',
} as const
const NOOP_SURFACE_ACTION = () => undefined

type TabContextMenuAction =
  'copy-path' | 'toggle-mute' | 'close' | 'close-others' | 'close-to-right' | 'close-all'
type BulkTabCloseAction = Extract<
  TabContextMenuAction,
  'close-others' | 'close-to-right' | 'close-all'
>

function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null
{
  if (surface.kind !== 'preview' || !surface.resourceId) return null
  return sessions[surface.resourceId]?.tabId ?? null
}

export function tabMuteMenuItem(input: {
  readonly overlay: DesktopPreviewOverlay | null
  readonly canResolveRuntimeTabId: boolean
}): { readonly label: string; readonly disabled: boolean }
{
  return {
    label: input.overlay?.audioMuted ? 'Unmute tab' : 'Mute tab',
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  }
}

type TabAudioState = 'none' | 'audible' | 'muted'

function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState
{
  if (!overlay?.audible) return 'none'
  return overlay.audioMuted ? 'muted' : 'audible'
}

async function confirmTerminalSurfaceBatch(
  surfaces: readonly RightPanelSurface[],
  terminalLabelsById: ReadonlyMap<string, string>,
): Promise<boolean>
{
  const labels = surfaces.flatMap((surface) =>
    surface.kind === 'terminal'
      ? surface.terminalIds.map(
          (terminalId) => terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId),
        )
      : [],
  )
  const firstLabel = labels[0]
  if (firstLabel === undefined) return true
  return confirmTerminalClose([firstLabel, ...labels.slice(1)])
}

function resolveBulkCloseBatch(
  surfaces: readonly RightPanelSurface[],
  targetId: string,
  action: BulkTabCloseAction,
): { readonly target: RightPanelSurface; readonly surfaces: readonly RightPanelSurface[] } | null
{
  const targetIndex = surfaces.findIndex((surface) => surface.id === targetId)
  const target = surfaces[targetIndex]
  if (!target) return null
  switch (action)
  {
    case 'close-others':
      return { target, surfaces: surfaces.filter((surface) => surface.id !== targetId) }
    case 'close-to-right':
      return { target, surfaces: surfaces.slice(targetIndex + 1) }
    case 'close-all':
      return { target, surfaces }
  }
}

const closeBatchSignature = (surfaces: readonly RightPanelSurface[]): string =>
  JSON.stringify(surfaces)

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey'
>

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null
{
  if (event.defaultPrevented || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  )
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement })
{
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  )
}

function SurfaceMenuItem(props: {
  available: boolean
  disabledReason?: string
  shortcut: string
  onClick: () => void
  children: ReactNode
})
{
  const item = (
    <MenuItem
      className={!props.available ? 'data-disabled:pointer-events-auto' : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  )
  if (props.available || !props.disabledReason) return item
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />
}

function RightPanelEmptyState(props: {
  onAddBrowser: () => void
  onAddTerminal: () => void
  onAddDiff: () => void
  onAddFiles: () => void
  onAddWorkers: () => void
  onAddRepositoryAtlas: () => void
  onAddExplorer: () => void
  browserAvailable: boolean
  diffAvailable: boolean
  filesAvailable: boolean
  repositoryAtlasAvailable: boolean
  explorerAvailable: boolean
})
{
  const actions = [
    {
      label: 'Browser',
      description: 'Open a local app or URL.',
      icon: Globe2,
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: 'Terminal',
      description: 'Start a shell in this workspace.',
      icon: TerminalSquare,
      available: true,
      disabledReason: null,
      onClick: props.onAddTerminal,
    },
    {
      label: 'Files',
      description: 'Browse and read workspace files.',
      icon: Files,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: 'Diff',
      description: 'Review changes in this thread.',
      icon: FileDiff,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: 'Proposal Review',
      description: 'Review proposal narrative, changes, and impact.',
      icon: Network,
      available: props.explorerAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.explorer,
      onClick: props.onAddExplorer,
    },
    {
      label: 'Repository Map',
      description: "Explore this project's sealed architecture map.",
      icon: Map,
      available: props.repositoryAtlasAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.atlas,
      onClick: props.onAddRepositoryAtlas,
    },
    {
      label: 'Workers',
      description: 'Inspect local worker-broker jobs.',
      icon: Bot,
      available: true,
      disabledReason: null,
      onClick: props.onAddWorkers,
    },
  ] as const

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">Open a surface</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) =>
          {
            const Icon = action.icon
            const content = (
              <>
                <Icon className="mb-3 size-5" />
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </>
            )
            if (action.available)
            {
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left transition hover:border-border hover:bg-accent/60 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  {content}
                </button>
              )
            }
            const disabledCard = (
              <button
                type="button"
                className="flex min-h-28 w-full cursor-not-allowed flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left opacity-40 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                aria-disabled="true"
              >
                {content}
              </button>
            )
            return (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={disabledCard}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
): string
{
  switch (surface.kind)
  {
    case 'diff':
      return 'Diff'
    case 'files':
      return 'Files'
    case 'file':
    {
      const fileName = surface.relativePath.slice(surface.relativePath.lastIndexOf('/') + 1)
      if (!surface.source) return fileName
      const side =
        surface.source.side === 'base'
          ? 'Before'
          : surface.source.side === 'proposed'
            ? 'Proposed'
            : 'After'
      const revision =
        surface.source.kind === 'diff-analysis'
          ? surface.source.diffAnalysisId
          : surface.source.generationId
      return `${fileName} · ${side} · ${revision.slice(0, 8)}`
    }
    case 'terminal':
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      )
    case 'plan':
      return 'Plan'
    case 'workers':
      return 'Workers'
    case 'repository-atlas-home':
      return 'Repository Map'
    case 'explorer':
      return 'Proposal Review'
    case 'architecture-impact':
    {
      const target = surface.target.descriptor.target
      const revision =
        target.kind === 'comparison'
          ? target.comparison.kind === 'diff-analysis'
            ? target.comparison.diffAnalysisId
            : target.comparison.generationId
          : surface.target.descriptor.descriptorId
      return `Impact Diff · ${revision.slice(0, 8)}`
    }
    case 'repository-atlas':
      return `Repository Map · ${surface.target.generationId.slice(0, 8)}`
    case 'preview':
    {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null
      if (!snapshot || snapshot.navStatus._tag === 'Idle') return 'Browser'
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title
      try
      {
        return new URL(snapshot.navStatus.url).host || 'Browser'
      }
      catch
      {
        return 'Browser'
      }
    }
  }
}

function surfaceTooltip(title: string, surface: RightPanelSurface): string
{
  switch (surface.kind)
  {
    case 'architecture-impact':
    {
      const target = surface.target.descriptor.target
      return `${title} · ${
        target.kind === 'comparison'
          ? target.comparison.kind === 'diff-analysis'
            ? target.comparison.diffAnalysisId
            : target.comparison.generationId
          : surface.target.descriptor.descriptorId
      }`
    }
    case 'repository-atlas':
      return `${title} · ${surface.target.generationId}`
    case 'file':
      if (!surface.source) return title
      return `${title} · ${
        surface.source.kind === 'diff-analysis'
          ? surface.source.diffAnalysisId
          : surface.source.generationId
      }`
    default:
      return title
  }
}

const httpOrigin = (url: string): string | null =>
{
  try
  {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  }
  catch
  {
    return null
  }
}

function PreviewFavicon(props: { capturedUrl: string | null; url: string | null })
{
  return (
    <FaviconImage
      sources={[props.capturedUrl, faviconUrlForOrigin(props.url)]}
      fallback={<Globe2 className="size-3.5 shrink-0" />}
      className="size-3.5 shrink-0 rounded-sm object-contain"
    />
  )
}

function SurfaceIcon({
  surface,
  sessions,
  desktopByTabId,
  theme,
}: {
  surface: RightPanelSurface
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>
  theme: 'light' | 'dark'
})
{
  switch (surface.kind)
  {
    case 'preview':
    {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null
      const url = !snapshot || snapshot.navStatus._tag === 'Idle' ? null : snapshot.navStatus.url
      const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null
      const origin = url ? httpOrigin(url) : null
      const capturedUrl =
        favicon && origin !== null && httpOrigin(favicon.pageUrl) === origin
          ? favicon.dataUrl
          : null
      return <PreviewFavicon capturedUrl={capturedUrl} url={url} />
    }
    case 'diff':
      return <FileDiff className="size-3.5 shrink-0" />
    case 'files':
      return <Files className="size-3.5 shrink-0" />
    case 'file':
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3.5"
        />
      )
    case 'terminal':
      return <TerminalSquare className="size-3.5 shrink-0" />
    case 'plan':
      return <ClipboardList className="size-3.5 shrink-0" />
    case 'workers':
      return <Bot className="size-3.5 shrink-0" />
    case 'repository-atlas-home':
      return <Blocks className="size-3.5 shrink-0" />
    case 'explorer':
      return <Network className="size-3.5 shrink-0" />
    case 'architecture-impact':
      return <GitCompareArrows className="size-3.5 shrink-0" />
    case 'repository-atlas':
      return <Map className="size-3.5 shrink-0" />
  }
}

export function RightPanelTabs(props: RightPanelTabsProps)
{
  const ownsDesktopTitleBar = isElectron && props.mode === 'inline'
  const { resolvedTheme } = useTheme()
  const tabsetId = useId()
  const tabListRef = useRef<HTMLDivElement>(null)
  const latestPropsRef = useRef(props)
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false)
  const addSurfaceActions = [
    {
      label: 'Browser',
      icon: Globe2,
      shortcut: 'B',
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: 'Terminal',
      icon: TerminalSquare,
      shortcut: 'T',
      available: true,
      onClick: props.onAddTerminal,
    },
    {
      label: 'Files',
      icon: Files,
      shortcut: 'F',
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: 'Diff',
      icon: FileDiff,
      shortcut: 'D',
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: 'Workers',
      icon: Bot,
      shortcut: 'W',
      available: true,
      onClick: props.onAddWorkers,
    },
    {
      label: 'Proposal Review',
      icon: Network,
      shortcut: 'P',
      available: props.explorerAvailable === true,
      disabledReason: SURFACE_DISABLED_REASONS.explorer,
      onClick: props.onAddExplorer ?? NOOP_SURFACE_ACTION,
    },
    {
      label: 'Repository Map',
      icon: Map,
      shortcut: 'R',
      available: props.repositoryAtlasAvailable === true,
      disabledReason: SURFACE_DISABLED_REASONS.atlas,
      onClick: props.onAddRepositoryAtlas ?? NOOP_SURFACE_ACTION,
    },
  ] as const

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) =>
  {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    setAddSurfaceMenuOpen(false)
    action.onClick()
  }
  const tabButtonRefs = useRef(new globalThis.Map<string, HTMLButtonElement>())
  const focusAfterCloseRef = useRef(false)
  const activeSurfaceIndex = props.surfaces.findIndex(
    (surface) => surface.id === props.activeSurfaceId,
  )
  const panelId = `${tabsetId}-panel`
  const activeTabId = activeSurfaceIndex < 0 ? undefined : `${tabsetId}-tab-${activeSurfaceIndex}`

  useLayoutEffect(() =>
  {
    latestPropsRef.current = props
  }, [props])

  const closeSurface = useCallback(
    (surface: RightPanelSurface): void =>
    {
      focusAfterCloseRef.current = true
      props.onCloseSurface(surface)
    },
    [props.onCloseSurface],
  )

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) =>
    {
      event.preventDefault()
      event.stopPropagation()
      const originContextKey = props.contextKey

      const api = readLocalApi()
      if (!api) return

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id)
      if (surfaceIndex < 0) return

      const items: ContextMenuItem<TabContextMenuAction>[] = []
      if (surface.kind === 'file')
      {
        items.push({ id: 'copy-path', label: 'Copy path' })
      }
      const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions)
      const menuOverlay = menuPreviewTabId ? (props.desktopByTabId[menuPreviewTabId] ?? null) : null
      const menuMuted = menuOverlay?.audioMuted ?? false
      if (surface.kind === 'preview')
      {
        items.push({
          id: 'toggle-mute',
          ...tabMuteMenuItem({
            overlay: menuOverlay,
            canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
          }),
        })
      }
      items.push(
        { id: 'close', label: 'Close', separatorBefore: surface.kind === 'preview' },
        {
          id: 'close-others',
          label: 'Close others',
          disabled: props.surfaces.length <= 1,
        },
        {
          id: 'close-to-right',
          label: 'Close to the right',
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: 'close-all',
          label: 'Close all',
          disabled: props.surfaces.length === 0,
        },
      )

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY })
      switch (action)
      {
        case 'copy-path':
          if (surface.kind === 'file') props.onCopyFilePath(surface.relativePath)
          break
        case 'toggle-mute':
        {
          const runtimeTabId =
            menuPreviewTabId && menuOverlay
              ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
              : null
          if (runtimeTabId)
          {
            void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined)
          }
          break
        }
        case 'close':
          closeSurface(surface)
          break
        case 'close-others':
        case 'close-to-right':
        case 'close-all':
        {
          const selectedProps = latestPropsRef.current
          if (selectedProps.contextKey !== originContextKey) break
          const selectedBatch = resolveBulkCloseBatch(selectedProps.surfaces, surface.id, action)
          if (!selectedBatch) break
          const selectedSignature = closeBatchSignature(selectedBatch.surfaces)
          if (
            !(await confirmTerminalSurfaceBatch(
              selectedBatch.surfaces,
              selectedProps.terminalLabelsById,
            ))
          )
          {
            break
          }

          const currentProps = latestPropsRef.current
          const currentBatch = resolveBulkCloseBatch(currentProps.surfaces, surface.id, action)
          if (
            currentProps.contextKey !== originContextKey ||
            !currentBatch ||
            closeBatchSignature(currentBatch.surfaces) !== selectedSignature
          )
          {
            break
          }
          if (action === 'close-others') currentProps.onCloseOtherSurfaces(currentBatch.target)
          else if (action === 'close-to-right')
          {
            currentProps.onCloseSurfacesToRight(currentBatch.target)
          }
          else currentProps.onCloseAllSurfaces()
          break
        }
        case null:
          break
      }
    },
    [closeSurface, props],
  )
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) =>
  {
    if (event.button !== 1) return
    event.preventDefault()
  }, [])
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) =>
    {
      if (event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
      closeSurface(surface)
    },
    [closeSurface],
  )

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, surfaceIndex: number): void =>
    {
      let nextIndex: number | null = null
      switch (event.key)
      {
        case 'ArrowLeft':
          nextIndex = surfaceIndex === 0 ? props.surfaces.length - 1 : surfaceIndex - 1
          break
        case 'ArrowRight':
          nextIndex = surfaceIndex === props.surfaces.length - 1 ? 0 : surfaceIndex + 1
          break
        case 'Home':
          nextIndex = 0
          break
        case 'End':
          nextIndex = props.surfaces.length - 1
          break
        default:
          return
      }
      const nextSurface = props.surfaces[nextIndex]
      if (!nextSurface) return
      event.preventDefault()
      props.onActivate(nextSurface)
      tabButtonRefs.current.get(nextSurface.id)?.focus()
    },
    [props.onActivate, props.surfaces],
  )

  useEffect(() =>
  {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']")
    activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (!focusAfterCloseRef.current) return
    focusAfterCloseRef.current = false
    const activeSurfaceId = props.activeSurfaceId
    if (activeSurfaceId === null) return
    globalThis.requestAnimationFrame(() =>
    {
      tabButtonRefs.current.get(activeSurfaceId)?.focus()
    })
  }, [props.activeSurfaceId])

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className={cn(
          'workspace-topbar gap-1 pl-2',
          props.mode === 'inline' ? 'pr-28' : 'pr-3',
          ownsDesktopTitleBar && 'wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]',
          props.mode === 'inline' && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className={cn('min-w-0 flex-1 rounded-none', ownsDesktopTitleBar && 'drag-region')}
          data-right-panel-tab-list
        >
          <div
            aria-label="Right panel resources"
            className="flex h-full w-max min-w-full items-center gap-1"
            role="tablist"
          >
            {props.surfaces.map((surface, surfaceIndex) =>
            {
              const active = surface.id === props.activeSurfaceId
              const pending = props.pendingSurfaceIds.has(surface.id)
              const title = surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)
              const tooltip = surfaceTooltip(title, surface)
              const previewTabId = previewTabIdOf(surface, props.previewSessions)
              const audioOverlay = previewTabId
                ? (props.desktopByTabId[previewTabId] ?? null)
                : null
              const audio = tabAudioState(audioOverlay)
              const audioRuntimeTabId = previewTabId
                ? (props.previewRuntimeTabId?.(previewTabId) ?? null)
                : null
              return (
                <div
                  key={surface.id}
                  data-active-tab={active}
                  role="presentation"
                  onMouseDown={handleTabMouseDown}
                  onAuxClick={(event) => handleTabAuxClick(event, surface)}
                  onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                  className={cn(
                    'group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm',
                    active
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          aria-controls={panelId}
                          aria-selected={active}
                          id={`${tabsetId}-tab-${surfaceIndex}`}
                          ref={(element) =>
                          {
                            if (element) tabButtonRefs.current.set(surface.id, element)
                            else tabButtonRefs.current.delete(surface.id)
                          }}
                          role="tab"
                          tabIndex={active ? 0 : -1}
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1.5"
                          onClick={() => props.onActivate(surface)}
                          onKeyDown={(event) => handleTabKeyDown(event, surfaceIndex)}
                        >
                          <SurfaceIcon
                            surface={surface}
                            sessions={props.previewSessions}
                            desktopByTabId={props.desktopByTabId}
                            theme={resolvedTheme}
                          />
                          <span className="truncate">{title}</span>
                        </button>
                      }
                    />
                    <TooltipPopup>{tooltip}</TooltipPopup>
                  </Tooltip>
                  {audio === 'none' || !audioRuntimeTabId ? null : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted"
                            aria-label={audio === 'muted' ? `Unmute ${title}` : `Mute ${title}`}
                            onClick={(event) =>
                              {
                              event.stopPropagation()
                              void previewBridge
                                ?.setAudioMuted(audioRuntimeTabId, audio !== 'muted')
                                .catch(() => undefined)
                            }}
                          >
                            {audio === 'muted' ? (
                              <VolumeOff className="size-3" />
                            ) : (
                              <Volume2 className="size-3" />
                            )}
                          </button>
                        }
                      />
                      <TooltipPopup>{audio === 'muted' ? 'Unmute tab' : 'Mute tab'}</TooltipPopup>
                    </Tooltip>
                  )}
                  <button
                    type="button"
                    className={cn(
                      'relative flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted focus:opacity-100',
                      pending ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                    aria-label={`Close ${title}`}
                    onClick={(event) =>
                    {
                      event.stopPropagation()
                      closeSurface(surface)
                    }}
                  >
                    {pending ? (
                      <>
                        <span
                          className="size-2 rounded-full bg-current group-hover:hidden"
                          aria-hidden
                        />
                        <X className="hidden size-3 group-hover:block" />
                      </>
                    ) : (
                      <X className="size-3" />
                    )}
                  </button>
                </div>
              )
            })}
            {props.surfaces.length > 0 ? (
              <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
                <MenuTrigger
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Add panel surface"
                >
                  <Plus className="size-4" />
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  className="min-w-44"
                  onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                >
                  {addSurfaceActions.map((action) =>
                    {
                    const Icon = action.icon
                    return (
                      <SurfaceMenuItem
                        key={action.label}
                        available={action.available}
                        {...('disabledReason' in action
                          ? { disabledReason: action.disabledReason }
                          : {})}
                        shortcut={action.shortcut}
                        onClick={action.onClick}
                      >
                        <Icon />
                        {action.label}
                      </SurfaceMenuItem>
                    )
                  })}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {props.layoutControls}
      </div>
      <div
        aria-labelledby={activeTabId}
        className="flex min-h-0 flex-1 flex-col"
        id={panelId}
        role={props.activeSurfaceId === null ? undefined : 'tabpanel'}
      >
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddWorkers={props.onAddWorkers}
            onAddRepositoryAtlas={props.onAddRepositoryAtlas ?? NOOP_SURFACE_ACTION}
            onAddExplorer={props.onAddExplorer ?? NOOP_SURFACE_ACTION}
            browserAvailable={props.browserAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            repositoryAtlasAvailable={props.repositoryAtlasAvailable === true}
            explorerAvailable={props.explorerAvailable === true}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  )
}
