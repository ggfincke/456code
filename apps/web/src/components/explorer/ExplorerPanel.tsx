// apps/web/src/components/explorer/ExplorerPanel.tsx
// presents proposal narrative, exact code changes, and a compact architecture summary
import type {
  ArchitectureImpactResult,
  ImplementationAttemptOutcome,
  MdxSafeDocument,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { ArrowRight, BookOpenText, FileDiff, Network, RotateCcw } from 'lucide-react'
import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'

import { cn } from '~/lib/utils'

import { SafeDocumentRenderer } from '../files/SafeDocumentRenderer'
import {
  ProposalDiffPanel,
  type ProposalDiffAvailability,
  type ProposalDiffFileActions,
  type ProposalDiffPresentation,
} from '../proposals/ProposalDiffPanel'

export type ExplorerTab = 'narrative' | 'code-changes'

export type ExplorerNarrativePresentation =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready'
      readonly document: MdxSafeDocument
      readonly source: string
      readonly documentPath: string
    }

export type ExplorerArchitecturePresentation =
  | { readonly kind: 'loading'; readonly message?: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string; readonly retry?: () => void }
  | {
      readonly kind: 'impact'
      readonly result: ArchitectureImpactResult | null
      readonly error: string | null
      readonly isPending: boolean
      readonly hasSettled: boolean
      readonly notices?: readonly string[]
      readonly onRetry: () => void
      readonly onOpen: () => void
    }

export interface ExplorerImplementationAttemptPresentation
{
  readonly outcome: ImplementationAttemptOutcome
  readonly matchedOperationCount: number
  readonly intendedOperationCount: number
}

export interface ExplorerPanelProps
{
  readonly threadRef: ScopedThreadRef
  readonly narrative: ExplorerNarrativePresentation
  readonly proposal: ProposalDiffPresentation | null
  readonly proposalAvailability?: ProposalDiffAvailability
  readonly proposalFileActions?: ProposalDiffFileActions
  readonly architecture: ExplorerArchitecturePresentation
  readonly attempt?: ExplorerImplementationAttemptPresentation | null
  readonly defaultTab?: ExplorerTab
  readonly onOpenFile: (path: string, line?: number) => void
}

const EXPLORER_TABS = [
  { id: 'narrative', label: 'Narrative', icon: BookOpenText },
  { id: 'code-changes', label: 'Changes', icon: FileDiff },
] as const satisfies ReadonlyArray<{
  readonly id: ExplorerTab
  readonly label: string
  readonly icon: typeof BookOpenText
}>

