// apps/web/src/components/architecture/ArchitectureScopeSurface.tsx
// connects exact architecture scopes to bounded drill and dependency presentations

import type {
  ArchitectureProjectionEdge,
  ArchitectureProjectionFile,
  ArchitectureProjectionSource,
  ArchitectureProjectionUnit,
  ArchitectureRelativePath,
  ArchitectureScopeSelector,
  ArchitectureStandingSource,
  CartographerGetArchitectureNeighborhoodResult,
  CartographerGetArchitectureScopeResult,
  EnvironmentId,
  ThreadId,
} from '@t3tools/contracts'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  FileCodeIcon,
  SearchIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '~/components/ui/button'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { cn } from '~/lib/utils'
import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'

import {
  architectureScopeSurfaceId,
  type ArchitectureScopeTarget,
} from './architectureResourceIdentity'
import { ArchitectureBoundedView } from './ArchitectureBoundedView'
import { ArchitectureDetailsDrawer } from './ArchitectureDetailsDrawer'
import { ArchitectureProjectionSummary } from './ArchitectureEvidenceList'
import { ArchitectureQueryState } from './ArchitectureQueryState'
import { useArchitectureSurfaceNarrow } from './useArchitectureSurfaceNarrow'

const ARCHITECTURE_SCOPE_PAGE_SIZE = 50
const ARCHITECTURE_NEIGHBORHOOD_DEPTH = 1

type NeighborhoodDirection = 'upstream' | 'downstream' | 'both'

export interface ArchitectureFileOpenTarget
{
  readonly source: ArchitectureProjectionSource
  readonly relativePath: ArchitectureRelativePath
}

export interface ArchitectureScopeSurfaceProps
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly target: ArchitectureScopeTarget
  readonly narrow?: boolean | undefined
  readonly embedded?: boolean | undefined
  readonly filesOnly?: boolean | undefined
  readonly onOpenScope: (target: ArchitectureScopeTarget) => void
  readonly onInspectScope?: ((target: ArchitectureScopeTarget) => void) | undefined
  readonly onOpenFile: (target: ArchitectureFileOpenTarget) => void
}

type StandingArchitectureScopeTarget = {
  readonly source: ArchitectureStandingSource
  readonly scope: ArchitectureScopeSelector
}

type FileNeighborhoodTarget = {
  readonly source: ArchitectureProjectionSource
  readonly scope: { readonly level: 'file-neighborhood'; readonly path: string }
}

type StandingArchitectureScopeQueryProps = Omit<ArchitectureScopeSurfaceProps, 'target'> & {
  readonly target: StandingArchitectureScopeTarget
}

type ArchitectureNeighborhoodQueryProps = Omit<ArchitectureScopeSurfaceProps, 'target'> & {
  readonly target: FileNeighborhoodTarget
}

interface CursorPageState
{
  readonly cursor: string | null
  readonly history: readonly (string | null)[]
}

interface CursorPager
{
  readonly cursor: string | null
  readonly page: number
  readonly hasPrevious: boolean
  readonly advance: (cursor: string) => void
  readonly previous: () => void
}

interface ScopePageEvidence
{
  readonly result: CartographerGetArchitectureScopeResult
  readonly childCursor: string | null
  readonly childPage: number
  readonly fileCursor: string | null
  readonly filePage: number
}

function useCursorPager(): CursorPager
{
  const [state, setState] = useState<CursorPageState>({ cursor: null, history: [] })
  return {
    cursor: state.cursor,
    page: state.history.length + 1,
    hasPrevious: state.history.length > 0,
    advance: (cursor) =>
      setState((current) => ({
        cursor,
        history: [...current.history, current.cursor],
      })),
    previous: () =>
      setState((current) =>
      {
        const cursor = current.history.at(-1) ?? null
        return { cursor, history: current.history.slice(0, -1) }
      }),
  }
}

function sameProjectionSource(
  left: ArchitectureProjectionSource,
  right: ArchitectureProjectionSource,
): boolean
{
  if (left.kind !== right.kind) return false
  switch (left.kind)
  {
    case 'proposal-generation':
      return (
        right.kind === left.kind &&
        left.threadId === right.threadId &&
        left.generationId === right.generationId &&
        left.side === right.side &&
        left.graphDigest === right.graphDigest
      )
    case 'diff-analysis':
      return (
        right.kind === left.kind &&
        left.threadId === right.threadId &&
        left.diffAnalysisId === right.diffAnalysisId &&
        left.side === right.side &&
        left.graphDigest === right.graphDigest
      )
    case 'standing-project-generation':
      return (
        right.kind === left.kind &&
        left.projectId === right.projectId &&
        left.generationId === right.generationId &&
        left.side === right.side &&
        left.graphDigest === right.graphDigest
      )
  }
}

