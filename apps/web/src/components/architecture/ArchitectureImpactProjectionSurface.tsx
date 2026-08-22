// apps/web/src/components/architecture/ArchitectureImpactProjectionSurface.tsx
// presents one immutable authority-selected impact projection on the shared canvas

import type {
  ArchitectureDiffSource,
  ArchitectureGraphProjection,
  ArchitectureGraphProjectionEvidence,
  ArchitectureImpactProjectionResult,
  ArchitectureProposalSource,
  ArchitectureStandingAnchor,
} from '@t3tools/contracts'
import { GitCompareArrows, NetworkIcon, RotateCcwIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { ArchitectureConcernGraphSelection } from '~/composerDraftStore'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'

import { ArchitectureDetailsDrawer } from './ArchitectureDetailsDrawer'
import {
  ArchitectureGraphCanvas,
  type ArchitectureGraphCanvasEdge,
  type ArchitectureGraphCanvasNode,
} from './ArchitectureGraphCanvas'
import { ArchitectureGraphSelectionDetails } from './ArchitectureGraphSelectionDetails'
import type { ArchitectureFileSource } from './architectureResourceIdentity'
import { createImpactProjectionScene } from './impactProjectionScene'
import { useArchitectureSurfaceNarrow } from './useArchitectureSurfaceNarrow'

type ImpactProjectionSelection = ArchitectureConcernGraphSelection

export interface ArchitectureImpactProjectionSurfaceProps
{
  readonly result: ArchitectureImpactProjectionResult | null
  readonly error: string | null
  readonly isPending: boolean
  readonly hasSettled: boolean
  readonly requestedAuthority: 'planned' | 'verified'
  readonly onSelectAuthority: (authority: 'planned' | 'verified') => void
  readonly onRetry: () => void
  readonly newerProjectionError: string | null
  readonly newerProjectionPending: boolean
  readonly onOpenNewerProjection: () => void
  readonly onRetryNewerProjection: () => void
  readonly onOpenVerifiedFile: (
    source: ArchitectureFileSource,
    relativePath: string,
    line?: number,
  ) => void
  readonly onOpenPlannedPath: (relativePath: string, line?: number) => void
  readonly onViewInRepositoryMap: (anchor: ArchitectureStandingAnchor) => void
  readonly onAddConcern: (
    projection: ArchitectureGraphProjection,
    selection: ArchitectureConcernGraphSelection,
  ) => void
}

function immutableSource(
  projection: ArchitectureGraphProjection,
  side: 'base' | 'head',
): ArchitectureFileSource | null
{
  const source = projection.source
  const base = side === 'base'
  if (source.kind === 'verified-proposal-impact')
  {
    return {
      kind: 'proposal-generation',
      threadId: source.threadId,
      generationId: source.generationId,
      side: base ? 'base' : 'proposed',
      graphDigest: base ? source.baseGraphDigest : source.headGraphDigest,
    } satisfies ArchitectureProposalSource
  }
  if (source.kind === 'verified-diff-impact')
  {
    return {
      kind: 'diff-analysis',
      threadId: source.threadId,
      diffAnalysisId: source.diffAnalysisId,
      side: base ? 'base' : 'head',
      graphDigest: base ? source.baseGraphDigest : source.headGraphDigest,
    } satisfies ArchitectureDiffSource
  }
  return null
}

function exactSourceLabel(source: ArchitectureFileSource): string
{
  if (source.kind === 'proposal-generation')
  {
    return source.side === 'base' ? 'Open exact before: ' : 'Open exact proposed: '
  }
  return source.side === 'base' ? 'Open exact before: ' : 'Open exact after: '
}

function ProjectionCount(props: {
  readonly label: string
  readonly count: ArchitectureGraphProjection['totals']['nodes']
  readonly compact: boolean
})
{
  return (
    <div
      className={
        props.compact
          ? 'min-w-0 border-b border-e border-[var(--architecture-border-soft)] px-3 py-2.5'
          : 'min-w-24 border-e border-[var(--architecture-border-soft)] px-4 py-2.5 last:border-e-0'
      }
    >
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--architecture-text-faint)]">
        {props.label}
      </dt>
      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[var(--architecture-text)]">
        {props.count.total.toLocaleString()}
      </dd>
      <dd className="text-[10px] text-[var(--architecture-text-muted)]">
        {props.count.returned.toLocaleString()} shown
        {props.count.omitted > 0 ? ` · ${props.count.omitted.toLocaleString()} omitted` : ''}
      </dd>
    </div>
  )
}