function StateMessage(props: {
  readonly title: string
  readonly message: string
  readonly tone?: 'neutral' | 'error' | 'warning'
  readonly action?: { readonly label: string; readonly onClick: () => void }
})
{
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center',
        props.tone === 'error' && 'text-destructive',
        props.tone === 'warning' && 'text-amber-700 dark:text-amber-200',
      )}
      role={props.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="max-w-md">
        <p className="text-sm font-medium">{props.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.message}</p>
        {props.action ? (
          <button
            type="button"
            className="mt-3 inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted"
            onClick={props.action.onClick}
          >
            {props.action.label}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function NarrativeView(props: {
  readonly threadRef: ScopedThreadRef
  readonly narrative: ExplorerNarrativePresentation
  readonly onOpenFile: (path: string, line?: number) => void
})
{
  switch (props.narrative.kind)
  {
    case 'loading':
      return (
        <StateMessage title="Loading narrative" message="Preparing the safe proposal document." />
      )
    case 'empty':
      return <StateMessage title="No narrative" message={props.narrative.message} />
    case 'error':
      return (
        <StateMessage
          title="Narrative unavailable"
          message={props.narrative.message}
          tone="error"
        />
      )
    case 'ready':
      return (
        <SafeDocumentRenderer
          document={props.narrative.document}
          source={props.narrative.source}
          documentPath={props.narrative.documentPath}
          environmentId={props.threadRef.environmentId}
          threadId={props.threadRef.threadId}
          onOpenFile={props.onOpenFile}
        />
      )
  }
}

function ArchitectureSummaryRow(props: {
  readonly architecture: ExplorerArchitecturePresentation
})
{
  const presentation = props.architecture
  if (presentation.kind === 'loading')
  {
    return (
      <div
        className="flex min-h-12 items-center gap-3 border-b border-border bg-muted/20 px-4 py-2"
        role="status"
      >
        <Network className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">Architecture analysis</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {presentation.message ?? 'Preparing the exact proposal comparison.'}
          </p>
        </div>
      </div>
    )
  }
  if (presentation.kind === 'unavailable' || presentation.kind === 'error')
  {
    const message = presentation.kind === 'unavailable' ? presentation.reason : presentation.message
    const retry = presentation.kind === 'error' ? presentation.retry : undefined
    return (
      <div className="flex min-h-12 items-center gap-3 border-b border-border bg-muted/20 px-4 py-2">
        <Network className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">Architecture impact unavailable</p>
          <p className="truncate text-[11px] text-muted-foreground" title={message}>
            {message}
          </p>
        </div>
        {retry ? (
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Retry architecture analysis"
            onClick={retry}
          >
            <RotateCcw className="size-3.5" />
          </button>
        ) : null}
      </div>
    )
  }

  const result = presentation.result
  const resultStatus =
    result === null
      ? (presentation.error ??
        (presentation.isPending || !presentation.hasSettled
          ? 'Loading the exact graph diff.'
          : 'Exact graph diff is not available yet.'))
      : result.changed
        ? 'Architecture changed'
        : 'No architecture changes'
  const exactTotals =
    result === null
      ? null
      : `+${result.addedNodes.total}/-${result.removedNodes.total} files · +${result.addedEdges.total}/-${result.removedEdges.total} imports`
  const notice = presentation.notices?.[0]
  return (
    <div
      className="flex min-h-14 items-center gap-3 border-b border-border bg-muted/20 px-4 py-2"
      data-proposal-architecture-summary
    >
      <Network
        className={cn(
          'size-4 shrink-0',
          result?.changed ? 'text-primary' : 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="truncate text-xs font-medium text-foreground">{resultStatus}</p>
          {exactTotals ? (
            <p className="shrink-0 font-mono text-[11px] text-muted-foreground">{exactTotals}</p>
          ) : null}
        </div>
        <p className="truncate text-[11px] text-muted-foreground" title={notice ?? result?.summary}>
          {notice ?? result?.summary ?? 'The graph diff opens as a separate native surface.'}
        </p>
      </div>
      {presentation.error !== null ? (
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Retry graph diff"
          onClick={presentation.onRetry}
        >
          <RotateCcw className="size-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent"
        onClick={presentation.onOpen}
      >
        Open graph diff
        <ArrowRight className="size-3.5" />
      </button>
    </div>
  )
}

function attemptMessage(attempt: ExplorerImplementationAttemptPresentation): {
  readonly tone: 'neutral' | 'success' | 'warning' | 'error'
  readonly text: string
}
{
  switch (attempt.outcome)
  {
    case 'pending':
      return { tone: 'neutral', text: 'Implementation comparison is pending.' }
    case 'matched':
      return { tone: 'success', text: 'The implementation matches this proposal revision.' }
    case 'partial':
      return {
        tone: 'warning',
        text: `The implementation partially matches this proposal revision (${attempt.matchedOperationCount} of ${attempt.intendedOperationCount} intended operations).`,
      }
    case 'divergent':
      return { tone: 'error', text: 'The implementation diverges from this proposal revision.' }
  }
}

function AttemptOutcome(props: {
  readonly attempt: ExplorerImplementationAttemptPresentation | null | undefined
})
{
  if (!props.attempt) return null
  const message = attemptMessage(props.attempt)
  return (
    <div
      className={cn(
        'border-b px-4 py-2 text-xs',
        message.tone === 'neutral' && 'border-border bg-muted/30 text-muted-foreground',
        message.tone === 'success' && 'border-success/20 bg-success/8 text-success',
        message.tone === 'warning' &&
          'border-amber-500/20 bg-amber-500/8 text-amber-800 dark:text-amber-200',
        message.tone === 'error' && 'border-destructive/20 bg-destructive/8 text-destructive',
      )}
      role="status"
      data-implementation-outcome={props.attempt.outcome}
    >
      {message.text}
    </div>
  )
}

// inactive proposal views stay mounted so narrative and diff state do not reset
function TabPanel(props: {
  readonly tabsetId: string
  readonly id: ExplorerTab
  readonly activeTab: ExplorerTab
  readonly children: ReactNode
})
{
  const active = props.id === props.activeTab
  return (
    <div
      id={`${props.tabsetId}-panel-${props.id}`}
      role="tabpanel"
      aria-labelledby={`${props.tabsetId}-tab-${props.id}`}
      hidden={!active}
      className={cn('min-h-0 flex-1 flex-col', active ? 'flex' : 'hidden')}
    >
      {props.children}
    </div>
  )
}

function UnavailableCodeChanges(props: {
  readonly availability: ProposalDiffAvailability | undefined
})
{
  if (props.availability?.kind === 'loading')
  {
    return (
      <StateMessage
        title="Loading code changes"
        message="Loading the immutable proposal revision and its exact diff."
      />
    )
  }
  if (props.availability?.kind === 'error')
  {
    return (
      <StateMessage
        title="Code changes unavailable"
        message={props.availability.message}
        tone="error"
      />
    )
  }
  return (
    <StateMessage
      title="Code changes unavailable"
      message={
        props.availability?.kind === 'unsupported'
          ? props.availability.reason
          : 'No immutable proposal revision is selected.'
      }
    />
  )
}

export function ExplorerPanel(props: ExplorerPanelProps)
{
  const tabsetId = useId()
  const [activeTab, setActiveTab] = useState<ExplorerTab>(props.defaultTab ?? 'narrative')
  const tabRefs = useRef<Partial<Record<ExplorerTab, HTMLButtonElement | null>>>({})
  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tabIndex: number,
  ): void =>
  {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (tabIndex + 1) % EXPLORER_TABS.length
    else if (event.key === 'ArrowLeft')
    {
      nextIndex = (tabIndex - 1 + EXPLORER_TABS.length) % EXPLORER_TABS.length
    }
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = EXPLORER_TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = EXPLORER_TABS[nextIndex]
    if (!nextTab) return
    setActiveTab(nextTab.id)
    tabRefs.current[nextTab.id]?.focus()
  }
  const proposalLabel = props.proposal
    ? `Preview of proposal revision ${props.proposal.revisionNumber} against workspace snapshot ${props.proposal.snapshotTreeOid}`
    : 'No immutable proposal revision selected'

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Proposal Review"
    >
      <header className="shrink-0 border-b border-border bg-card/40">
        <p className="truncate px-4 pt-3 text-xs font-medium text-foreground" title={proposalLabel}>
          {proposalLabel}
        </p>
        <div className="flex gap-1 px-2 pt-2" role="tablist" aria-label="Proposal Review views">
          {EXPLORER_TABS.map((tab, tabIndex) =>
          {
            const Icon = tab.icon
            const selected = activeTab === tab.id
            return (
              <button
                key={tab.id}
                ref={(element) =>
                {
                  tabRefs.current[tab.id] = element
                }}
                id={`${tabsetId}-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${tabsetId}-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs transition-colors',
                  selected
                    ? 'border-border bg-background text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
              >
                <Icon className="size-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </header>
      <AttemptOutcome attempt={props.attempt} />
      <ArchitectureSummaryRow architecture={props.architecture} />
      <TabPanel tabsetId={tabsetId} id="narrative" activeTab={activeTab}>
        <NarrativeView
          threadRef={props.threadRef}
          narrative={props.narrative}
          onOpenFile={props.onOpenFile}
        />
      </TabPanel>
      <TabPanel tabsetId={tabsetId} id="code-changes" activeTab={activeTab}>
        {props.proposal ? (
          <ProposalDiffPanel
            proposal={props.proposal}
            composerDraftTarget={props.threadRef}
            {...(props.proposalAvailability ? { availability: props.proposalAvailability } : {})}
            {...(props.proposalFileActions ? { fileActions: props.proposalFileActions } : {})}
            selectedFilePath={null}
            selectedFileRevealRequestId={0}
          />
        ) : (
          <UnavailableCodeChanges availability={props.proposalAvailability} />
        )}
      </TabPanel>
    </section>
  )
}