function sameScope(left: ArchitectureScopeSelector, right: ArchitectureScopeSelector): boolean
{
  return left.level === right.level && left.id === right.id
}

function sourceLabel(source: ArchitectureProjectionSource): string
{
  switch (source.kind)
  {
    case 'proposal-generation':
      return `Proposal ${source.generationId.slice(0, 8)} · ${source.side}`
    case 'diff-analysis':
      return `Diff ${source.diffAnalysisId.slice(0, 8)} · ${source.side}`
    case 'standing-project-generation':
      return `Generation ${source.generationId.slice(0, 8)}`
  }
}

function PageControls(props: {
  readonly label: string
  readonly page: number
  readonly hasPrevious: boolean
  readonly hasNext: boolean
  readonly onPrevious: () => void
  readonly onNext: () => void
})
{
  if (!props.hasPrevious && !props.hasNext) return null

  return (
    <nav aria-label={`${props.label} pages`} className="flex items-center gap-2">
      <Button
        aria-label={`Previous ${props.label} page`}
        disabled={!props.hasPrevious}
        size="icon-xs"
        variant="ghost"
        onClick={props.onPrevious}
      >
        <ArrowLeftIcon />
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">Page {props.page}</span>
      <Button
        aria-label={`Next ${props.label} page`}
        disabled={!props.hasNext}
        size="icon-xs"
        variant="ghost"
        onClick={props.onNext}
      >
        <ArrowRightIcon />
      </Button>
    </nav>
  )
}

function ScopeHeader(props: {
  readonly source: ArchitectureProjectionSource
  readonly eyebrow: string
  readonly title: string
  readonly refreshing: boolean
  readonly compact?: boolean | undefined
  readonly onRefresh: () => void
})
{
  if (props.compact)
  {
    return (
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-3 py-2">
        <div className="min-w-0">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--architecture-text-faint)]">
            {props.eyebrow}
          </p>
          <h1
            className="truncate text-[13px] font-semibold text-[var(--architecture-text)]"
            title={props.title}
          >
            {props.title}
          </h1>
        </div>
        <Button
          aria-label="Refresh architecture scope"
          disabled={props.refreshing}
          size="icon-sm"
          variant="ghost"
          onClick={props.onRefresh}
        >
          <RefreshCwIcon className={props.refreshing ? 'animate-spin' : undefined} />
        </Button>
      </header>
    )
  }

  return (
    <header className="shrink-0 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-surface)] px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--architecture-text-faint)]">
            {props.eyebrow}
          </p>
          <h1
            className="mt-1 truncate text-[15px] font-semibold text-[var(--architecture-text)]"
            title={props.title}
          >
            {props.title}
          </h1>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-mono text-[10px] text-[var(--architecture-text-faint)]">
            <span>{sourceLabel(props.source)}</span>
            <span aria-hidden="true">·</span>
            <span title={props.source.graphDigest}>{props.source.graphDigest.slice(0, 15)}</span>
            {props.refreshing ? (
              <span className="inline-flex items-center gap-1.5">
                <RefreshCwIcon className="size-3 animate-spin" />
                Loading
              </span>
            ) : null}
          </div>
        </div>
        <Button
          aria-label="Refresh architecture scope"
          size="icon-sm"
          variant="ghost"
          onClick={props.onRefresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
    </header>
  )
}

function RefreshErrorBanner(props: { readonly message: string; readonly onRetry: () => void })
{
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/8 px-3 py-2 text-xs"
      role="alert"
    >
      <span>{props.message} The current bounded evidence remains visible.</span>
      <Button size="xs" variant="outline" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  )
}

function UnitDetails(props: {
  readonly unit: ArchitectureProjectionUnit
  readonly onOpen?: (() => void) | undefined
})
{
  return (
    <>
      {props.unit.description ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{props.unit.description}</p>
      ) : null}
      <dl className="divide-y divide-border rounded-lg border text-sm">
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-muted-foreground">Files</dt>
          <dd className="font-mono tabular-nums">{props.unit.fileCount}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-muted-foreground">Incoming</dt>
          <dd className="font-mono tabular-nums">{props.unit.inbound}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-muted-foreground">Outgoing</dt>
          <dd className="font-mono tabular-nums">{props.unit.outbound}</dd>
        </div>
      </dl>
      {props.onOpen ? (
        <Button className="w-full" size="sm" onClick={props.onOpen}>
          Open {props.unit.level === 'dirs' ? 'folder' : 'block'}
          <ArrowUpRightIcon />
        </Button>
      ) : null}
    </>
  )
}

