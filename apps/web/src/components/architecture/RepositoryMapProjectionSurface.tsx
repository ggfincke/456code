// apps/web/src/components/architecture/RepositoryMapProjectionSurface.tsx
// presents one pinned standing generation through Architecture and Structure lenses

import type {
  ArchitectureGraphProjection,
  ArchitectureGraphProjectionNode,
  ArchitectureStandingAnchor,
  ArchitectureStandingSource,
  EnvironmentId,
  ThreadId,
} from '@t3tools/contracts'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import {
  ArrowUpRightIcon,
  BoxesIcon,
  FolderTreeIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { Button } from '~/components/ui/button'
import type { ArchitectureConcernGraphSelection } from '~/composerDraftStore'
import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import { useAtomCommand } from '~/state/use-atom-command'

import { ArchitectureDetailsDrawer } from './ArchitectureDetailsDrawer'
import {
  ArchitectureGraphCanvas,
  type ArchitectureGraphCanvasEdge,
  type ArchitectureGraphCanvasNode,
} from './ArchitectureGraphCanvas'
import { ArchitectureGraphSelectionDetails } from './ArchitectureGraphSelectionDetails'
import { ArchitectureQueryState } from './ArchitectureQueryState'
import type {
  ArchitectureFileOpenTarget,
  RepositoryAtlasTarget,
} from './architectureResourceIdentity'
import { createRepositoryMapProjectionScene } from './repositoryMapProjectionScene'
import { useArchitectureSurfaceNarrow } from './useArchitectureSurfaceNarrow'

type RepositoryMapSelection = ArchitectureConcernGraphSelection

interface RepositoryMapLensNotice
{
  readonly status: 'ambiguous' | 'unmatched'
  readonly disclosure: string
}

export interface RepositoryMapFocusRequest
{
  readonly requestId: number
  readonly anchor: ArchitectureStandingAnchor
}

export interface RepositoryMapProjectionSurfaceProps
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly target: RepositoryAtlasTarget
  readonly focusRequest?: RepositoryMapFocusRequest | undefined
  readonly narrow?: boolean | undefined
  readonly onOpenFile?: ((target: ArchitectureFileOpenTarget) => void) | undefined
  readonly onViewUpdated?: ((target: RepositoryAtlasTarget) => void) | undefined
  readonly onAddConcern?:
    | ((
        projection: ArchitectureGraphProjection,
        selection: ArchitectureConcernGraphSelection,
      ) => void)
    | undefined
}

function sameStandingSource(
  left: ArchitectureStandingSource,
  right: ArchitectureStandingSource,
): boolean
{
  return (
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    left.generationId === right.generationId &&
    left.side === right.side &&
    left.graphDigest === right.graphDigest
  )
}

function anchorFocusIds(anchor: ArchitectureStandingAnchor | null): string[]
{
  if (anchor === null) return []
  if (anchor.candidateIds.length > 0) return [...anchor.candidateIds]
  if (anchor.focusId !== undefined) return [anchor.focusId]
  if (anchor.nearestId !== undefined) return [anchor.nearestId]
  return []
}

function initialSelectionId(anchor: ArchitectureStandingAnchor | null): string | null
{
  if (anchor === null || anchor.status === 'ambiguous') return null
  return anchor.focusId ?? anchor.nearestId ?? anchor.candidateIds[0] ?? null
}

function freshnessLabel(freshness: ArchitectureGraphProjection['freshness']): string
{
  switch (freshness)
  {
    case 'fresh':
      return 'Current generation'
    case 'dirty':
      return 'Source changed'
    case 'stale':
      return 'Older pinned generation'
    case 'reverted':
      return 'Reverted generation'
  }
}

function selectionAnchor(
  projection: ArchitectureGraphProjection,
  selection: RepositoryMapSelection,
): ArchitectureStandingAnchor | undefined
{
  const id = selection.kind === 'node' ? selection.node.id : selection.edge.id
  return projection.anchors.find((anchor) => anchor.selectionId === id)
}

