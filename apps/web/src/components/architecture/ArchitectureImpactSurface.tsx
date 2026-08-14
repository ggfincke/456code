// apps/web/src/components/architecture/ArchitectureImpactSurface.tsx
// renders one bounded native architecture diff with inspectable evidence

import type { ArchitectureImpactResult } from '@t3tools/contracts'
import {
  ArrowRight,
  FileCode2,
  FolderTree,
  GitCompareArrows,
  Network,
  RotateCcw,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { ScrollArea } from '~/components/ui/scroll-area'
import { cn } from '~/lib/utils'

import { ArchitectureDetailsDrawer } from './ArchitectureDetailsDrawer'
import {
  architectureImpactEdgeVisible,
  architectureImpactNodeSource,
  architectureImpactNodeVisible,
  createArchitectureImpactModel,
  type ArchitectureImpactEdge,
  type ArchitectureImpactExportList,
  type ArchitectureImpactModel,
  type ArchitectureImpactNode,
  type ArchitectureImpactView,
} from './architectureImpactModel'
import {
  architectureImpactSurfaceId,
  isArchitectureRelativePath,
  type ArchitectureFileSource,
} from './architectureResourceIdentity'
import { useArchitectureSurfaceNarrow } from './useArchitectureSurfaceNarrow'

const GRAPH_NODE_LIMIT = 60
const GRAPH_EDGE_LIMIT = 120
const GRAPH_CANVAS_WIDTH = 1_040
const GRAPH_NODE_WIDTH = 284
const GRAPH_NODE_HEIGHT = 76
const GRAPH_ROW_HEIGHT = 106
const GRAPH_REMOVED_X = 28
const GRAPH_CONTEXT_X = 378
const GRAPH_ADDED_X = 728

type ImpactSelection =
  | { readonly kind: 'node'; readonly node: ArchitectureImpactNode }
  | { readonly kind: 'edge'; readonly edge: ArchitectureImpactEdge }

type ImpactColumn = 'removed' | 'context' | 'added'

interface ImpactGraphPosition
{
  readonly x: number
  readonly y: number
}

interface ImpactEdgeCurve
{
  readonly edge: ArchitectureImpactEdge
  readonly fromNode: ArchitectureImpactNode
  readonly toNode: ArchitectureImpactNode
  readonly path: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly midpointX: number
  readonly midpointY: number
}

interface ImpactNodeTone
{
  readonly edge: string
  readonly fill: string
  readonly text: string
}

type ImpactNodeStyle = CSSProperties & {
  readonly '--impact-node-edge': string
  readonly '--impact-node-fill': string
  readonly '--impact-node-text': string
}

export interface ArchitectureImpactSurfaceProps
{
  readonly result: ArchitectureImpactResult | null
  readonly error: string | null
  readonly isPending: boolean
  readonly hasSettled: boolean
  readonly onRetry: () => void
  readonly onOpenFile: (source: ArchitectureFileSource, relativePath: string, line?: number) => void
}

function edgeLabel(kind: ArchitectureImpactEdge['kind']): string
{
  switch (kind)
  {
    case 'added-import':
      return 'Added import'
    case 'removed-import':
      return 'Removed import'
    case 'move':
      return 'Moved file'
    case 'move-flow':
      return 'Move flow'
    case 'new-violation':
      return 'New violation'
    case 'resolved-violation':
      return 'Resolved violation'
  }
}

function nodeTone(node: ArchitectureImpactNode, view: ArchitectureImpactView): ImpactNodeTone
{
  if (view !== 'diff')
  {
    return {
      edge: 'var(--architecture-border)',
      fill: 'var(--architecture-node-neutral)',
      text: 'var(--architecture-text)',
    }
  }
  if (node.kinds.includes('added') || node.kinds.includes('moved-to'))
  {
    return {
      edge: 'color-mix(in srgb, var(--architecture-green) 48%, var(--architecture-border))',
      fill: 'var(--architecture-node-emit)',
      text: 'var(--architecture-green)',
    }
  }
  if (node.kinds.includes('removed') || node.kinds.includes('moved-from'))
  {
    return {
      edge: 'color-mix(in srgb, var(--architecture-red) 48%, var(--architecture-border))',
      fill: 'var(--architecture-node-web)',
      text: 'var(--architecture-red)',
    }
  }
  if (node.kinds.includes('api'))
  {
    return {
      edge: 'color-mix(in srgb, var(--architecture-blue) 46%, var(--architecture-border))',
      fill: 'var(--architecture-node-analyze)',
      text: 'var(--architecture-blue)',
    }
  }
  if (node.kinds.includes('move-flow-from') || node.kinds.includes('move-flow-to'))
  {
    return {
      edge: 'color-mix(in srgb, var(--architecture-orange) 46%, var(--architecture-border))',
      fill: 'var(--architecture-node-cli)',
      text: 'var(--architecture-orange)',
    }
  }
  return {
    edge: 'var(--architecture-border)',
    fill: 'var(--architecture-node-neutral)',
    text: 'var(--architecture-text)',
  }
}

function edgeTone(edge: ArchitectureImpactEdge, view: ArchitectureImpactView): string
{
  if (view !== 'diff') return 'var(--architecture-edge)'
  switch (edge.kind)
  {
    case 'added-import':
    case 'resolved-violation':
      return 'var(--architecture-green)'
    case 'removed-import':
    case 'new-violation':
      return 'var(--architecture-red)'
    case 'move':
    case 'move-flow':
      return 'var(--architecture-orange)'
  }
}

function edgeMarkerTone(edge: ArchitectureImpactEdge): 'added' | 'removed' | 'move'
{
  switch (edge.kind)
  {
    case 'added-import':
    case 'resolved-violation':
      return 'added'
    case 'removed-import':
    case 'new-violation':
      return 'removed'
    case 'move':
    case 'move-flow':
      return 'move'
  }
}

function impactEdgeWidth(edge: ArchitectureImpactEdge): number
{
  if (edge.count === null) return 1.6
  return Math.min(3.6, 1.2 + Math.log2(1 + edge.count) * 0.45)
}

function impactBoundaryPoint(
  position: ImpactGraphPosition,
  deltaX: number,
  deltaY: number,
): { readonly x: number; readonly y: number }
{
  const centerX = position.x + GRAPH_NODE_WIDTH / 2
  const centerY = position.y + GRAPH_NODE_HEIGHT / 2
  const horizontalScale =
    deltaX === 0 ? Number.POSITIVE_INFINITY : GRAPH_NODE_WIDTH / 2 / Math.abs(deltaX)
  const verticalScale =
    deltaY === 0 ? Number.POSITIVE_INFINITY : GRAPH_NODE_HEIGHT / 2 / Math.abs(deltaY)
  const boundaryScale = Math.min(horizontalScale, verticalScale)
  return {
    x: centerX + deltaX * boundaryScale,
    y: centerY + deltaY * boundaryScale,
  }
}

function impactEdgeCurve(
  edge: ArchitectureImpactEdge,
  fromNode: ArchitectureImpactNode,
  toNode: ArchitectureImpactNode,
  from: ImpactGraphPosition,
  to: ImpactGraphPosition,
): ImpactEdgeCurve | null
{
  const fromCenterX = from.x + GRAPH_NODE_WIDTH / 2
  const fromCenterY = from.y + GRAPH_NODE_HEIGHT / 2
  const toCenterX = to.x + GRAPH_NODE_WIDTH / 2
  const toCenterY = to.y + GRAPH_NODE_HEIGHT / 2
  const deltaX = toCenterX - fromCenterX
  const deltaY = toCenterY - fromCenterY
  if (deltaX === 0 && deltaY === 0) return null

  const start = impactBoundaryPoint(from, deltaX, deltaY)
  const end = impactBoundaryPoint(to, -deltaX, -deltaY)
  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY)
  const primaryDistance = horizontal ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)
  const controlOffset = Math.max(44, Math.min(120, primaryDistance * 0.46))
  const direction = horizontal ? Math.sign(deltaX) || 1 : Math.sign(deltaY) || 1
  const path = horizontal
    ? `M${start.x},${start.y} C${start.x + controlOffset * direction},${start.y} ${end.x - controlOffset * direction},${end.y} ${end.x},${end.y}`
    : `M${start.x},${start.y} C${start.x},${start.y + controlOffset * direction} ${end.x},${end.y - controlOffset * direction} ${end.x},${end.y}`

  return {
    edge,
    fromNode,
    toNode,
    path,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    midpointX: (start.x + end.x) / 2,
    midpointY: (start.y + end.y) / 2,
  }
}