function EdgeDetails(props: {
  readonly edge: ArchitectureProjectionEdge
  readonly units: readonly ArchitectureProjectionUnit[]
})
{
  const from = props.units.find((unit) => unit.id === props.edge.from)
  const to = props.units.find((unit) => unit.id === props.edge.to)

  return (
    <dl className="divide-y divide-border rounded-lg border text-sm">
      <div className="px-3 py-2">
        <dt className="text-xs text-muted-foreground">From</dt>
        <dd className="mt-1 min-w-0">
          <span className="block truncate font-medium">{from?.label ?? props.edge.from}</span>
          {from ? (
            <code className="mt-0.5 block truncate text-xs text-muted-foreground">
              {props.edge.from}
            </code>
          ) : null}
        </dd>
      </div>
      <div className="px-3 py-2">
        <dt className="text-xs text-muted-foreground">To</dt>
        <dd className="mt-1 min-w-0">
          <span className="block truncate font-medium">{to?.label ?? props.edge.to}</span>
          {to ? (
            <code className="mt-0.5 block truncate text-xs text-muted-foreground">
              {props.edge.to}
            </code>
          ) : null}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-4 px-3 py-2">
        <dt className="text-muted-foreground">Imports</dt>
        <dd className="font-mono tabular-nums">{props.edge.weight}</dd>
      </div>
    </dl>
  )
}

function FileDetails(props: {
  readonly file: ArchitectureProjectionFile
  readonly onOpen: () => void
  readonly onOpenNeighborhood: () => void
})
{
  const locations = [props.file.system, props.file.block, props.file.dir].filter(
    (value): value is string => value !== undefined,
  )

  return (
    <>
      <code className="block break-all text-xs text-muted-foreground">{props.file.id}</code>
      {props.file.description ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{props.file.description}</p>
      ) : null}
      <dl className="divide-y divide-border rounded-lg border text-sm">
        {locations.length > 0 ? (
          <div className="px-3 py-2">
            <dt className="text-xs text-muted-foreground">Architecture path</dt>
            <dd className="mt-1 break-words">{locations.join(' / ')}</dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-muted-foreground">Incoming</dt>
          <dd className="font-mono tabular-nums">{props.file.fanIn}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-muted-foreground">Outgoing</dt>
          <dd className="font-mono tabular-nums">{props.file.fanOut}</dd>
        </div>
      </dl>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button size="sm" variant="outline" onClick={props.onOpenNeighborhood}>
          Dependencies
        </Button>
        <Button size="sm" onClick={props.onOpen}>
          Open file
          <ArrowUpRightIcon />
        </Button>
      </div>
    </>
  )
}

function ScopeFiles(props: {
  readonly result: CartographerGetArchitectureScopeResult
  readonly open: boolean
  readonly selectedFileId: string | null
  readonly page: number
  readonly hasPrevious: boolean
  readonly hasNext: boolean
  readonly primary: boolean
  readonly onToggle: (open: boolean) => void
  readonly onSelect: (file: ArchitectureProjectionFile, trigger: HTMLButtonElement) => void
  readonly onFilterSelection: () => void
  readonly onPrevious: () => void
  readonly onNext: () => void
})
{
  const [filter, setFilter] = useState('')
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const visibleFiles =
    normalizedFilter.length === 0
      ? props.result.files
      : props.result.files.filter((file) =>
          `${file.label}\n${file.id}`.toLocaleLowerCase().includes(normalizedFilter),
        )

  return (
    <details
      className={cn(
        'overflow-y-auto border-t border-[var(--architecture-border-soft)] bg-[var(--architecture-page)]',
        props.primary ? 'min-h-0 flex-1' : 'max-h-[45%] shrink-0',
      )}
      data-scope-files
      open={props.open}
      onToggle={(event) => props.onToggle(event.currentTarget.open)}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 bg-[var(--architecture-sunken)] px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--architecture-accent)]">
        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--architecture-text)]">
          <FileCodeIcon className="size-4 text-[var(--architecture-text-faint)]" />
          Files in scope
        </span>
        <ArchitectureProjectionSummary count={props.result.fileCount} label="files" />
      </summary>
      <div className="border-t border-[var(--architecture-border-soft)]">
        <label className="flex min-h-10 items-center gap-2 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-surface)] px-3">
          <SearchIcon className="size-3.5 shrink-0 text-[var(--architecture-text-faint)]" />
          <span className="sr-only">Filter files on this page</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--architecture-text)] outline-none placeholder:text-[var(--architecture-text-faint)]"
            placeholder={`Filter ${props.result.files.length} files on this page`}
            type="search"
            value={filter}
            onChange={(event) =>
            {
              const nextFilter = event.currentTarget.value
              setFilter(nextFilter)
              if (
                props.selectedFileId !== null &&
                nextFilter.trim().length > 0 &&
                !props.result.files.some(
                  (file) =>
                    file.id === props.selectedFileId &&
                    `${file.label}\n${file.id}`
                      .toLocaleLowerCase()
                      .includes(nextFilter.trim().toLocaleLowerCase()),
                )
              )
              {
                props.onFilterSelection()
              }
            }}
          />
          {normalizedFilter.length > 0 ? (
            <span className="font-mono text-[9px] tabular-nums text-[var(--architecture-text-faint)]">
              {visibleFiles.length} shown
            </span>
          ) : null}
        </label>
        {visibleFiles.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {props.result.files.length === 0
              ? 'No files on this page.'
              : 'No files on this page match that filter.'}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--architecture-border-soft)]">
            {visibleFiles.map((file) => (
              <li key={file.id}>
                <button
                  aria-pressed={props.selectedFileId === file.id}
                  className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left outline-none hover:bg-[var(--architecture-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--architecture-accent)] aria-pressed:bg-[color-mix(in_srgb,var(--architecture-accent)_12%,var(--architecture-surface))]"
                  type="button"
                  onClick={(event) => props.onSelect(file, event.currentTarget)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-[var(--architecture-text)]">
                      {file.label}
                    </span>
                    <code className="mt-0.5 block truncate text-[10px] text-[var(--architecture-text-faint)]">
                      {file.id}
                    </code>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--architecture-text-muted)]">
                    {file.fanIn} in · {file.fanOut} out
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex min-h-10 items-center justify-between gap-3 border-t border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-3 py-1.5">
          {props.result.fileCount.omitted > 0 ? (
            <span className="text-xs text-muted-foreground">
              {props.result.fileCount.omitted} files were not indexed.
            </span>
          ) : (
            <span />
          )}
          <PageControls
            hasNext={props.hasNext}
            hasPrevious={props.hasPrevious}
            label="file"
            page={props.page}
            onNext={props.onNext}
            onPrevious={props.onPrevious}
          />
        </div>
      </div>
    </details>
  )
}