function RepositoryMapDetails(props: {
  readonly projection: ArchitectureGraphProjection
  readonly source: ArchitectureStandingSource
  readonly selection: RepositoryMapSelection
  readonly onDrill: (node: ArchitectureGraphProjectionNode) => void
  readonly onOpenFile?: RepositoryMapProjectionSurfaceProps['onOpenFile']
  readonly onSwitchLens: (anchor: ArchitectureStandingAnchor) => void
  readonly onAddConcern?: RepositoryMapProjectionSurfaceProps['onAddConcern']
})
{
  const anchor = selectionAnchor(props.projection, props.selection)
  const node = props.selection.kind === 'node' ? props.selection.node : null
  return (
    <ArchitectureGraphSelectionDetails
      anchor={anchor}
      selection={props.selection}
      actions={
        <div className="flex flex-col gap-2">
          {node && node.semanticLevel !== 'files' ? (
            <Button size="sm" onClick={() => props.onDrill(node)}>
              Open {node.semanticLevel === 'dirs' ? 'directory' : node.semanticLevel.slice(0, -1)}
              <ArrowUpRightIcon />
            </Button>
          ) : null}
          {node?.semanticLevel === 'files' && node.relativePath && props.onOpenFile ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                props.onOpenFile?.({
                  source: props.source,
                  relativePath: node.relativePath!,
                })
              }
            >
              Open workspace file
              <ArrowUpRightIcon />
            </Button>
          ) : null}
          {anchor ? (
            <Button size="sm" variant="outline" onClick={() => props.onSwitchLens(anchor)}>
              View in {anchor.lens === 'architecture' ? 'Architecture' : 'Structure'}
            </Button>
          ) : null}
          {props.onAddConcern ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.onAddConcern?.(props.projection, props.selection)}
            >
              Add concern to composer
            </Button>
          ) : null}
        </div>
      }
    />
  )
}

