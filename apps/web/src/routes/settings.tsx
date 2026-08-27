// apps/web/src/routes/settings.tsx
// declares settings routes and navigation metadata
import { RotateCcwIcon } from 'lucide-react'
import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { useCallback, useEffect, useEffectEvent, useState } from 'react'

import { useSettingsRestore } from '../components/settings/SettingsPanels'
import { SETTINGS_SEARCH_INPUT_ID } from '../components/settings/settingsSearch'
import { Button } from '../components/ui/button'
import { SidebarInset, useSidebar } from '../components/ui/sidebar'
import { isElectron } from '../env'
import { cn } from '~/lib/utils'
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from '~/lib/workspaceTitlebar'

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void })
{
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored)

  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore defaults
    </Button>
  )
}

function SettingsContentLayout()
{
  const location = useLocation()
  const navigate = useNavigate()
  const canGoBack = useCanGoBack()
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar()
  const [restoreSignal, setRestoreSignal] = useState(0)
  const showRestoreDefaults = location.pathname === '/settings/general'
  const handleRestored = () => setRestoreSignal((value) => value + 1)
  const navigateBackWithinApp = useCallback(() =>
  {
    if (canGoBack)
    {
      window.history.back()
      return
    }
    void navigate({ to: '/' })
  }, [canGoBack, navigate])

  // the route stays mounted when the mobile sidebar's contents do not
  const handleSettingsKeyDown = useEffectEvent((event: KeyboardEvent): boolean =>
  {
    if (event.defaultPrevented) return false
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey)
    {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') ||
          target.isContentEditable ||
          (target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null &&
            target.closest('[data-sidebar="sidebar"]') === null))
      )
      {
        return false
      }

      event.preventDefault()
      if (isMobile) setOpenMobile(true)
      else if (!open) setOpen(true)
      return true
    }
    if (event.key === 'Escape')
    {
      event.preventDefault()
      const activeElement = document.activeElement
      if (activeElement instanceof HTMLElement) activeElement.blur()
      navigateBackWithinApp()
    }
    return false
  })

  useEffect(() =>
  {
    let focusFrame: number | undefined
    const onKeyDown = (event: KeyboardEvent) =>
    {
      if (!handleSettingsKeyDown(event)) return
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
      focusFrame = requestAnimationFrame(() =>
      {
        const input = document.getElementById(SETTINGS_SEARCH_INPUT_ID)
        if (input instanceof HTMLInputElement)
        {
          input.focus()
          input.select()
        }
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () =>
    {
      window.removeEventListener('keydown', onKeyDown)
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    }
  }, [])

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              'px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5',
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              <span className="text-sm font-medium text-foreground">Settings</span>
              {showRestoreDefaults ? (
                <div className="ms-auto flex items-center gap-2">
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </div>
              ) : null}
            </div>
          </header>
        )}

        {isElectron && (
          <div
            className={cn(
              'drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]',
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            {showRestoreDefaults ? (
              <div className="ms-auto flex items-center gap-2">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        )}

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  )
}

function SettingsRouteLayout()
{
  return <SettingsContentLayout />
}

export const Route = createFileRoute('/settings')({
  beforeLoad: async ({ context, location }) =>
  {
    if (
      context.authGateState.status !== 'authenticated' &&
      context.authGateState.status !== 'hosted-static'
    )
    {
      throw redirect({ to: '/pair', replace: true })
    }

    if (location.pathname === '/settings')
    {
      throw redirect({ to: '/settings/general', replace: true })
    }
  },
  component: SettingsRouteLayout,
})