function ProjectionEvidence(props: {
  readonly projection: ArchitectureGraphProjection
  readonly selection: ImpactProjectionSelection
  readonly onOpenVerifiedFile: ArchitectureImpactProjectionSurfaceProps['onOpenVerifiedFile']
  readonly onOpenPlannedPath: ArchitectureImpactProjectionSurfaceProps['onOpenPlannedPath']
})
{
  const refs =
    props.selection.kind === 'node'
      ? props.selection.node.evidenceRefs
      : props.selection.edge.evidenceRefs
  const evidenceById = new Map(props.projection.evidence.map((entry) => [entry.id, entry] as const))
  const evidence = refs.flatMap((ref) =>
  {
    const entry = evidenceById.get(ref)
    return entry === undefined ? [] : [entry]
  })
  const sourcesForPath = (
    entry: ArchitectureGraphProjectionEvidence,
    path: string,
  ): readonly ArchitectureFileSource[] | null =>
  {
    if (props.projection.authority === 'planned') return null
    const exactSides = [
      ...new Set(
        entry.pathRefs
          ?.filter((reference) => reference.path === path)
          .map((reference) => reference.side) ?? [],
      ),
    ]
    const sides =
      exactSides.length > 0
        ? exactSides
        : [entry.state === 'removed' ? ('base' as const) : ('head' as const)]
    return sides.flatMap((side) =>
    {
      const source = immutableSource(props.projection, side)
      return source === null ? [] : [source]
    })
  }

  if (evidence.length === 0)
  {
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        This bounded selection has no returned evidence references. Projection omissions still apply
        to the exact totals above.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Evidence
      </p>
      {evidence.map((entry: ArchitectureGraphProjectionEvidence) => (
        <div className="rounded-lg border border-border bg-muted/20 p-2.5" key={entry.id}>
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] leading-relaxed text-foreground">{entry.label}</p>
            <Badge variant="outline">{entry.state}</Badge>
          </div>
          {entry.paths.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {entry.paths.map((path) =>
                {
                const sources = sourcesForPath(entry, path)
                if (sources === null)
                  {
                  return (
                    <Button
                      className="h-auto max-w-full justify-start px-2 py-1 font-mono text-[10px]"
                      key={path}
                      size="sm"
                      title={path}
                      variant="outline"
                      onClick={() => props.onOpenPlannedPath(path)}
                    >
                      <span className="truncate">Open planned path: {path}</span>
                    </Button>
                  )
                }
                return (
                  <div className="flex flex-wrap gap-1.5" key={path}>
                    {sources.map((source) => (
                      <Button
                        className="h-auto max-w-full justify-start px-2 py-1 font-mono text-[10px]"
                        key={`${source.kind}:${source.side}:${path}`}
                        size="sm"
                        title={path}
                        variant="outline"
                        onClick={() => props.onOpenVerifiedFile(source, path)}
                      >
                        <span className="truncate">
                          {exactSourceLabel(source)}
                          {path}
                        </span>
                      </Button>
                    ))}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function SelectionDetails(props: {
  readonly projection: ArchitectureGraphProjection
  readonly selection: ImpactProjectionSelection
  readonly onOpenVerifiedFile: ArchitectureImpactProjectionSurfaceProps['onOpenVerifiedFile']
  readonly onOpenPlannedPath: ArchitectureImpactProjectionSurfaceProps['onOpenPlannedPath']
  readonly onViewInRepositoryMap: ArchitectureImpactProjectionSurfaceProps['onViewInRepositoryMap']
  readonly onAddConcern: ArchitectureImpactProjectionSurfaceProps['onAddConcern']
})
{
  const selection = props.selection
  const selectionId = selection.kind === 'node' ? selection.node.id : selection.edge.id
  const anchor = props.projection.anchors.find((candidate) => candidate.selectionId === selectionId)
  return (
    <ArchitectureGraphSelectionDetails
      anchor={anchor}
      evidence={<ProjectionEvidence {...props} />}
      selection={selection}
      actions={
        <div className="flex flex-col gap-2">
          {anchor ? (
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              onClick={() => props.onViewInRepositoryMap(anchor)}
            >
              View in Repository Map
            </Button>
          ) : null}
          <Button
            className="w-full"
            size="sm"
            variant="outline"
            onClick={() => props.onAddConcern(props.projection, selection)}
          >
            Add concern to composer
          </Button>
        </div>
      }
    />
  )
}

function authorityLabel(authority: 'planned' | 'verified'): string
{
  return authority === 'planned' ? 'Planned' : 'Verified'
}

function ArchitectureImpactProjectionContent(props: ArchitectureImpactProjectionSurfaceProps)
{
  const [surfaceRef, narrow] = useArchitectureSurfaceNarrow<HTMLElement>()
  const [selection, setSelection] = useState<ImpactProjectionSelection | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null)
  const projection = props.result?.projection ?? null
  const scene = useMemo(
    () => (projection === null ? null : createImpactProjectionScene(projection)),
    [projection],
  )

  if (projection === null || props.result === null || scene === null)
  {
    const message =
      props.error ??
      (props.isPending || !props.hasSettled
        ? 'Resolving the exact Impact Diff resource.'
        : 'No exact Impact Diff resource is available.')
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <NetworkIcon className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            {props.error ? 'Impact Diff unavailable' : 'Loading Impact Diff'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{message}</p>
          {props.error ? (
            <Button className="mt-4" size="sm" variant="outline" onClick={props.onRetry}>
              <RotateCcwIcon />
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  const descriptor = props.result.descriptor
  const newerVersionAvailable =
    projection.newerProjectionId !== undefined || props.result.newerDescriptorId !== undefined
  const selectedNode = selection?.kind === 'node' ? selection.node : null
  const selectedEdge = selection?.kind === 'edge' ? selection.edge : null
  const selectNode = (node: ArchitectureGraphCanvasNode, trigger: HTMLButtonElement): void =>
  {
    const source = scene.nodesById.get(node.id)
    if (source === undefined) return
    setSelection({ kind: 'node', node: source })
    setDrawerOpen(true)
    setReturnFocus(trigger)
  }
  const selectEdge = (edge: ArchitectureGraphCanvasEdge, trigger: HTMLButtonElement): void =>
  {
    const source = scene.edgesById.get(edge.id)
    if (source === undefined) return
    setSelection({ kind: 'edge', edge: source })
    setDrawerOpen(true)
    setReturnFocus(trigger)
  }

  return (
    <section
      ref={surfaceRef}
      aria-label="Impact Diff"
      className="architecture-surface relative flex min-h-0 flex-1 flex-col"
      data-impact-authority={projection.authority}
    >
      <header className="surface-subheader h-auto min-h-14 flex-wrap gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <GitCompareArrows className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground">Impact Diff</h2>
              <Badge variant={projection.resultState === 'graph' ? 'info' : 'secondary'}>
                {projection.resultState === 'graph' ? 'Changed' : 'No impact'}
              </Badge>
              {projection.freshness !== 'fresh' ? (
                <Badge variant="outline">
                  {projection.freshness === 'dirty'
                    ? 'Source changed'
                    : projection.freshness === 'stale'
                      ? 'Stale'
                      : 'Reverted'}
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-[10px] text-muted-foreground">
              {authorityLabel(props.result.selectedAuthority)} Impact · {projection.lens} ·{' '}
              {projection.semanticLevel}
            </p>
          </div>
        </div>
        {descriptor.plannedCandidate !== undefined && descriptor.verifiedCandidate !== undefined ? (
          <div
            aria-label="Impact authority"
            className="flex rounded-lg border border-border bg-muted/20 p-0.5"
            role="group"
          >
            {(['verified', 'planned'] as const).map((authority) => (
              <Button
                aria-pressed={props.requestedAuthority === authority}
                key={authority}
                size="sm"
                variant={props.requestedAuthority === authority ? 'secondary' : 'ghost'}
                onClick={() => props.onSelectAuthority(authority)}
              >
                {authorityLabel(authority)}
              </Button>
            ))}
          </div>
        ) : null}
      </header>
      {projection.freshness !== 'fresh' ? (
        <div
          className="border-b border-[color-mix(in_srgb,var(--architecture-amber)_30%,var(--architecture-border-soft))] bg-[color-mix(in_srgb,var(--architecture-amber)_8%,var(--architecture-surface))] px-4 py-2 text-[11px] text-[var(--architecture-amber)]"
          role="status"
        >
          {projection.freshness === 'reverted'
            ? 'This exact historical Impact resource belongs to a reverted plan and remains read-only.'
            : projection.freshness === 'dirty'
              ? 'Repository source changed after this projection. This exact result remains pinned.'
              : projection.authority === 'verified'
                ? 'Verified evidence is stale. This exact result remains selected.'
                : 'This Planned interpretation belongs to an older proposal state.'}
        </div>
      ) : null}
      {newerVersionAvailable ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--architecture-accent)_25%,var(--architecture-border-soft))] bg-[color-mix(in_srgb,var(--architecture-accent)_6%,var(--architecture-surface))] px-4 py-2 text-[11px]"
          role="status"
        >
          <span className="text-[var(--architecture-text-muted)]">
            {projection.source.kind === 'planned-impact' &&
            projection.source.projection.materialization === 'provisional'
              ? 'Anchored version available. This provisional resource remains pinned.'
              : 'A newer immutable Impact projection is available.'}
          </span>
          <div className="flex items-center gap-2">
            {props.newerProjectionError ? (
              <Button size="xs" variant="ghost" onClick={props.onRetryNewerProjection}>
                Retry lookup
              </Button>
            ) : null}
            <Button
              disabled={props.newerProjectionPending || props.newerProjectionError !== null}
              size="xs"
              variant="outline"
              onClick={props.onOpenNewerProjection}
            >
              {props.newerProjectionPending ? 'Resolving…' : 'Open newer version'}
            </Button>
          </div>
        </div>
      ) : null}
      <dl
        className={
          narrow
            ? 'grid shrink-0 grid-cols-2 overflow-hidden border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)]'
            : 'flex shrink-0 overflow-x-auto border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)]'
        }
      >
        <ProjectionCount compact={narrow} count={projection.totals.nodes} label="Objects" />
        <ProjectionCount compact={narrow} count={projection.totals.edges} label="Relationships" />
        <ProjectionCount compact={narrow} count={projection.totals.evidence} label="Evidence" />
        <ProjectionCount
          compact={narrow}
          count={projection.totals.changedFiles}
          label="Changed files"
        />
      </dl>
      {projection.breadcrumbs.length > 0 ? (
        <nav
          aria-label="Impact hierarchy"
          className="flex shrink-0 items-center gap-1 border-b border-[var(--architecture-border-soft)] px-4 py-2 text-[11px] text-[var(--architecture-text-muted)]"
        >
          <span className="font-medium capitalize text-[var(--architecture-text)]">
            {projection.lens}
          </span>
          {projection.breadcrumbs.map((breadcrumb) => (
            <span key={breadcrumb.id}>/ {breadcrumb.label}</span>
          ))}
        </nav>
      ) : null}
      {projection.resultState === 'no-impact' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-md">
            <p className="text-sm font-semibold text-[var(--architecture-text)]">No impact</p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--architecture-text-muted)]">
              {projection.authority === 'verified'
                ? 'Exact analysis found implementation changes without a semantic relationship or public API effect.'
                : 'The provider explicitly published a Planned no-impact interpretation. This is proposal intent, not verified evidence.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ArchitectureGraphCanvas
            ariaLabel={`${authorityLabel(props.result.selectedAuthority)} Impact Diff graph`}
            edges={scene.edges}
            emptyLabel="No returned architecture objects are available in this bounded projection."
            nodes={scene.nodes}
            selectedEdgeId={selectedEdge?.id ?? null}
            selectedNodeId={selectedNode?.id ?? null}
            onSelectEdge={selectEdge}
            onSelectNode={selectNode}
          />
        </div>
      )}
      <ArchitectureDetailsDrawer
        description={
          selectedNode
            ? `${selectedNode.stateLabel} ${selectedNode.semanticLevel}`
            : selectedEdge
              ? `${selectedEdge.stateLabel} ${selectedEdge.relationshipKind}`
              : undefined
        }
        narrow={narrow}
        open={drawerOpen && selection !== null && projection.resultState === 'graph'}
        returnFocus={returnFocus}
        title={selectedNode?.label ?? selectedEdge?.relationshipKind ?? 'Impact details'}
        onClose={() => setDrawerOpen(false)}
      >
        {selection === null ? null : (
          <SelectionDetails
            onOpenPlannedPath={props.onOpenPlannedPath}
            onOpenVerifiedFile={props.onOpenVerifiedFile}
            onAddConcern={props.onAddConcern}
            onViewInRepositoryMap={props.onViewInRepositoryMap}
            projection={projection}
            selection={selection}
          />
        )}
      </ArchitectureDetailsDrawer>
    </section>
  )
}

export function ArchitectureImpactProjectionSurface(
  props: ArchitectureImpactProjectionSurfaceProps,
)
{
  const projection = props.result?.projection
  const identity =
    projection === undefined
      ? 'unresolved'
      : `${projection.authority}:${projection.projectionId}:${projection.projectionRevision}`
  return <ArchitectureImpactProjectionContent key={identity} {...props} />
}