type ScopeSelection =
  | { readonly kind: 'unit'; readonly id: string }
  | { readonly kind: 'edge'; readonly from: string; readonly to: string }
  | { readonly kind: 'file'; readonly id: ArchitectureRelativePath }

export interface ArchitectureScopeViewProps
{
  readonly target: {
    readonly source: ArchitectureStandingSource
    readonly scope: ArchitectureScopeSelector
  }
  readonly result: CartographerGetArchitectureScopeResult | null
  readonly isPending: boolean
  readonly error: string | null
  readonly childPage: number
  readonly filePage: number
  readonly hasPreviousChildren: boolean
  readonly hasPreviousFiles: boolean
  readonly narrow?: boolean | undefined
  readonly embedded?: boolean | undefined
  readonly filesOnly?: boolean | undefined
  readonly onRetry: () => void
  readonly onNextChildren: () => void
  readonly onPreviousChildren: () => void
  readonly onNextFiles: () => void
  readonly onPreviousFiles: () => void
  readonly onOpenScope: (target: ArchitectureScopeTarget) => void
  readonly onInspectScope?: ((target: ArchitectureScopeTarget) => void) | undefined
  readonly onOpenFile: (target: ArchitectureFileOpenTarget) => void
}

export function ArchitectureScopeView(props: ArchitectureScopeViewProps)
{
  const [surfaceRef, measuredNarrow] = useArchitectureSurfaceNarrow(props.narrow)
  const [selection, setSelection] = useState<ScopeSelection | null>(null)
  const [returnFocus, setReturnFocus] = useState<HTMLButtonElement | null>(null)
  const [filesExpanded, setFilesExpanded] = useState<boolean | null>(null)
  const selectedUnit =
    props.result && selection?.kind === 'unit'
      ? (props.result.children.find((unit) => unit.id === selection.id) ?? null)
      : null
  const selectedFile =
    props.result && selection?.kind === 'file'
      ? (props.result.files.find((file) => file.id === selection.id) ?? null)
      : null
  const selectedEdge =
    props.result && selection?.kind === 'edge'
      ? (props.result.edges.find(
          (edge) => edge.from === selection.from && edge.to === selection.to,
        ) ?? null)
      : null
  const selectedEdgeFrom =
    props.result && selectedEdge
      ? props.result.children.find((unit) => unit.id === selectedEdge.from)
      : undefined
  const selectedEdgeTo =
    props.result && selectedEdge
      ? props.result.children.find((unit) => unit.id === selectedEdge.to)
      : undefined

  const closeDetails = useCallback((): void =>
  {
    setSelection(null)
  }, [])

  const openUnit = useCallback(
    (unit: ArchitectureProjectionUnit): void =>
    {
      if (unit.level !== 'blocks' && unit.level !== 'dirs') return
      props.onOpenScope({
        source: props.target.source,
        scope: { level: unit.level, id: unit.id },
      })
    },
    [props],
  )

  const openFile = useCallback(
    (file: ArchitectureProjectionFile): void =>
      props.onOpenFile({ source: props.target.source, relativePath: file.id }),
    [props],
  )

  const openNeighborhood = useCallback(
    (file: ArchitectureProjectionFile): void =>
      props.onOpenScope({
        source: props.target.source,
        scope: { level: 'file-neighborhood', path: file.id },
      }),
    [props],
  )

  const drawerTitle = selectedUnit
    ? selectedUnit.label
    : selectedFile
      ? selectedFile.label
      : selectedEdge
        ? `${selectedEdgeFrom?.label ?? selectedEdge.from} → ${selectedEdgeTo?.label ?? selectedEdge.to}`
        : 'Architecture details'
  const drawerDescription = selectedUnit
    ? `${selectedUnit.level === 'blocks' ? 'Block' : 'Folder'} · ${selectedUnit.fileCount} files`
    : selectedFile
      ? selectedFile.id
      : selectedEdge
        ? `${selectedEdge.weight} ${selectedEdge.weight === 1 ? 'import' : 'imports'}`
        : undefined

  return (
    <div
      ref={surfaceRef}
      className="architecture-surface relative flex h-full min-h-0 flex-1 flex-col"
      data-architecture-scope
      tabIndex={-1}
    >
      <ScopeHeader
        compact={props.embedded}
        eyebrow={`${
          props.target.scope.level === 'systems'
            ? 'System'
            : props.target.scope.level === 'blocks'
              ? 'Block'
              : 'Folder'
        } scope`}
        refreshing={props.isPending}
        source={props.target.source}
        title={props.target.scope.id}
        onRefresh={props.onRetry}
      />
      {props.error && props.result ? (
        <RefreshErrorBanner message={props.error} onRetry={props.onRetry} />
      ) : null}
      {props.result === null ? (
        <ArchitectureQueryState
          kind={props.error ? 'error' : 'loading'}
          message={
            props.error ?? 'Loading the bounded children and files for this exact generation.'
          }
          onRetry={props.error ? props.onRetry : undefined}
          title={props.error ? 'Architecture scope unavailable' : 'Loading architecture scope'}
        />
      ) : (
        <>
          {!props.filesOnly && props.result.childCount.indexed > 0 ? (
            <>
              <ArchitectureBoundedView
                edgeCount={props.result.edgeCount}
                edges={props.result.edges}
                graphLabel={`${props.target.scope.id} ${props.result.childLevel} dependency graph`}
                onSelect={(unit, trigger) =>
                  {
                  setSelection({ kind: 'unit', id: unit.id })
                  setReturnFocus(trigger)
                  if (unit.level === 'blocks' || unit.level === 'dirs')
                    {
                    props.onInspectScope?.({
                      source: props.target.source,
                      scope: { level: unit.level, id: unit.id },
                    })
                  }
                }}
                onSelectEdge={(edge, trigger) =>
                  {
                  setSelection({ kind: 'edge', from: edge.from, to: edge.to })
                  setReturnFocus(trigger)
                }}
                selectedEdge={selectedEdge}
                selectedUnitId={selectedUnit?.id ?? null}
                unitCount={props.result.childCount}
                units={props.result.children}
              />
              <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-t px-3 py-1.5">
                <span className="text-xs text-muted-foreground">
                  {props.result.childCount.omitted > 0
                    ? `${props.result.childCount.omitted} ${props.result.childLevel} were not indexed.`
                    : `${props.result.childCount.indexed} indexed ${props.result.childLevel}.`}
                </span>
                <PageControls
                  hasNext={
                    !props.isPending &&
                    props.error === null &&
                    props.result.nextCursor !== undefined
                  }
                  hasPrevious={props.hasPreviousChildren}
                  label={props.result.childLevel}
                  page={props.childPage}
                  onNext={() =>
                    {
                    closeDetails()
                    props.onNextChildren()
                  }}
                  onPrevious={() =>
                    {
                    closeDetails()
                    props.onPreviousChildren()
                  }}
                />
              </div>
            </>
          ) : null}
          <ScopeFiles
            hasNext={
              !props.isPending && props.error === null && props.result.nextFileCursor !== undefined
            }
            hasPrevious={props.hasPreviousFiles}
            onNext={() =>
              {
              closeDetails()
              props.onNextFiles()
            }}
            onPrevious={() =>
              {
              closeDetails()
              props.onPreviousFiles()
            }}
            onSelect={(file, trigger) =>
              {
              setSelection({ kind: 'file', id: file.id })
              setReturnFocus(trigger)
            }}
            onFilterSelection={closeDetails}
            onToggle={setFilesExpanded}
            open={
              filesExpanded ?? (props.filesOnly === true || props.result.childCount.indexed === 0)
            }
            page={props.filePage}
            primary={props.filesOnly === true || props.result.childCount.indexed === 0}
            result={props.result}
            selectedFileId={selectedFile?.id ?? null}
          />
        </>
      )}
      <ArchitectureDetailsDrawer
        description={drawerDescription}
        narrow={measuredNarrow}
        open={selectedUnit !== null || selectedFile !== null || selectedEdge !== null}
        returnFocus={returnFocus}
        title={drawerTitle}
        onClose={closeDetails}
      >
        {selectedUnit ? (
          <UnitDetails
            onOpen={
              selectedUnit.level === 'blocks' || selectedUnit.level === 'dirs'
                ? () => openUnit(selectedUnit)
                : undefined
            }
            unit={selectedUnit}
          />
        ) : null}
        {selectedFile ? (
          <FileDetails
            file={selectedFile}
            onOpen={() => openFile(selectedFile)}
            onOpenNeighborhood={() => openNeighborhood(selectedFile)}
          />
        ) : null}
        {selectedEdge && props.result ? (
          <EdgeDetails edge={selectedEdge} units={props.result.children} />
        ) : null}
      </ArchitectureDetailsDrawer>
    </div>
  )
}

