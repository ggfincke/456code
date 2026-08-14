// apps/web/src/components/architecture/ArchitectureDetailsDrawer.tsx
// presents one contextual architecture detail region as a drawer or narrow sheet

import { XIcon } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, type ReactNode } from 'react'

import { Button } from '~/components/ui/button'
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from '~/components/ui/sheet'

export interface ArchitectureDetailsDrawerProps
{
  readonly open: boolean
  readonly narrow: boolean
  readonly title: string
  readonly description?: string | undefined
  readonly children: ReactNode
  readonly returnFocus?: HTMLElement | null | undefined
  readonly onClose: () => void
}

export function ArchitectureDetailsDrawer(props: ArchitectureDetailsDrawerProps)
{
  const drawerId = useId()
  const titleId = useId()
  const descriptionId = useId()
  const close = useCallback((): void =>
  {
    props.onClose()
    if (!props.narrow && props.returnFocus?.isConnected) props.returnFocus.focus()
  }, [props.narrow, props.onClose, props.returnFocus])

  useEffect(() =>
  {
    if (!props.open || !props.returnFocus?.isConnected) return

    const trigger = props.returnFocus
    const previousControls = trigger.getAttribute('aria-controls')
    const previousExpanded = trigger.getAttribute('aria-expanded')
    trigger.setAttribute('aria-controls', drawerId)
    trigger.setAttribute('aria-expanded', 'true')

    return () =>
    {
      if (previousControls === null) trigger.removeAttribute('aria-controls')
      else trigger.setAttribute('aria-controls', previousControls)
      if (previousExpanded === null) trigger.removeAttribute('aria-expanded')
      else trigger.setAttribute('aria-expanded', previousExpanded)
    }
  }, [drawerId, props.open, props.returnFocus])

  useEffect(() =>
  {
    if (!props.open || props.narrow) return

    const closeOnEscape = (event: globalThis.KeyboardEvent): void =>
    {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    globalThis.addEventListener('keydown', closeOnEscape)
    return () => globalThis.removeEventListener('keydown', closeOnEscape)
  }, [close, props.narrow, props.open])

  if (!props.open)
  {
    return <span aria-live="polite" className="sr-only" />
  }

  if (props.narrow)
  {
    return (
      <Sheet
        open
        onOpenChange={(open) =>
        {
          if (!open) close()
        }}
      >
        <SheetPopup
          className="architecture-surface max-w-sm border-[var(--architecture-border)] bg-[var(--architecture-surface)] text-[var(--architecture-text)]"
          finalFocus={() => props.returnFocus}
          id={drawerId}
          side="right"
        >
          <SheetHeader>
            <SheetTitle>{props.title}</SheetTitle>
            {props.description ? <SheetDescription>{props.description}</SheetDescription> : null}
          </SheetHeader>
          <SheetPanel className="space-y-4">{props.children}</SheetPanel>
        </SheetPopup>
      </Sheet>
    )
  }

  return (
    <Fragment>
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        Details opened for {props.title}
      </span>
      <aside
        aria-describedby={props.description ? descriptionId : undefined}
        aria-labelledby={titleId}
        className="architecture-surface fixed end-4 top-20 z-50 flex max-h-[min(30rem,calc(100dvh-6rem))] w-[min(19rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-[var(--architecture-border)] bg-[color-mix(in_srgb,var(--architecture-overlay)_96%,transparent)] text-[var(--architecture-text)] shadow-[-8px_12px_32px_rgba(1,4,9,.5)] ring-1 ring-[color-mix(in_srgb,var(--architecture-accent)_12%,transparent)] backdrop-blur-md"
        data-architecture-details-drawer
        id={drawerId}
        role="region"
      >
        <header className="relative shrink-0 border-b border-[var(--architecture-border-soft)] bg-[color-mix(in_srgb,var(--architecture-surface)_82%,transparent)] px-3 py-2.5 pe-10">
          <h2 className="truncate text-[13px] font-semibold" id={titleId}>
            {props.title}
          </h2>
          {props.description ? (
            <p
              className="mt-0.5 truncate font-mono text-[9px] text-[var(--architecture-text-faint)]"
              id={descriptionId}
              title={props.description}
            >
              {props.description}
            </p>
          ) : null}
          <Button
            aria-label="Close architecture details"
            className="absolute end-2 top-2 text-[var(--architecture-text-muted)] hover:bg-[var(--architecture-hover)] hover:text-[var(--architecture-text)]"
            size="icon-xs"
            variant="ghost"
            onClick={close}
          >
            <XIcon />
          </Button>
        </header>
        <div className="min-h-0 space-y-3 overflow-y-auto p-3 [&_[data-slot=button]]:!border-[var(--architecture-border)] [&_[data-slot=button]]:!bg-transparent [&_[data-slot=button]]:!text-[var(--architecture-accent)] [&_[data-slot=button]]:shadow-none [&_[data-slot=button]:hover]:!bg-[var(--architecture-hover)]">
          {props.children}
        </div>
      </aside>
    </Fragment>
  )
}
