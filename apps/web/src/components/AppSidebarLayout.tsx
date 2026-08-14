// apps/web/src/components/AppSidebarLayout.tsx
// render app sidebar layout

import { useAtomValue } from '@effect/atom-react'
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopedProjectKey,
} from '@t3tools/client-runtime/environment'
import {
  resolveThreadAttention,
  threadAttentionNeedsAction,
} from '@t3tools/client-runtime/state/thread-settled'
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type DesktopMenuBarState,
  type ServerProvider,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'

import { isElectron } from '../env'
import { getLocalStorageItem } from '../hooks/useLocalStorage'
import { useNowMinute } from '../hooks/useNowMinute'
import { resolveShortcutCommand, shortcutLabelForCommand } from '../keybindings'
import { cn, isMacPlatform } from '../lib/utils'
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from '../state/server'
import { useClientSettings } from '../hooks/useSettings'
import { useProjects, useThreadShells } from '../state/entities'
import { buildThreadRouteParams } from '../threadRoutes'
import ThreadSidebar from './Sidebar'
import { resolveThreadStatusPill } from './Sidebar.logic'
import ThreadSidebarV2 from './SidebarV2'
import { useSidebarStageBackdropVariant } from './SidebarStageBackdrop'
import { selectLongestProviderUsageWindow } from './chat/ProviderUsage'
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from './threadSidebarWidth'
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from './ui/sidebar'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip'

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = '90px'
const MENU_BAR_OPEN_THREAD_ACTION_PREFIX = 'open-thread:'
const MENU_BAR_RECENT_THREAD_LIMIT = 5
const MENU_BAR_USAGE_PROVIDERS = [
  { driver: ProviderDriverKind.make('codex'), label: 'Codex' },
  { driver: ProviderDriverKind.make('claude'), label: 'Claude' },
] as const

function parseMenuBarOpenThreadAction(action: string)
{
  if (!action.startsWith(MENU_BAR_OPEN_THREAD_ACTION_PREFIX))
  {
    return null
  }

  try
  {
    return parseScopedThreadKey(
      decodeURIComponent(action.slice(MENU_BAR_OPEN_THREAD_ACTION_PREFIX.length)),
    )
  }
  catch
  {
    return null
  }
}

