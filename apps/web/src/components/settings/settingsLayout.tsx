// apps/web/src/components/settings/settingsLayout.tsx
// render settings layout

import { Undo2Icon } from 'lucide-react'
import { useLocation } from '@tanstack/react-router'
import {
  createContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'

import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'

const SettingsSearchTargetContext = createContext<string | null>(null)

export function scrollToSettingsTarget(targetId: string): boolean
{
  const target = document.getElementById(targetId)
  if (!target) return false

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // center the visible section heading, not the middle of a long panel
  const scrollTarget = target.tagName === 'SECTION' ? (target.firstElementChild ?? target) : target
  scrollTarget.scrollIntoView({
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
    block: 'center',
  })
  target.focus({ preventScroll: true })
  return true
}

function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined)
{
  const targetId = useContext(SettingsSearchTargetContext)
  const targetRef = useRef<T>(null)
  useEffect(() =>
  {
    if (id && id === targetId && targetRef.current)
    {
      scrollToSettingsTarget(id)
    }
  }, [id, targetId])
  return targetRef
}

// re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels.
export function useRelativeTimeTick(intervalMs = 1_000)
{
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() =>
  {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return nowMs
}

export function SettingsSection({
  title,
  icon,
  headerAction,
  children,
  className,
  ...sectionProps
}: ComponentPropsWithoutRef<'section'> & {
  title: string
  icon?: ReactNode
  headerAction?: ReactNode
  children: ReactNode
})
{
  const targetRef = useSettingsSearchTarget<HTMLElement>(sectionProps.id)
  return (
    <section
      {...sectionProps}
      ref={targetRef}
      tabIndex={sectionProps.id ? -1 : sectionProps.tabIndex}
      className={cn('space-y-3 scroll-mt-4', className)}
    >
      <div className="flex min-h-8 items-center justify-between gap-4 px-3 sm:px-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.025em] text-foreground">
          {icon}
          {title}
        </h2>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
      </div>
      <div className="relative space-y-1 overflow-visible text-foreground">{children}</div>
    </section>
  )
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
  title: ReactNode
  description: ReactNode
  status?: ReactNode
  resetAction?: ReactNode
  control?: ReactNode
  children?: ReactNode
})
{
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowProps.id)
  return (
    <div
      {...rowProps}
      ref={targetRef}
      tabIndex={rowProps.id ? -1 : rowProps.tabIndex}
      className={cn('rounded-xl px-3 sm:px-4', children ? 'pt-3 pb-1' : 'py-3', className)}
    >
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
            {description}
          </p>
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  )
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void })
{
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) =>
            {
              event.stopPropagation()
              onClick()
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  )
}

export function SettingsPageContainer({
  children,
  className,
}: {
  children: ReactNode
  className?: string
})
{
  const hash = useLocation({ select: (location) => location.hash })
  const targetId = hash.replace(/^#/u, '') || null
  return (
    <SettingsSearchTargetContext value={targetId}>
      <div className="settings-page-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto px-4 pt-10 pb-7 sm:px-8 sm:pt-12 sm:pb-10">
        <div className={cn('mx-auto flex w-full max-w-4xl flex-col gap-12', className)}>
          {children}
        </div>
      </div>
    </SettingsSearchTargetContext>
  )
}