export function RepositoryMapProjectionSurface(props: RepositoryMapProjectionSurfaceProps)
{
  const initialAnchor = props.focusRequest?.anchor ?? null
  const [surfaceRef, measuredNarrow] = useArchitectureSurfaceNarrow<HTMLElement>(props.narrow)
  const [lens, setLens] = useState<'architecture' | 'structure'>(
    initialAnchor?.lens ?? 'architecture',
  )
  const [scope, setScope] = useState<{
    readonly level: ArchitectureGraphProjectionNode['semanticLevel']
    readonly id: string
  } | null>(null)
  const [focusAnchor, setFocusAnchor] = useState<ArchitectureStandingAnchor | null>(initialAnchor)
  const [lensNotice, setLensNotice] = useState<RepositoryMapLensNotice | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectionId(initialAnchor))
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null)
  const [isRebuilding, setIsRebuilding] = useState(false)
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const rebuildProjectAtlas = useAtomCommand(projectEnvironment.rebuildProjectAtlas, {
    reportFailure: false,
  })
  const focusIds = anchorFocusIds(focusAnchor)
  const rootQuery = useEnvironmentQuery(
    scope === null
      ? projectEnvironment.getRepositoryMap({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            projectId: props.target.projectId,
            generationId: props.target.generationId,
            lens,
            ...(focusIds.length === 0 ? {} : { focusIds }),
          },
        })
      : null,
  )
  const scopeQuery = useEnvironmentQuery(
    scope === null
      ? null
      : projectEnvironment.getArchitectureScope({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            source: props.target,
            lens,
            scope,
          },
        }),
  )
  const statusQuery = useEnvironmentQuery(
    projectEnvironment.projectAtlasStatus({
      environmentId: props.environmentId,
      input: { projectId: props.target.projectId },
    }),
  )
  const activeQuery = scope === null ? rootQuery : scopeQuery
  const activeData = activeQuery.data
  const projection =
    activeData !== null &&
    activeData.kind === 'repository-map' &&
    activeData.source.kind === 'standing-project-generation' &&
    sameStandingSource(activeData.source, props.target) &&
    activeData.lens === lens &&
    (scope === null
      ? activeData.breadcrumbs.length === 0 &&
        focusIds.every((id) => activeData.nodes.some((node) => node.id === id))
      : activeData.breadcrumbs.at(-1)?.id === scope.id &&
        activeData.breadcrumbs.at(-1)?.level === scope.level)
      ? activeData
      : null
  const identityError =
    activeQuery.data !== null && projection === null
      ? 'The server did not return the requested exact Repository Map projection.'
      : null
  const scene = useMemo(
    () => (projection === null ? null : createRepositoryMapProjectionScene(projection)),
    [projection],
  )
  const selectedNode = selectedId === null ? null : (scene?.nodesById.get(selectedId) ?? null)
  const selectedEdge =
    selectedEdgeId === null ? null : (scene?.edgesById.get(selectedEdgeId) ?? null)
  const selection: RepositoryMapSelection | null = selectedNode
    ? { kind: 'node', node: selectedNode }
    : selectedEdge
      ? { kind: 'edge', edge: selectedEdge }
      : null
  const updatedTarget =
    statusQuery.data?.source !== null &&
    statusQuery.data?.source !== undefined &&
    !sameStandingSource(statusQuery.data.source, props.target)
      ? statusQuery.data.source
      : undefined

  const clearSelection = useCallback((): void =>
  {
    setSelectedId(null)
    setSelectedEdgeId(null)
    setDrawerOpen(false)
  }, [])

  const switchLens = useCallback(
    (nextLens: 'architecture' | 'structure', anchor?: ArchitectureStandingAnchor): void =>
    {
      if (nextLens === lens && anchor === undefined) return
      const resolvedAnchor =
        anchor ??
        (selection === null || projection === null
          ? undefined
          : selectionAnchor(projection, selection))
      const nextAnchor = resolvedAnchor?.lens === nextLens ? resolvedAnchor : null
      const unresolvedAnchor = nextAnchor === null ? focusAnchor : null
      setLens(nextLens)
      setScope(null)
      setFocusAnchor(nextAnchor)
      setLensNotice(
        unresolvedAnchor === null
          ? null
          : {
              status: unresolvedAnchor.status === 'ambiguous' ? 'ambiguous' : 'unmatched',
              disclosure:
                unresolvedAnchor.status === 'ambiguous'
                  ? `The prior ${lens === 'architecture' ? 'Architecture' : 'Structure'} anchor has multiple exact candidates, so no exact ${nextLens === 'architecture' ? 'Architecture' : 'Structure'} handoff was selected.`
                  : `No exact ${nextLens === 'architecture' ? 'Architecture' : 'Structure'} identity is available for the prior selection. The lens remains pinned to the same generation at its root.`,
            },
      )
      setSelectedId(initialSelectionId(nextAnchor))
      setSelectedEdgeId(null)
      setDrawerOpen(false)
    },
    [focusAnchor, lens, projection, selection],
  )

  const rebuild = useCallback((): void =>
  {
    if (isRebuilding) return
    setIsRebuilding(true)
    setRebuildError(null)
    void rebuildProjectAtlas({
      environmentId: props.environmentId,
      input: { projectId: props.target.projectId },
    }).then((result) =>
    {
      setIsRebuilding(false)
      if (result._tag === 'Success')
      {
        statusQuery.refresh()
        return
      }
      if (isAtomCommandInterrupted(result)) return
      const failure = squashAtomCommandFailure(result)
      setRebuildError(
        failure instanceof Error && failure.message.trim().length > 0
          ? failure.message
          : 'The Repository Map rebuild could not be started.',
      )
    })
  }, [isRebuilding, props.environmentId, props.target.projectId, rebuildProjectAtlas, statusQuery])

  if (projection === null || scene === null)
  {
    const message = identityError ?? activeQuery.error
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col" data-repository-map>
        {message ? (
          <ArchitectureQueryState
            alternateAction={
              updatedTarget && props.onViewUpdated
                ? {
                    label: 'Open newer map',
                    onClick: () => props.onViewUpdated?.(updatedTarget),
                  }
                : undefined
            }
            kind="error"
            message={message}
            title="Repository Map unavailable"
            onRetry={activeQuery.refresh}
          />
        ) : (
          <ArchitectureQueryState
            kind="loading"
            message="Loading the pinned graph projection."
            title="Loading Repository Map"
          />
        )}
      </div>
    )
  }

  const highlightedNodeIds =
    focusAnchor === null
      ? []
      : focusAnchor.candidateIds.length > 0
        ? [...focusAnchor.candidateIds]
        : focusAnchor.nearestId === undefined
          ? []
          : [focusAnchor.nearestId]
  const selectedCanvasNodeId =
    selectedNode?.id ??
    (focusAnchor?.status === 'ambiguous' ? null : initialSelectionId(focusAnchor))

  return (
    <section
      ref={surfaceRef}
      aria-label="Repository Map"
      className="architecture-surface relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      data-repository-map
      data-repository-map-lens={lens}
    >
      <header className="shrink-0 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-surface)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-[var(--architecture-border)] bg-[var(--architecture-node-store)] text-[var(--architecture-accent)] shadow-[var(--architecture-shadow-node)]">
              {lens === 'architecture' ? (
                <BoxesIcon className="size-4.5" />
              ) : (
                <FolderTreeIcon className="size-4.5" />
              )}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold text-[var(--architecture-text)]">
                {projection.repository?.name ?? 'Repository Map'}
              </h1>
              <p className="truncate font-mono text-[10px] text-[var(--architecture-text-faint)]">
                {projection.repository?.scope ??
                  `Generation ${props.target.generationId.slice(0, 8)}`}
                {projection.repository?.gitRef ? ` · ${projection.repository.gitRef}` : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {updatedTarget && props.onViewUpdated ? (
              <Button size="sm" onClick={() => props.onViewUpdated?.(updatedTarget)}>
                Open newer map
              </Button>
            ) : null}
            <Button
              aria-label="Reload Repository Map"
              disabled={activeQuery.isPending}
              size="icon-sm"
              title="Reload Repository Map"
              variant="ghost"
              onClick={activeQuery.refresh}
            >
              <RefreshCwIcon className={activeQuery.isPending ? 'animate-spin' : undefined} />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-[var(--architecture-text-faint)]">
          <span>{freshnessLabel(projection.freshness)}</span>
          <span aria-hidden="true">·</span>
          <span title={props.target.generationId}>
            Generation {props.target.generationId.slice(0, 8)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{projection.totals.nodes.total.toLocaleString()} objects</span>
          <span aria-hidden="true">·</span>
          <span>{projection.totals.edges.total.toLocaleString()} relationships</span>
        </div>
      </header>
      {activeQuery.error ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--architecture-red)_30%,var(--architecture-border-soft))] bg-[color-mix(in_srgb,var(--architecture-red)_7%,var(--architecture-surface))] px-3 py-2 text-xs"
          role="alert"
        >
          <span>{activeQuery.error} The pinned projection remains selected.</span>
          <Button size="xs" variant="outline" onClick={activeQuery.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {statusQuery.data?.state === 'error' || rebuildError ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--architecture-red)_30%,var(--architecture-border-soft))] px-3 py-2 text-xs"
          role="alert"
        >
          <span>
            {rebuildError ?? statusQuery.data?.lastBuildError ?? 'The latest map build failed.'}
          </span>
          <Button disabled={isRebuilding} size="xs" variant="outline" onClick={rebuild}>
            {isRebuilding ? <RefreshCwIcon className="animate-spin" /> : <RotateCcwIcon />}
            {isRebuilding ? 'Rebuilding' : 'Rebuild'}
          </Button>
        </div>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-3 py-2">
        <nav
          aria-label="Repository Map hierarchy"
          className="flex min-w-0 flex-wrap items-center gap-1 text-[11px]"
        >
          <Button
            aria-current={scope === null ? 'page' : undefined}
            size="xs"
            variant="ghost"
            onClick={() =>
            {
              setScope(null)
              setFocusAnchor(null)
              setLensNotice(null)
              clearSelection()
            }}
          >
            Root
          </Button>
          {projection.breadcrumbs
            .filter((breadcrumb) => breadcrumb.id !== 'dirs:.')
            .map((breadcrumb) => (
              <span className="flex min-w-0 items-center gap-1" key={breadcrumb.id}>
                <span aria-hidden="true" className="text-[var(--architecture-text-faint)]">
                  /
                </span>
                <Button
                  className="max-w-40 truncate"
                  size="xs"
                  title={breadcrumb.label}
                  variant="ghost"
                  onClick={() =>
                  {
                    setScope({ level: breadcrumb.level, id: breadcrumb.id })
                    setFocusAnchor(null)
                    setLensNotice(null)
                    clearSelection()
                  }}
                >
                  {breadcrumb.label}
                </Button>
              </span>
            ))}
        </nav>
        <div
          aria-label="Repository Map lens"
          className="flex rounded-lg border border-[var(--architecture-border)] bg-[var(--architecture-surface)] p-0.5"
          role="group"
        >
          {(['architecture', 'structure'] as const).map((option) => (
            <Button
              aria-pressed={lens === option}
              key={option}
              size="sm"
              variant={lens === option ? 'secondary' : 'ghost'}
              onClick={() => switchLens(option)}
            >
              {option === 'architecture' ? 'Architecture' : 'Structure'}
            </Button>
          ))}
        </div>
      </div>
      {focusAnchor ? (
        <div
          className="border-b border-[color-mix(in_srgb,var(--architecture-amber)_30%,var(--architecture-border-soft))] bg-[color-mix(in_srgb,var(--architecture-amber)_8%,var(--architecture-surface))] px-3 py-2 text-[11px] text-[var(--architecture-text-muted)]"
          role="status"
        >
          <strong className="font-medium text-[var(--architecture-text)]">
            {focusAnchor.status === 'ambiguous'
              ? 'Multiple exact candidates.'
              : focusAnchor.status === 'unmatched'
                ? 'Not present in this repository generation.'
                : focusAnchor.status === 'stale'
                  ? 'Pinned older context.'
                  : 'Exact standing match.'}
          </strong>{' '}
          {focusAnchor.disclosure}
        </div>
      ) : null}
      {focusAnchor === null && lensNotice ? (
        <div
          className="border-b border-[color-mix(in_srgb,var(--architecture-amber)_30%,var(--architecture-border-soft))] bg-[color-mix(in_srgb,var(--architecture-amber)_8%,var(--architecture-surface))] px-3 py-2 text-[11px] text-[var(--architecture-text-muted)]"
          role="status"
        >
          <strong className="font-medium text-[var(--architecture-text)]">
            {lensNotice.status === 'ambiguous'
              ? 'Cross-lens identity is ambiguous.'
              : 'No exact cross-lens identity.'}
          </strong>{' '}
          {lensNotice.disclosure}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ArchitectureGraphCanvas
          ariaLabel={`${projection.repository?.name ?? 'Repository'} ${lens} lens`}
          edges={scene.edges}
          emptyLabel="No objects are available at this exact Repository Map scope."
          highlightedNodeIds={highlightedNodeIds}
          nodes={scene.nodes}
          selectedEdgeId={selectedEdge?.id ?? null}
          selectedNodeId={selectedCanvasNodeId}
          onSelectEdge={(edge: ArchitectureGraphCanvasEdge, trigger: HTMLButtonElement) =>
          {
            const source = scene.edgesById.get(edge.id)
            if (source === undefined) return
            setSelectedEdgeId(source.id)
            setSelectedId(null)
            setLensNotice(null)
            setDrawerOpen(true)
            setReturnFocus(trigger)
          }}
          onSelectNode={(node: ArchitectureGraphCanvasNode, trigger: HTMLButtonElement) =>
          {
            const source = scene.nodesById.get(node.id)
            if (source === undefined) return
            setSelectedId(source.id)
            setSelectedEdgeId(null)
            setLensNotice(null)
            setDrawerOpen(true)
            setReturnFocus(trigger)
          }}
        />
      </div>
      <ArchitectureDetailsDrawer
        description={
          selectedNode
            ? `${selectedNode.semanticLevel} · ${selectedNode.fileCount.toLocaleString()} files`
            : selectedEdge
              ? `${selectedEdge.relationshipKind} · weight ${selectedEdge.weight.toLocaleString()}`
              : undefined
        }
        narrow={measuredNarrow}
        open={drawerOpen && selection !== null}
        returnFocus={returnFocus}
        title={selectedNode?.label ?? selectedEdge?.relationshipKind ?? 'Repository Map details'}
        onClose={() => setDrawerOpen(false)}
      >
        {selection ? (
          <RepositoryMapDetails
            onDrill={(node) =>
              {
              setScope({ level: node.semanticLevel, id: node.id })
              setFocusAnchor(null)
              setLensNotice(null)
              clearSelection()
            }}
            onAddConcern={props.onAddConcern}
            onOpenFile={props.onOpenFile}
            onSwitchLens={(anchor) => switchLens(anchor.lens, anchor)}
            projection={projection}
            selection={selection}
            source={props.target}
          />
        ) : null}
      </ArchitectureDetailsDrawer>
    </section>
  )
}