function StandingArchitectureScopeQuery(props: StandingArchitectureScopeQueryProps)
{
  const childPager = useCursorPager()
  const filePager = useCursorPager()
  const query = useEnvironmentQuery(
    projectEnvironment.getArchitectureScope({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        source: props.target.source,
        scope: props.target.scope,
        limit: ARCHITECTURE_SCOPE_PAGE_SIZE,
        fileLimit: ARCHITECTURE_SCOPE_PAGE_SIZE,
        ...(childPager.cursor === null ? {} : { cursor: childPager.cursor }),
        ...(filePager.cursor === null ? {} : { fileCursor: filePager.cursor }),
      },
    }),
  )
  const responseMatches =
    query.data !== null &&
    sameProjectionSource(query.data.source, props.target.source) &&
    sameScope(query.data.scope, props.target.scope)
  const result = responseMatches ? query.data : null
  const sourceError =
    query.data !== null && !responseMatches
      ? 'The server returned evidence for a different architecture source or scope.'
      : null
  const [lastGoodEvidence, setLastGoodEvidence] = useState<ScopePageEvidence | null>(() =>
    result === null
      ? null
      : {
          result,
          childCursor: childPager.cursor,
          childPage: childPager.page,
          fileCursor: filePager.cursor,
          filePage: filePager.page,
        },
  )

  useEffect(() =>
  {
    if (result === null) return
    setLastGoodEvidence((current) =>
    {
      if (
        current?.result === result &&
        current.childCursor === childPager.cursor &&
        current.childPage === childPager.page &&
        current.fileCursor === filePager.cursor &&
        current.filePage === filePager.page
      )
      {
        return current
      }
      return {
        result,
        childCursor: childPager.cursor,
        childPage: childPager.page,
        fileCursor: filePager.cursor,
        filePage: filePager.page,
      }
    })
  }, [childPager.cursor, childPager.page, filePager.cursor, filePager.page, result])

  const visibleEvidence: ScopePageEvidence | null =
    result === null
      ? lastGoodEvidence
      : {
          result,
          childCursor: childPager.cursor,
          childPage: childPager.page,
          fileCursor: filePager.cursor,
          filePage: filePager.page,
        }

  return (
    <ArchitectureScopeView
      childPage={visibleEvidence?.childPage ?? childPager.page}
      embedded={props.embedded}
      error={sourceError ?? query.error}
      filePage={visibleEvidence?.filePage ?? filePager.page}
      filesOnly={props.filesOnly}
      hasPreviousChildren={childPager.hasPrevious}
      hasPreviousFiles={filePager.hasPrevious}
      isPending={query.isPending}
      narrow={props.narrow}
      onNextChildren={() =>
      {
        if (result?.nextCursor) childPager.advance(result.nextCursor)
      }}
      onNextFiles={() =>
      {
        if (result?.nextFileCursor) filePager.advance(result.nextFileCursor)
      }}
      onOpenFile={props.onOpenFile}
      onInspectScope={props.onInspectScope}
      onOpenScope={props.onOpenScope}
      onPreviousChildren={childPager.previous}
      onPreviousFiles={filePager.previous}
      onRetry={query.refresh}
      result={visibleEvidence?.result ?? null}
      target={props.target}
    />
  )
}