function pathName(path: string): string
{
  return path.slice(path.lastIndexOf('/') + 1)
}

function nodeColumn(node: ArchitectureImpactNode): ImpactColumn
{
  if (
    node.kinds.includes('removed') ||
    node.kinds.includes('moved-from') ||
    node.kinds.includes('move-flow-from')
  )
  {
    return 'removed'
  }
  if (
    node.kinds.includes('added') ||
    node.kinds.includes('moved-to') ||
    node.kinds.includes('move-flow-to')
  )
  {
    return 'added'
  }
  return 'context'
}

function sourceLabel(source: ArchitectureFileSource): string
{
  switch (source.kind)
  {
    case 'proposal-generation':
      return source.side === 'base' ? 'Before source' : 'Proposed source'
    case 'diff-analysis':
      return source.side === 'base' ? 'Before source' : 'After source'
  }
}

function OpenSourceButton(props: {
  readonly source: ArchitectureFileSource | null
  readonly path: string
  readonly onOpenFile: ArchitectureImpactSurfaceProps['onOpenFile']
})
{
  const openable = props.source !== null && isArchitectureRelativePath(props.path)
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!openable}
      onClick={() =>
      {
        if (props.source === null || !isArchitectureRelativePath(props.path)) return
        props.onOpenFile(props.source, props.path)
      }}
    >
      <FileCode2 />
      {props.source === null
        ? 'Source unavailable'
        : !isArchitectureRelativePath(props.path)
          ? 'No source file'
          : sourceLabel(props.source)}
    </Button>
  )
}

