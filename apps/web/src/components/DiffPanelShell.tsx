// apps/web/src/components/DiffPanelShell.tsx
// render the diff panel shell and accessible view tabs

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { isElectron } from '~/env'
import { cn } from '~/lib/utils'

import { Skeleton } from './ui/skeleton'

export type DiffPanelMode = 'inline' | 'sheet' | 'sidebar' | 'embedded'
export type DiffPanelView = 'changes' | 'architecture'

export function DiffPanelChangesAvailability(props: {
  hasActiveThread: boolean
  isCurrentPathGitRepository: boolean
  readsRetainedRepositoryIdentity: boolean
  hasSelectedTurn: boolean
  hasCompletedTurns: boolean
  children: ReactNode
})
{
  if (!props.hasActiveThread)
  {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Select a thread to inspect turn diffs.
      </div>
    )
  }
  if (!props.isCurrentPathGitRepository && !props.readsRetainedRepositoryIdentity)
  {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Turn diffs are unavailable because this project is not a git repository.
      </div>
    )
  }
  if (props.hasSelectedTurn && !props.hasCompletedTurns)
  {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        No completed turns yet.
      </div>
    )
  }
  return props.children
}

function getDiffPanelHeaderRowClassName(mode: DiffPanelMode)
{
  const shouldUseDragRegion = isElectron && mode !== 'sheet' && mode !== 'embedded'
  return cn(
    'flex items-center justify-between gap-2 px-4',
    shouldUseDragRegion
      ? 'drag-region h-[52px] border-b border-border wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]'
      : 'surface-subheader',
  )
}

export function DiffPanelShell(props: {
  mode: DiffPanelMode
  header: ReactNode
  children: ReactNode
})
{
  const shouldUseDragRegion = isElectron && props.mode !== 'sheet' && props.mode !== 'embedded'

  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-col bg-background',
        props.mode === 'inline'
          ? 'w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border'
          : 'w-full',
      )}
    >
      <div
        className={getDiffPanelHeaderRowClassName(props.mode)}
        data-surface-subheader={shouldUseDragRegion ? undefined : true}
      >
        {props.header}
      </div>
      {props.children}
    </div>
  )
}

export function DiffPanelViews(props: {
  activeView: DiffPanelView
  onViewChange: (view: DiffPanelView) => void
  changes: ReactNode
  architecture: ReactNode
})
{
  const id = useId()
  const [architectureVisited, setArchitectureVisited] = useState(
    props.activeView === 'architecture',
  )
  const changesTabRef = useRef<HTMLButtonElement>(null)
  const architectureTabRef = useRef<HTMLButtonElement>(null)
  const changesTabId = `${id}-changes-tab`
  const architectureTabId = `${id}-architecture-tab`
  const changesPanelId = `${id}-changes-panel`
  const architecturePanelId = `${id}-architecture-panel`

  useEffect(() =>
  {
    if (props.activeView === 'architecture') setArchitectureVisited(true)
  }, [props.activeView])

  const selectView = (view: DiffPanelView): void =>
  {
    if (view === 'architecture') setArchitectureVisited(true)
    props.onViewChange(view)
  }

  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) =>
  {
    const nextView =
      event.key === 'ArrowLeft' || event.key === 'Home'
        ? 'changes'
        : event.key === 'ArrowRight' || event.key === 'End'
          ? 'architecture'
          : null
    if (nextView === null) return
    event.preventDefault()
    selectView(nextView)
    if (nextView === 'changes') changesTabRef.current?.focus()
    else architectureTabRef.current?.focus()
  }

  return (
    <>
      <div
        className="flex h-9 shrink-0 items-end gap-1 border-b border-border px-4"
        role="tablist"
        aria-label="Diff views"
      >
        <button
          ref={changesTabRef}
          id={changesTabId}
          type="button"
          role="tab"
          aria-controls={changesPanelId}
          aria-selected={props.activeView === 'changes'}
          tabIndex={props.activeView === 'changes' ? 0 : -1}
          className={cn(
            'relative h-8 px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            props.activeView === 'changes' &&
              'text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-foreground',
          )}
          onClick={() => selectView('changes')}
          onKeyDown={selectFromKeyboard}
        >
          Changes
        </button>
        <button
          ref={architectureTabRef}
          id={architectureTabId}
          type="button"
          role="tab"
          aria-controls={architecturePanelId}
          aria-selected={props.activeView === 'architecture'}
          tabIndex={props.activeView === 'architecture' ? 0 : -1}
          className={cn(
            'relative h-8 px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            props.activeView === 'architecture' &&
              'text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-foreground',
          )}
          onClick={() => selectView('architecture')}
          onKeyDown={selectFromKeyboard}
        >
          Impact Diff
        </button>
      </div>
      <div
        id={changesPanelId}
        className="flex min-h-0 flex-1 flex-col"
        role="tabpanel"
        aria-labelledby={changesTabId}
        hidden={props.activeView !== 'changes'}
      >
        {props.changes}
      </div>
      <div
        id={architecturePanelId}
        className="flex min-h-0 flex-1 flex-col"
        role="tabpanel"
        aria-labelledby={architectureTabId}
        hidden={props.activeView !== 'architecture'}
      >
        {architectureVisited || props.activeView === 'architecture' ? props.architecture : null}
      </div>
    </>
  )
}

export function DiffPanelHeaderSkeleton()
{
  return (
    <>
      <div className="min-w-0 flex-1">
        <Skeleton className="h-8 w-32 rounded-lg" />
      </div>
      <div className="flex shrink-0 gap-1">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
    </>
  )
}

export function DiffPanelLoadingState(props: { label: string })
{
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-card/25"
        role="status"
        aria-live="polite"
        aria-label={props.label}
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="ml-auto h-4 w-20 rounded-full" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-4">
          <div className="space-y-2">
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-10/12 rounded-full" />
            <Skeleton className="h-3 w-11/12 rounded-full" />
            <Skeleton className="h-3 w-9/12 rounded-full" />
          </div>
          <span className="sr-only">{props.label}</span>
        </div>
      </div>
    </div>
  )
}