function NeighborhoodList(props: {
  readonly label: 'Incoming' | 'Outgoing'
  readonly paths: readonly ArchitectureRelativePath[]
  readonly total: number
  readonly omitted: number
  readonly selectedPath: ArchitectureRelativePath | null
  readonly onSelect: (path: ArchitectureRelativePath, trigger: HTMLButtonElement) => void
})
{
  return (
    <section aria-label={`${props.label} dependencies`} className="border-b last:border-b-0">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {props.label}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {props.paths.length} returned of {props.total}
          {props.omitted > 0 ? ` · ${props.omitted} omitted` : ''}
        </span>
      </div>
      {props.paths.length === 0 ? (
        <p className="px-3 pb-4 text-sm text-muted-foreground">
          No {props.label.toLowerCase()} dependencies were returned.
        </p>
      ) : (
        <ul className="divide-y divide-border/70">
          {props.paths.map((path) => (
            <li key={path}>
              <button
                aria-pressed={props.selectedPath === path}
                className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-accent"
                type="button"
                onClick={(event) => props.onSelect(path, event.currentTarget)}
              >
                <FileCodeIcon className="size-4 shrink-0 text-muted-foreground" />
                <code className="min-w-0 truncate text-xs">{path}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export interface ArchitectureNeighborhoodViewProps
{
  readonly source: ArchitectureProjectionSource
  readonly path: ArchitectureRelativePath
  readonly direction: NeighborhoodDirection
  readonly result: CartographerGetArchitectureNeighborhoodResult | null
  readonly isPending: boolean
  readonly error: string | null
  readonly narrow?: boolean | undefined
  readonly embedded?: boolean | undefined
  readonly onDirectionChange: (direction: NeighborhoodDirection) => void
  readonly onRetry: () => void
  readonly onOpenFile: (target: ArchitectureFileOpenTarget) => void
}

export function ArchitectureNeighborhoodView(props: ArchitectureNeighborhoodViewProps)
{
  const [surfaceRef, measuredNarrow] = useArchitectureSurfaceNarrow(props.narrow)
  const [selectedPath, setSelectedPath] = useState<ArchitectureRelativePath | null>(null)
  const [returnFocus, setReturnFocus] = useState<HTMLButtonElement | null>(null)
  const visibleSelectedPath =
    props.result &&
    selectedPath !== null &&
    (props.result.upstream.items.includes(selectedPath) ||
      props.result.downstream.items.includes(selectedPath))
      ? selectedPath
      : null

  const closeDetails = useCallback((): void =>
  {
    setSelectedPath(null)
  }, [])

  const openFile = useCallback(
    (path: ArchitectureRelativePath): void =>
      props.onOpenFile({ source: props.source, relativePath: path }),
    [props],
  )

  return (
    <div
      ref={surfaceRef}
      className="architecture-surface relative flex h-full min-h-0 flex-1 flex-col"
      data-architecture-neighborhood
    >
      <ScopeHeader
        compact={props.embedded}
        eyebrow="Dependency neighborhood"
        refreshing={props.isPending}
        source={props.source}
        title={props.path}
        onRefresh={props.onRetry}
      />
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">One-hop dependencies</p>
          <p className="text-xs text-muted-foreground">
            {props.result ? `${props.result.impactedFileCount} impacted files` : 'Bounded query'}
          </p>
        </div>
        <ToggleGroup
          aria-label="Dependency direction"
          className="shrink-0"
          size="xs"
          value={[props.direction]}
          variant="outline"
          onValueChange={(value) =>
          {
            const next = value[0]
            if (next === 'upstream' || next === 'downstream' || next === 'both')
            {
              closeDetails()
              props.onDirectionChange(next)
            }
          }}
        >
          <Toggle value="upstream">Incoming</Toggle>
          <Toggle value="downstream">Outgoing</Toggle>
          <Toggle value="both">Both</Toggle>
        </ToggleGroup>
      </div>
      {props.error && props.result ? (
        <RefreshErrorBanner message={props.error} onRetry={props.onRetry} />
      ) : null}
      {props.result === null ? (
        <ArchitectureQueryState
          kind={props.error ? 'error' : 'loading'}
          message={props.error ?? 'Loading this exact bounded dependency neighborhood.'}
          onRetry={props.error ? props.onRetry : undefined}
          title={props.error ? 'Dependencies unavailable' : 'Loading dependencies'}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {props.direction !== 'downstream' ? (
            <NeighborhoodList
              label="Incoming"
              omitted={props.result.upstream.omitted}
              onSelect={(path, trigger) =>
                {
                setSelectedPath(path)
                setReturnFocus(trigger)
              }}
              paths={props.result.upstream.items}
              selectedPath={visibleSelectedPath}
              total={props.result.upstream.total}
            />
          ) : null}
          {props.direction !== 'upstream' ? (
            <NeighborhoodList
              label="Outgoing"
              omitted={props.result.downstream.omitted}
              onSelect={(path, trigger) =>
                {
                setSelectedPath(path)
                setReturnFocus(trigger)
              }}
              paths={props.result.downstream.items}
              selectedPath={visibleSelectedPath}
              total={props.result.downstream.total}
            />
          ) : null}
        </div>
      )}
      <ArchitectureDetailsDrawer
        description={visibleSelectedPath ?? undefined}
        narrow={measuredNarrow}
        open={visibleSelectedPath !== null}
        returnFocus={returnFocus}
        title={visibleSelectedPath?.split('/').at(-1) ?? 'Dependency file'}
        onClose={closeDetails}
      >
        {visibleSelectedPath ? (
          <>
            <code className="block break-all text-xs text-muted-foreground">
              {visibleSelectedPath}
            </code>
            <Button className="w-full" size="sm" onClick={() => openFile(visibleSelectedPath)}>
              Open file
              <ArrowUpRightIcon />
            </Button>
          </>
        ) : null}
      </ArchitectureDetailsDrawer>
    </div>
  )
}

function ArchitectureNeighborhoodQuery(props: ArchitectureNeighborhoodQueryProps)
{
  const [direction, setDirection] = useState<NeighborhoodDirection>('both')
  const path = props.target.scope.path as ArchitectureRelativePath
  const query = useEnvironmentQuery(
    projectEnvironment.getArchitectureNeighborhood({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        source: props.target.source,
        target: path,
        direction,
        maxDepth: ARCHITECTURE_NEIGHBORHOOD_DEPTH,
      },
    }),
  )
  const responseMatches =
    query.data !== null &&
    sameProjectionSource(query.data.source, props.target.source) &&
    query.data.target === path &&
    query.data.direction === direction &&
    query.data.maxDepth === ARCHITECTURE_NEIGHBORHOOD_DEPTH
  const result = responseMatches ? query.data : null
  const sourceError =
    query.data !== null && !responseMatches
      ? 'The server returned a different dependency source, direction, or depth.'
      : null

  return (
    <ArchitectureNeighborhoodView
      direction={direction}
      embedded={props.embedded}
      error={sourceError ?? query.error}
      isPending={query.isPending}
      narrow={props.narrow}
      onDirectionChange={setDirection}
      onOpenFile={props.onOpenFile}
      onRetry={query.refresh}
      path={path}
      result={result}
      source={props.target.source}
    />
  )
}

export function ArchitectureScopeSurface(props: ArchitectureScopeSurfaceProps)
{
  const key = architectureScopeSurfaceId(props.target)
  if (props.target.scope.level === 'file-neighborhood')
  {
    const target: FileNeighborhoodTarget = {
      source: props.target.source,
      scope: { level: 'file-neighborhood', path: props.target.scope.path },
    }
    return <ArchitectureNeighborhoodQuery key={key} {...props} target={target} />
  }
  if (props.target.source.kind !== 'standing-project-generation')
  {
    return (
      <ArchitectureQueryState
        kind="error"
        message="System, block, and folder scopes require an exact standing repository generation."
        title="Architecture scope identity is invalid"
      />
    )
  }
  const target: StandingArchitectureScopeTarget = {
    source: props.target.source,
    scope: { level: props.target.scope.level, id: props.target.scope.id },
  }
  return <StandingArchitectureScopeQuery key={key} {...props} target={target} />
}