function sortableTimestamp(value: string): number
{
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function selectMenuBarUsageItems(
  providers: ReadonlyArray<ServerProvider>,
): DesktopMenuBarState['usageItems']
{
  return MENU_BAR_USAGE_PROVIDERS.flatMap(({ driver, label }) =>
  {
    const availableProviders = providers.filter(
      (provider) => provider.driver === driver && provider.accountUsage?.status === 'available',
    )
    const defaultInstanceId = defaultInstanceIdForDriver(driver)
    const provider =
      availableProviders.find((candidate) => candidate.instanceId === defaultInstanceId) ??
      availableProviders[0]
    const usage = provider?.accountUsage
    if (usage?.status !== 'available')
    {
      return []
    }

    const window = selectLongestProviderUsageWindow(usage.windows)
    return window === null
      ? []
      : [
          {
            providerLabel: label,
            windowLabel: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
          },
        ]
  })
}

function subscribeToViewportWidth(onChange: () => void): () => void
{
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

function readViewportWidth(): number
{
  return window.innerWidth
}

function readInitialThreadSidebarWidth(): number
{
  try
  {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    )
  }
  catch (error)
  {
    console.error('Could not read persisted thread sidebar width.', error)
    return resolveInitialThreadSidebarWidth(null, window.innerWidth)
  }
}

function SidebarControl()
{
  const keybindings = useAtomValue(primaryServerKeybindingsAtom)
  const { toggleSidebar } = useSidebar()
  const isSidebarVisible = useSidebarVisibility()
  const stageBackdropVariant = useSidebarStageBackdropVariant()
  const shortcutLabel = shortcutLabelForCommand(keybindings, 'sidebar.toggle')

  useEffect(() =>
  {
    const onKeyDown = (event: KeyboardEvent) =>
    {
      if (event.defaultPrevented) return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-keybinding-capture]')
      )
      {
        return
      }
      if (resolveShortcutCommand(event, keybindings) !== 'sidebar.toggle') return

      event.preventDefault()
      event.stopPropagation()
      toggleSidebar()
    }

    // capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [keybindings, toggleSidebar])

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className={cn(
                'pointer-events-auto',
                isSidebarVisible &&
                  stageBackdropVariant &&
                  '[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!',
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ''}
        </TooltipPopup>
      </Tooltip>
    </div>
  )
}

export function AppSidebarLayout({ children }: { children: ReactNode })
{
  const navigate = useNavigate()
  const projects = useProjects()
  const providers = useAtomValue(primaryServerProvidersAtom)
  const threads = useThreadShells()
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled)
  // settings routes render the settings nav, which lives in the v1 component
  // and is identical for both sidebars — so v1 stays mounted there.
  const pathname = useLocation({ select: (location) => location.pathname })
  const isOnSettings = pathname === '/settings' || pathname.startsWith('/settings/')
  const useSidebarV2 = sidebarV2Enabled && !isOnSettings
  const useSidebarV2Theme = useSidebarV2 || isOnSettings
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform)
  // the tray and the badge both classify staleness, which no shell event
  // announces, so this memo has to re-derive on a clock. It re-runs once a
  // minute and pushes one extra IPC message per minute on desktop; that is the
  // price of a badge that can report a run which stopped reporting.
  const nowMinute = useNowMinute()
  const menuBarState = useMemo<DesktopMenuBarState>(() =>
  {
    const nowMs = Date.parse(`${nowMinute}:00.000Z`)
    const projectTitleByKey = new Map(
      projects.map((project) => [
        scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
        project.title,
      ]),
    )
    const recentThreads = threads
      .filter((thread) => thread.archivedAt === null)
      .toSorted(
        (left, right) =>
          sortableTimestamp(right.updatedAt) - sortableTimestamp(left.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .flatMap((thread) =>
      {
        const projectTitle = projectTitleByKey.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        )
        if (projectTitle === undefined)
        {
          return []
        }
        // lastVisitedAt is deliberately not passed: without it the pill never
        // resolves to 'Completed', so the tray does not accumulate finished
        // rows the user cannot dismiss from there.
        const status = resolveThreadStatusPill({ thread, nowMs })
        return [
          {
            environmentId: thread.environmentId,
            threadId: thread.id,
            title: thread.title,
            projectTitle,
            ...(status === null ? {} : { status: status.label }),
          },
        ]
      })
      .slice(0, MENU_BAR_RECENT_THREAD_LIMIT)
    const usageItems = selectMenuBarUsageItems(providers)
    // counted over every thread, not over recentThreads: that list is capped
    // at five, so a badge derived from it would stop counting at five.
    const attentionCount = threads.filter((thread) =>
    {
      if (thread.archivedAt !== null) return false
      const attention = resolveThreadAttention(thread, { nowMs })
      return attention !== null && threadAttentionNeedsAction(attention)
    }).length

    return { recentThreads, usageItems, attentionCount }
  }, [nowMinute, projects, providers, threads])
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth)
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth)
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth)
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() =>
  {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState
    return isMacosDesktop && typeof getWindowFullscreenState === 'function'
      ? getWindowFullscreenState()
      : false
  })
  const sidebarProviderStyle = {
    '--sidebar-width': `${sidebarWidth}px`,
    ...(isMacosDesktop && !isWindowFullscreen
      ? { '--workspace-controls-left': MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
  } as CSSProperties

  useEffect(() =>
  {
    if (!isMacosDesktop) return
    const bridge = window.desktopBridge
    if (!bridge) return
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge
    if (
      typeof getWindowFullscreenState !== 'function' ||
      typeof onWindowFullscreenStateChange !== 'function'
    )
    {
      return
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen)
    setIsWindowFullscreen(getWindowFullscreenState())
    return unsubscribe
  }, [isMacosDesktop])

  useEffect(() =>
  {
    const setMenuBarState = window.desktopBridge?.setMenuBarState
    // every desktop platform sends this, not just macOS: the tray is macOS-only
    // and refuses the state harmlessly elsewhere, but the attention count rides
    // the same channel and is what draws the Windows overlay & the Linux
    // launcher badge. Gating on macOS is why neither of those ever appeared.
    if (!isElectron || typeof setMenuBarState !== 'function')
    {
      return
    }

    void setMenuBarState(menuBarState).catch((error) =>
    {
      console.error('Could not update the desktop menu bar state.', error)
    })
  }, [menuBarState])

  useEffect(() =>
  {
    const onMenuAction = window.desktopBridge?.onMenuAction
    if (typeof onMenuAction !== 'function')
    {
      return
    }

    const unsubscribe = onMenuAction((action) =>
    {
      const threadRef = parseMenuBarOpenThreadAction(action)
      if (threadRef !== null)
      {
        void navigate({
          to: '/$environmentId/$threadId',
          params: buildThreadRouteParams(threadRef),
        })
        return
      }

      if (action === 'new-thread')
      {
        void navigate({ to: '/' })
        return
      }

      if (action === 'open-settings')
      {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname)
        if (!isSettingsRoute)
        {
          void navigate({ to: '/settings' })
        }
      }
    })

    return () =>
    {
      unsubscribe?.()
    }
  }, [navigate, pathname])

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={sidebarProviderStyle}>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        data-sidebar-version={useSidebarV2Theme ? 'v2' : 'v1'}
        className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        resizable={{
          defaultWidth: THREAD_SIDEBAR_DEFAULT_WIDTH,
          maxWidth: sidebarMaximumWidth,
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth ||
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
          onResize: setSidebarWidth,
        }}
      >
        {useSidebarV2 ? <ThreadSidebarV2 /> : <ThreadSidebar />}
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  )
}