function ApiExportEvidence(props: {
  readonly label: string
  readonly exports: ArchitectureImpactExportList
})
{
  if (props.exports.total === 0) return null
  return (
    <details className="rounded-lg border border-border bg-muted/15">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-foreground">
        <span>{props.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {props.exports.total.toLocaleString()}
        </span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        {props.exports.items.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No export names were returned.</p>
        ) : (
          <ul className="space-y-2">
            {props.exports.items.map((entry) => (
              <li key={entry.name} className="min-w-0 text-[11px]">
                <div className="flex min-w-0 items-center gap-1.5">
                  <code className="min-w-0 truncate text-foreground">{entry.name}</code>
                  {entry.typeOnly ? (
                    <Badge variant="outline" size="sm">
                      type only
                    </Badge>
                  ) : null}
                </div>
                {entry.brokenConsumers ? (
                  <div className="mt-1 border-l border-destructive/35 pl-2 text-muted-foreground">
                    <p>
                      {entry.brokenConsumers.total.toLocaleString()} broken{' '}
                      {entry.brokenConsumers.total === 1 ? 'consumer' : 'consumers'}
                    </p>
                    {entry.brokenConsumers.items.map((consumer) => (
                      <code key={consumer} className="block truncate text-[10px] text-foreground">
                        {consumer}
                      </code>
                    ))}
                    {entry.brokenConsumers.omitted > 0 ? (
                      <p className="text-[10px]">
                        +{entry.brokenConsumers.omitted.toLocaleString()} omitted
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {props.exports.omitted > 0 ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            +{props.exports.omitted.toLocaleString()} export names omitted
          </p>
        ) : null}
      </div>
    </details>
  )
}

function ExactStats(props: { readonly result: ArchitectureImpactResult })
{
  const stats = [
    {
      label: 'Files',
      value: `+${props.result.addedNodes.total} / -${props.result.removedNodes.total}`,
      detail: `${props.result.movedNodes.total} moved · ${props.result.moveFlows.total} flows`,
    },
    {
      label: 'Imports',
      value: `+${props.result.addedEdges.total} / -${props.result.removedEdges.total}`,
      detail: `${props.result.movedEdges} moved`,
    },
    {
      label: 'Violations',
      value: `+${props.result.newViolations.total} / -${props.result.resolvedViolations.total}`,
      detail: 'new / resolved',
    },
    {
      label: 'API',
      value: props.result.apiTotals.files.toLocaleString(),
      detail: `+${props.result.apiTotals.addedExports} / -${props.result.apiTotals.removedExports} exports · ${props.result.apiTotals.brokenConsumers} broken`,
    },
  ]
  return (
    <dl className="grid shrink-0 grid-cols-2 border-b border-border sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="border-border px-4 py-2.5 not-last:border-r">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {stat.label}
          </dt>
          <dd className="mt-0.5 font-mono text-sm font-semibold text-foreground">{stat.value}</dd>
          <dd className="text-[10px] text-muted-foreground">{stat.detail}</dd>
        </div>
      ))}
    </dl>
  )
}

function OmissionNotice(props: {
  readonly model: ArchitectureImpactModel
  readonly shownNodeCount: number
  readonly shownEdgeCount: number
  readonly returnedNodeCount: number
  readonly returnedEdgeCount: number
})
{
  const serverText = props.model.omissions
    .map((omission) => `${omission.count.toLocaleString()} ${omission.label}`)
    .join(', ')
  const truncated =
    props.shownNodeCount < props.returnedNodeCount || props.shownEdgeCount < props.returnedEdgeCount
  if (serverText.length === 0 && !truncated) return null

  return (
    <div
      className="shrink-0 border-b border-border bg-muted/25 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground"
      role="note"
      data-impact-omissions
    >
      {serverText.length > 0 ? (
        <span>
          The server omitted {serverText} from this bounded witness payload. Exact totals above
          include them.{' '}
        </span>
      ) : null}
      {truncated ? (
        <span>
          Showing {props.shownNodeCount.toLocaleString()} of{' '}
          {props.returnedNodeCount.toLocaleString()} returned paths and{' '}
          {props.shownEdgeCount.toLocaleString()} of {props.returnedEdgeCount.toLocaleString()}{' '}
          returned relationships.
        </span>
      ) : null}
    </div>
  )
}

function GraphView(props: {
  readonly nodes: readonly ArchitectureImpactNode[]
  readonly edges: readonly ArchitectureImpactEdge[]
  readonly view: ArchitectureImpactView
  readonly selection: ImpactSelection | null
  readonly onSelect: (selection: ImpactSelection, trigger: HTMLButtonElement) => void
})
{
  const visibleNodes = useMemo(
    () => props.nodes.filter((node) => architectureImpactNodeVisible(node, props.view)),
    [props.nodes, props.view],
  )
  const positions = useMemo(() =>
  {
    const next = new Map<string, { readonly x: number; readonly y: number }>()
    const rows: Record<ImpactColumn, number> = { removed: 0, context: 0, added: 0 }
    visibleNodes.forEach((node) =>
    {
      const column = nodeColumn(node)
      const row = rows[column]
      rows[column] += 1
      next.set(node.id, {
        x:
          column === 'removed'
            ? GRAPH_REMOVED_X
            : column === 'added'
              ? GRAPH_ADDED_X
              : GRAPH_CONTEXT_X,
        y: 52 + row * GRAPH_ROW_HEIGHT,
      })
    })
    return next
  }, [visibleNodes])
  const nodesByPath = useMemo(
    () => new Map(props.nodes.map((node) => [node.path, node] as const)),
    [props.nodes],
  )
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () =>
      props.edges.filter((edge) =>
      {
        const from = nodesByPath.get(edge.from)
        const to = nodesByPath.get(edge.to)
        return Boolean(
          from &&
          to &&
          visibleNodeIds.has(from.id) &&
          visibleNodeIds.has(to.id) &&
          architectureImpactEdgeVisible(edge, props.view),
        )
      }),
    [nodesByPath, props.edges, props.view, visibleNodeIds],
  )
  const edgeCurves = useMemo(
    () =>
      visibleEdges.flatMap((edge) =>
      {
        const fromNode = nodesByPath.get(edge.from)
        const toNode = nodesByPath.get(edge.to)
        if (fromNode === undefined || toNode === undefined) return []
        const from = positions.get(fromNode.id)
        const to = positions.get(toNode.id)
        if (from === undefined || to === undefined) return []
        const curve = impactEdgeCurve(edge, fromNode, toNode, from, to)
        return curve === null ? [] : [curve]
      }),
    [nodesByPath, positions, visibleEdges],
  )
  const selectedNodeId = props.selection?.kind === 'node' ? props.selection.node.id : null
  const selectedEdgeId = props.selection?.kind === 'edge' ? props.selection.edge.id : null
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const edgeRefs = useRef(new Map<string, HTMLButtonElement>())
  const [focusId, setFocusId] = useState<string | null>(visibleNodes[0]?.id ?? null)
  const [edgeFocusId, setEdgeFocusId] = useState<string | null>(visibleEdges[0]?.id ?? null)
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const markerPrefix = `impact-edge-${useId().replaceAll(':', '')}`
  const inspectedEdgeId = selectedEdgeId ?? focusedEdgeId ?? hoveredEdgeId
  const inspectedEdge = visibleEdges.find((edge) => edge.id === inspectedEdgeId) ?? null
  const inspectedEdgePaths =
    inspectedEdge === null ? null : new Set([inspectedEdge.from, inspectedEdge.to])
  const visibleEdgeIds = useMemo(() => new Set(visibleEdges.map((edge) => edge.id)), [visibleEdges])
  useEffect(() =>
  {
    if (focusId !== null && visibleNodeIds.has(focusId)) return
    setFocusId(visibleNodes[0]?.id ?? null)
  }, [focusId, visibleNodeIds, visibleNodes])
  useEffect(() =>
  {
    if (edgeFocusId !== null && visibleEdgeIds.has(edgeFocusId)) return
    setEdgeFocusId(visibleEdges[0]?.id ?? null)
  }, [edgeFocusId, visibleEdgeIds, visibleEdges])
  const largestColumn = Math.max(
    ...(['removed', 'context', 'added'] as const).map(
      (column) => visibleNodes.filter((node) => nodeColumn(node) === column).length,
    ),
  )
  const canvasHeight = Math.max(300, 58 + largestColumn * GRAPH_ROW_HEIGHT)
  const handleNodeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    node: ArchitectureImpactNode,
  ): void =>
  {
    const index = visibleNodes.findIndex((entry) => entry.id === node.id)
    if (index < 0) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
    {
      nextIndex = (index + 1) % visibleNodes.length
    }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    {
      nextIndex = (index - 1 + visibleNodes.length) % visibleNodes.length
    }
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = visibleNodes.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = visibleNodes[nextIndex]
    if (!next) return
    setFocusId(next.id)
    nodeRefs.current.get(next.id)?.focus()
  }
  const handleEdgeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    edge: ArchitectureImpactEdge,
  ): void =>
  {
    const index = visibleEdges.findIndex((entry) => entry.id === edge.id)
    if (index < 0) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
    {
      nextIndex = (index + 1) % visibleEdges.length
    }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    {
      nextIndex = (index - 1 + visibleEdges.length) % visibleEdges.length
    }
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = visibleEdges.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = visibleEdges[nextIndex]
    if (!next) return
    setEdgeFocusId(next.id)
    edgeRefs.current.get(next.id)?.focus()
  }

  if (visibleNodes.length === 0)
  {
    return (
      <div className="architecture-surface flex min-h-64 items-center justify-center px-6 text-center text-xs text-[var(--architecture-text-muted)]">
        No returned architecture witnesses are present in this view.
      </div>
    )
  }

  return (
    <ScrollArea className="architecture-surface min-h-0 flex-1 rounded-none bg-[radial-gradient(circle_at_center,var(--architecture-grid-dot)_1px,transparent_1px)] bg-[length:16px_16px]">
      <div
        className="relative mx-auto"
        style={{ width: GRAPH_CANVAS_WIDTH, height: canvasHeight }}
        role="group"
        aria-label={`${props.view} architecture graph`}
      >
        <div
          aria-hidden="true"
          className="absolute top-4 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--architecture-red)]"
          style={{ left: GRAPH_REMOVED_X }}
        >
          <span className="size-1.5 rounded-full bg-[var(--architecture-red)]" />
          Removed
        </div>
        <div
          aria-hidden="true"
          className="absolute top-4 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--architecture-text-faint)]"
          style={{ left: GRAPH_CONTEXT_X }}
        >
          <span className="size-1.5 rounded-full bg-[var(--architecture-text-faint)]" />
          Context
        </div>
        <div
          aria-hidden="true"
          className="absolute top-4 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--architecture-green)]"
          style={{ left: GRAPH_ADDED_X }}
        >
          <span className="size-1.5 rounded-full bg-[var(--architecture-green)]" />
          Added
        </div>
        <svg
          aria-hidden="true"
          className="absolute inset-0 size-full"
          viewBox={`0 0 ${GRAPH_CANVAS_WIDTH} ${canvasHeight}`}
        >
          <defs>
            {[
              { id: 'added', color: 'var(--architecture-green)' },
              { id: 'removed', color: 'var(--architecture-red)' },
              { id: 'move', color: 'var(--architecture-orange)' },
              { id: 'active', color: 'var(--architecture-accent)' },
            ].map((marker) => (
              <marker
                id={`${markerPrefix}-${marker.id}`}
                key={marker.id}
                markerHeight="9"
                markerUnits="userSpaceOnUse"
                markerWidth="9"
                orient="auto"
                refX="7"
                refY="3"
                viewBox="0 0 9 6"
              >
                <path d="M0 0 7 3 0 6Z" fill={marker.color} />
              </marker>
            ))}
          </defs>
          {edgeCurves.map((curve) =>
          {
            const selected = curve.edge.id === selectedEdgeId
            const active =
              selected || curve.edge.id === focusedEdgeId || curve.edge.id === hoveredEdgeId
            return (
              <g key={curve.edge.id}>
                <path
                  d={curve.path}
                  fill="none"
                  markerEnd={`url(#${markerPrefix}-${active ? 'active' : edgeMarkerTone(curve.edge)})`}
                  opacity={selectedEdgeId === null || selected ? (active ? 1 : 0.74) : 0.18}
                  pointerEvents="none"
                  stroke={active ? 'var(--architecture-accent)' : edgeTone(curve.edge, props.view)}
                  strokeDasharray={curve.edge.kind.includes('violation') ? '6 5' : undefined}
                  strokeLinecap="round"
                  strokeWidth={
                    selected
                      ? Math.max(2.8, impactEdgeWidth(curve.edge))
                      : impactEdgeWidth(curve.edge)
                  }
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  className="cursor-pointer"
                  d={curve.path}
                  fill="none"
                  pointerEvents="stroke"
                  stroke="transparent"
                  strokeLinecap="round"
                  strokeWidth="18"
                  vectorEffect="non-scaling-stroke"
                  onClick={() =>
                  {
                    const trigger = edgeRefs.current.get(curve.edge.id)
                    if (trigger) props.onSelect({ kind: 'edge', edge: curve.edge }, trigger)
                  }}
                  onMouseEnter={() => setHoveredEdgeId(curve.edge.id)}
                  onMouseLeave={() => setHoveredEdgeId(null)}
                />
              </g>
            )
          })}
        </svg>
        {edgeCurves.map((curve) =>
        {
          const selected = curve.edge.id === selectedEdgeId
          return (
            <button
              aria-label={`Inspect ${edgeLabel(curve.edge.kind)} from ${curve.edge.from} to ${curve.edge.to}`}
              aria-pressed={selected}
              className="absolute z-10 h-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--architecture-accent)] bg-[var(--architecture-overlay)] px-1.5 py-0.5 font-mono text-[9px] leading-none text-[var(--architecture-text)] opacity-0 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--architecture-accent)]"
              data-impact-edge-id={curve.edge.id}
              key={`hit:${curve.edge.id}`}
              ref={(element) =>
              {
                if (element) edgeRefs.current.set(curve.edge.id, element)
                else edgeRefs.current.delete(curve.edge.id)
              }}
              style={{
                left: curve.midpointX,
                top: curve.midpointY,
              }}
              tabIndex={curve.edge.id === edgeFocusId ? 0 : -1}
              type="button"
              onBlur={() => setFocusedEdgeId(null)}
              onClick={(event) =>
                props.onSelect({ kind: 'edge', edge: curve.edge }, event.currentTarget)
              }
              onFocus={() =>
              {
                setEdgeFocusId(curve.edge.id)
                setFocusedEdgeId(curve.edge.id)
              }}
              onKeyDown={(event) => handleEdgeKeyDown(event, curve.edge)}
              onMouseEnter={() => setHoveredEdgeId(curve.edge.id)}
              onMouseLeave={() => setHoveredEdgeId(null)}
            >
              {curve.edge.count === null ? edgeLabel(curve.edge.kind) : `×${curve.edge.count}`}
            </button>
          )
        })}
        {visibleNodes.map((node) =>
        {
          const position = positions.get(node.id)
          if (!position) return null
          const selected = node.id === selectedNodeId
          const edgeEndpoint = inspectedEdgePaths?.has(node.path) ?? false
          const tone = nodeTone(node, props.view)
          const style: ImpactNodeStyle = {
            '--impact-node-edge': tone.edge,
            '--impact-node-fill': tone.fill,
            '--impact-node-text': tone.text,
            left: position.x,
            top: position.y,
            width: GRAPH_NODE_WIDTH,
          }
          return (
            <button
              key={node.id}
              ref={(element) =>
              {
                if (element) nodeRefs.current.set(node.id, element)
                else nodeRefs.current.delete(node.id)
              }}
              type="button"
              tabIndex={node.id === focusId ? 0 : -1}
              className={cn(
                'absolute z-20 flex h-[76px] items-center gap-3 rounded-[11px] border border-[var(--impact-node-edge)] bg-[var(--impact-node-fill)] px-3.5 text-left text-[var(--impact-node-text)] shadow-[var(--architecture-shadow-node)] outline-none transition-[border-color,box-shadow,opacity,transform] hover:-translate-y-px hover:border-[var(--architecture-accent)] hover:shadow-[var(--architecture-shadow-node-hover)] focus-visible:border-[var(--architecture-accent)] focus-visible:ring-2 focus-visible:ring-[var(--architecture-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--architecture-page)]',
                selected &&
                  'border-[var(--architecture-accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--architecture-accent)_20%,transparent),var(--architecture-shadow-node-hover)]',
                edgeEndpoint &&
                  'border-[var(--architecture-accent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--architecture-accent)_16%,transparent),var(--architecture-shadow-node)]',
                selectedEdgeId !== null && !edgeEndpoint && 'opacity-35 hover:opacity-100',
              )}
              style={style}
              onFocus={() => setFocusId(node.id)}
              onKeyDown={(event) => handleNodeKeyDown(event, node)}
              onClick={(event) => props.onSelect({ kind: 'node', node }, event.currentTarget)}
              aria-label={`Inspect ${node.path}`}
              aria-pressed={selected}
            >
              {node.entity === 'directory' ? (
                <FolderTree className="size-[18px] shrink-0 opacity-80" />
              ) : (
                <FileCode2 className="size-[18px] shrink-0 opacity-80" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">
                  {pathName(node.path)}
                </span>
                <span className="mt-1 block truncate font-mono text-[9.5px] text-[var(--architecture-text-muted)]">
                  {node.path}
                </span>
              </span>
              {node.kinds[0] !== 'context' ? (
                <span className="max-w-20 shrink-0 rounded-full border border-[var(--impact-node-edge)] bg-[var(--architecture-page)]/35 px-1.5 py-0.5 text-center text-[8.5px] font-semibold uppercase leading-tight tracking-wide">
                  {node.kinds[0]?.replaceAll('-', ' ')}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function ImpactDetails(props: {
  readonly selection: ImpactSelection | null
  readonly view: ArchitectureImpactView
  readonly model: ArchitectureImpactModel
  readonly onOpenFile: ArchitectureImpactSurfaceProps['onOpenFile']
})
{
  const selection = props.selection
  const node = selection?.kind === 'node' ? selection.node : null
  const edge = selection?.kind === 'edge' ? selection.edge : null
  const nodeSource = node ? architectureImpactNodeSource(props.model, node, props.view) : null
  const edgeSource = edge
    ? edge.kind === 'added-import' || edge.kind === 'new-violation'
      ? props.model.headSource
      : edge.kind === 'removed-import' || edge.kind === 'resolved-violation'
        ? props.model.baseSource
        : null
    : null
  return (
    <>
      {node ? (
        <>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Path
            </p>
            <p className="mt-1 break-all font-mono text-xs text-foreground">{node.path}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {node.kinds.map((kind) => (
              <Badge key={kind} variant="outline">
                {kind.replaceAll('-', ' ')}
              </Badge>
            ))}
          </div>
          {node.api ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                API exports: +{node.api.addedExports.total} / -{node.api.removedExports.total}
              </p>
              <ApiExportEvidence label="Added exports" exports={node.api.addedExports} />
              <ApiExportEvidence label="Removed exports" exports={node.api.removedExports} />
            </div>
          ) : null}
          {node.entity === 'file' ? (
            <OpenSourceButton source={nodeSource} path={node.path} onOpenFile={props.onOpenFile} />
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Aggregated directory endpoint from returned move-flow evidence.
            </p>
          )}
        </>
      ) : null}
      {edge ? (
        <>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="break-all font-mono text-xs text-foreground">{edge.from}</p>
            <ArrowRight className="my-2 size-3.5 text-muted-foreground" />
            <p className="break-all font-mono text-xs text-foreground">{edge.to}</p>
          </div>
          {edge.rule ? (
            <p className="text-xs text-muted-foreground">
              Rule <span className="font-mono text-foreground">{edge.rule}</span>
              {edge.severity ? ` · ${edge.severity}` : ''}
            </p>
          ) : null}
          {edge.kind === 'move-flow' && edge.count !== null ? (
            <p className="text-xs text-muted-foreground">
              {edge.count.toLocaleString()} {edge.count === 1 ? 'file moved' : 'files moved'} across
              this directory transition.
            </p>
          ) : null}
          {edge.kind === 'move' ? (
            <div className="flex flex-wrap gap-2">
              <OpenSourceButton
                source={props.model.baseSource}
                path={edge.from}
                onOpenFile={props.onOpenFile}
              />
              <OpenSourceButton
                source={props.model.headSource}
                path={edge.to}
                onOpenFile={props.onOpenFile}
              />
            </div>
          ) : edge.kind === 'move-flow' ? null : (
            <div className="flex flex-wrap gap-2">
              <OpenSourceButton
                source={edgeSource}
                path={edge.from}
                onOpenFile={props.onOpenFile}
              />
              <OpenSourceButton source={edgeSource} path={edge.to} onOpenFile={props.onOpenFile} />
            </div>
          )}
        </>
      ) : null}
      {selection !== null && props.model.baseSource === null && props.model.headSource === null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          This legacy impact payload has no immutable source selectors. Refresh the analysis to
          enable exact source actions.
        </p>
      ) : null}
    </>
  )
}

function ArchitectureImpactSurfaceContent(props: ArchitectureImpactSurfaceProps)
{
  const [surfaceRef, narrow] = useArchitectureSurfaceNarrow<HTMLElement>()
  const view: ArchitectureImpactView = 'diff'
  const [selection, setSelection] = useState<ImpactSelection | null>(null)
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null)
  const model = useMemo(
    () => (props.result === null ? null : createArchitectureImpactModel(props.result)),
    [props.result],
  )
  const viewNodes = (model?.nodes ?? []).filter((node) => architectureImpactNodeVisible(node, view))
  const viewNodePaths = new Set(viewNodes.map((node) => node.path))
  const viewEdges = (model?.edges ?? []).filter(
    (edge) =>
      architectureImpactEdgeVisible(edge, view) &&
      viewNodePaths.has(edge.from) &&
      viewNodePaths.has(edge.to),
  )
  const graphNodes = viewNodes.slice(0, GRAPH_NODE_LIMIT)
  const graphNodePaths = new Set(graphNodes.map((node) => node.path))
  const graphEdges = viewEdges
    .filter((edge) => graphNodePaths.has(edge.from) && graphNodePaths.has(edge.to))
    .slice(0, GRAPH_EDGE_LIMIT)
  if (props.result === null)
  {
    const message =
      props.error ??
      (props.isPending || !props.hasSettled
        ? 'Loading the exact architecture graph diff.'
        : 'No architecture graph diff is available.')
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <Network className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            {props.error ? 'Architecture impact unavailable' : 'Loading architecture impact'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{message}</p>
          {props.error ? (
            <Button className="mt-4" size="sm" variant="outline" onClick={props.onRetry}>
              <RotateCcw />
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  if (model === null) return null

  const closeDetails = (): void =>
  {
    setSelection(null)
  }
  const select = (next: ImpactSelection, trigger: HTMLElement): void =>
  {
    setSelection(next)
    setReturnFocus(trigger)
  }
  const selectedNode = selection?.kind === 'node' ? selection.node : null
  const selectedEdge = selection?.kind === 'edge' ? selection.edge : null

  return (
    <section
      ref={surfaceRef}
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      aria-label="Architecture Impact Diff"
    >
      <header className="surface-subheader h-auto min-h-14 flex-wrap gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <GitCompareArrows className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground">
                Architecture impact
              </h2>
              <Badge variant={props.result.changed ? 'info' : 'secondary'}>
                {props.result.changed ? 'Changed' : 'Unchanged'}
              </Badge>
            </div>
            <p className="truncate text-[10px] text-muted-foreground" title={props.result.summary}>
              {props.result.base.gitRef ?? 'Base graph'} →{' '}
              {props.result.head.gitRef ?? 'Head graph'}
            </p>
          </div>
        </div>
      </header>
      <ExactStats result={props.result} />
      <OmissionNotice
        model={model}
        shownNodeCount={graphNodes.length}
        shownEdgeCount={graphEdges.length}
        returnedNodeCount={viewNodes.length}
        returnedEdgeCount={viewEdges.length}
      />
      <div className="architecture-surface flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--architecture-border-soft)] bg-[var(--architecture-sunken)] px-4 py-2">
        <p className="text-xs text-[var(--architecture-text-muted)]">
          Changed paths and their immediate architecture context
        </p>
        <div
          aria-label="Diff graph legend"
          className="ms-auto hidden items-center gap-3 text-[10px] text-[var(--architecture-text-faint)] sm:flex"
          role="note"
        >
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-[var(--architecture-edge)]" />
            relationship
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dashed border-[var(--architecture-red)]" />
            rule change
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-[2.5px] border-[var(--architecture-accent)]" />
            selected
          </span>
        </div>
      </div>
      <GraphView
        edges={graphEdges}
        nodes={graphNodes}
        selection={selection}
        view={view}
        onSelect={select}
      />
      <ArchitectureDetailsDrawer
        description={
          selectedNode
            ? selectedNode.entity === 'directory'
              ? 'Returned directory flow witness'
              : 'Returned file witness'
            : selectedEdge
              ? 'Returned relationship witness'
              : undefined
        }
        narrow={narrow}
        open={selection !== null}
        returnFocus={returnFocus}
        title={
          selectedNode
            ? pathName(selectedNode.path)
            : selectedEdge
              ? edgeLabel(selectedEdge.kind)
              : 'Details'
        }
        onClose={closeDetails}
      >
        <ImpactDetails
          model={model}
          onOpenFile={props.onOpenFile}
          selection={selection}
          view={view}
        />
      </ArchitectureDetailsDrawer>
    </section>
  )
}

function impactResultIdentity(result: ArchitectureImpactResult): string
{
  if (result.version === 1) return `legacy:${JSON.stringify(result)}`
  return [
    architectureImpactSurfaceId({
      threadId: result.baseSource.threadId,
      comparison: result.comparison,
    }),
    result.impactDigest,
    result.baseSource.graphDigest,
    result.headSource.graphDigest,
  ].join(':')
}

export function ArchitectureImpactSurface(props: ArchitectureImpactSurfaceProps)
{
  const identity = props.result === null ? 'empty' : impactResultIdentity(props.result)
  return <ArchitectureImpactSurfaceContent key={identity} {...props} />
}
