// apps/web/src/components/architecture/ArchitectureCanvas.tsx
// renders bounded architecture nodes and selectable weighted relationships

import type { ArchitectureProjectionEdge, ArchitectureProjectionUnit } from '@t3tools/contracts'
import { Maximize2Icon, MinusIcon, PlusIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'

import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

export interface ArchitectureCanvasPoint
{
  readonly unit: ArchitectureProjectionUnit
  readonly x: number
  readonly y: number
}

interface ArchitectureCanvasLayout
{
  readonly points: readonly ArchitectureCanvasPoint[]
  readonly width: number
  readonly height: number
}

interface ArchitectureCanvasEdgeCurve
{
  readonly edge: ArchitectureProjectionEdge
  readonly id: string
  readonly from: ArchitectureCanvasPoint
  readonly to: ArchitectureCanvasPoint
  readonly path: string
  readonly centerX: number
  readonly centerY: number
}

interface ArchitectureCanvasBounds
{
  readonly x: number
  readonly y: number
  readonly right: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

interface ArchitectureCanvasCamera
{
  readonly scale: number
  readonly translateX: number
  readonly translateY: number
}

interface ArchitectureCanvasViewport
{
  readonly width: number
  readonly height: number
}

type ArchitectureNodeStyle = CSSProperties & {
  readonly '--architecture-node-edge': string
  readonly '--architecture-node-fill': string
}

export interface ArchitectureCanvasProps
{
  readonly units: readonly ArchitectureProjectionUnit[]
  readonly edges: readonly ArchitectureProjectionEdge[]
  readonly selectedUnitId: string | null
  readonly selectedEdge: ArchitectureProjectionEdge | null
  readonly ariaLabel: string
  readonly onSelect: (unit: ArchitectureProjectionUnit, trigger: HTMLButtonElement) => void
  readonly onSelectEdge: (edge: ArchitectureProjectionEdge, trigger: HTMLButtonElement) => void
}

const ARCHITECTURE_NODE_WIDTH = 236
const ARCHITECTURE_NODE_HEIGHT = 96
const ARCHITECTURE_POSITION_SCALE_X = 1.25
const ARCHITECTURE_POSITION_SCALE_Y = 1.18
const ARCHITECTURE_CANVAS_PADDING = 68
const ARCHITECTURE_CANVAS_MIN_WIDTH = 760
const ARCHITECTURE_CANVAS_MIN_HEIGHT = 540
const ARCHITECTURE_CAMERA_MIN_SCALE = 0.12
const ARCHITECTURE_CAMERA_MAX_SCALE = 1.6
const ARCHITECTURE_CAMERA_FIT_MAX_SCALE = 1
const ARCHITECTURE_CAMERA_MARGIN = 40
const ARCHITECTURE_CAMERA_ZOOM_STEP = 0.1
const ARCHITECTURE_MINIMAP_WIDTH = 168
const ARCHITECTURE_MINIMAP_CONTROL_GAP = 64
const ARCHITECTURE_MINIMAP_MIN_HEIGHT = 60
const ARCHITECTURE_MINIMAP_MAX_HEIGHT = 130

const ARCHITECTURE_NODE_TONES = [
  {
    edge: 'color-mix(in srgb, var(--architecture-blue) 42%, var(--architecture-border))',
    fill: 'var(--architecture-node-analyze)',
  },
  {
    edge: 'color-mix(in srgb, var(--architecture-green) 38%, var(--architecture-border))',
    fill: 'var(--architecture-node-emit)',
  },
  {
    edge: 'color-mix(in srgb, var(--architecture-teal) 38%, var(--architecture-border))',
    fill: 'var(--architecture-node-store)',
  },
  {
    edge: 'color-mix(in srgb, var(--architecture-amber) 38%, var(--architecture-border))',
    fill: 'var(--architecture-node-cli)',
  },
  {
    edge: 'color-mix(in srgb, var(--architecture-purple) 42%, var(--architecture-border))',
    fill: 'var(--architecture-node-mcp)',
  },
  {
    edge: 'color-mix(in srgb, var(--architecture-red) 36%, var(--architecture-border))',
    fill: 'var(--architecture-node-web)',
  },
] as const

function architectureEdgeId(edge: ArchitectureProjectionEdge): string
{
  return JSON.stringify([edge.from, edge.to])
}

function stableToneIndex(value: string): number
{
  let hash = 0
  for (let index = 0; index < value.length; index += 1)
  {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash % ARCHITECTURE_NODE_TONES.length
}

function architectureNodeStyle(point: ArchitectureCanvasPoint): ArchitectureNodeStyle
{
  const ownershipKey = point.unit.parent ?? point.unit.id
  const tone = ARCHITECTURE_NODE_TONES[stableToneIndex(ownershipKey)]
  return {
    '--architecture-node-edge': tone?.edge ?? 'var(--architecture-border)',
    '--architecture-node-fill': tone?.fill ?? 'var(--architecture-node-neutral)',
    left: point.x,
    top: point.y,
  }
}

function createArchitectureCanvasLayout(
  units: readonly ArchitectureProjectionUnit[],
): ArchitectureCanvasLayout
{
  if (units.length === 0)
  {
    return {
      points: [],
      width: ARCHITECTURE_CANVAS_MIN_WIDTH,
      height: ARCHITECTURE_CANVAS_MIN_HEIGHT,
    }
  }

  const xPositions = [...new Set(units.map((unit) => unit.position.x))].sort((a, b) => a - b)
  const yPositions = [...new Set(units.map((unit) => unit.position.y))].sort((a, b) => a - b)
  const xRank = new Map(xPositions.map((position, index) => [position, index] as const))
  const yRank = new Map(yPositions.map((position, index) => [position, index] as const))
  const points = units.map((unit) => ({
    unit,
    x:
      (xRank.get(unit.position.x) ?? 0) * 240 * ARCHITECTURE_POSITION_SCALE_X +
      ARCHITECTURE_CANVAS_PADDING +
      ARCHITECTURE_NODE_WIDTH / 2,
    y:
      (yRank.get(unit.position.y) ?? 0) * 140 * ARCHITECTURE_POSITION_SCALE_Y +
      ARCHITECTURE_CANVAS_PADDING +
      ARCHITECTURE_NODE_HEIGHT / 2,
  }))
  const farthestX = Math.max(...points.map((point) => point.x))
  const farthestY = Math.max(...points.map((point) => point.y))

  return {
    points,
    width: Math.max(
      ARCHITECTURE_CANVAS_MIN_WIDTH,
      farthestX + ARCHITECTURE_NODE_WIDTH / 2 + ARCHITECTURE_CANVAS_PADDING,
    ),
    height: Math.max(
      ARCHITECTURE_CANVAS_MIN_HEIGHT,
      farthestY + ARCHITECTURE_NODE_HEIGHT / 2 + ARCHITECTURE_CANVAS_PADDING,
    ),
  }
}

export function architectureCanvasPoints(
  units: readonly ArchitectureProjectionUnit[],
): readonly ArchitectureCanvasPoint[]
{
  return createArchitectureCanvasLayout(units).points
}

function clamp(value: number, minimum: number, maximum: number): number
{
  return Math.min(maximum, Math.max(minimum, value))
}

function architectureCanvasBounds(
  points: readonly ArchitectureCanvasPoint[],
): ArchitectureCanvasBounds
{
  if (points.length === 0)
  {
    return {
      x: 0,
      y: 0,
      right: ARCHITECTURE_CANVAS_MIN_WIDTH,
      bottom: ARCHITECTURE_CANVAS_MIN_HEIGHT,
      width: ARCHITECTURE_CANVAS_MIN_WIDTH,
      height: ARCHITECTURE_CANVAS_MIN_HEIGHT,
    }
  }

  const padding = ARCHITECTURE_CANVAS_PADDING * 0.65
  const left = Math.min(...points.map((point) => point.x - ARCHITECTURE_NODE_WIDTH / 2)) - padding
  const top = Math.min(...points.map((point) => point.y - ARCHITECTURE_NODE_HEIGHT / 2)) - padding
  const right = Math.max(...points.map((point) => point.x + ARCHITECTURE_NODE_WIDTH / 2)) + padding
  const bottom =
    Math.max(...points.map((point) => point.y + ARCHITECTURE_NODE_HEIGHT / 2)) + padding

  return {
    x: left,
    y: top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function centeredTranslation(
  viewportLength: number,
  contentStart: number,
  contentLength: number,
  scale: number,
): number
{
  return (viewportLength - contentLength * scale) / 2 - contentStart * scale
}

function clampCamera(
  camera: ArchitectureCanvasCamera,
  bounds: ArchitectureCanvasBounds,
  viewport: ArchitectureCanvasViewport,
  bottomInset: number,
): ArchitectureCanvasCamera
{
  const scale = clamp(camera.scale, ARCHITECTURE_CAMERA_MIN_SCALE, ARCHITECTURE_CAMERA_MAX_SCALE)
  const availableHeight = Math.max(1, viewport.height - bottomInset)
  const contentWidth = bounds.width * scale
  const contentHeight = bounds.height * scale
  const centeredX = centeredTranslation(viewport.width, bounds.x, bounds.width, scale)
  const centeredY = centeredTranslation(availableHeight, bounds.y, bounds.height, scale)
  const minimumX = viewport.width - ARCHITECTURE_CAMERA_MARGIN - bounds.right * scale
  const maximumX = ARCHITECTURE_CAMERA_MARGIN - bounds.x * scale
  const minimumY = availableHeight - ARCHITECTURE_CAMERA_MARGIN - bounds.bottom * scale
  const maximumY = ARCHITECTURE_CAMERA_MARGIN - bounds.y * scale

  return {
    scale,
    translateX:
      contentWidth <= viewport.width - ARCHITECTURE_CAMERA_MARGIN * 2
        ? centeredX
        : clamp(camera.translateX, minimumX, maximumX),
    translateY:
      contentHeight <= availableHeight - ARCHITECTURE_CAMERA_MARGIN * 2
        ? centeredY
        : clamp(camera.translateY, minimumY, maximumY),
  }
}

function fitCamera(
  bounds: ArchitectureCanvasBounds,
  viewport: ArchitectureCanvasViewport,
  bottomInset: number,
): ArchitectureCanvasCamera
{
  const availableWidth = Math.max(1, viewport.width - ARCHITECTURE_CAMERA_MARGIN * 2)
  const availableViewportHeight = Math.max(1, viewport.height - bottomInset)
  const availableHeight = Math.max(1, availableViewportHeight - ARCHITECTURE_CAMERA_MARGIN * 2)
  const scale = clamp(
    Math.min(availableWidth / bounds.width, availableHeight / bounds.height),
    ARCHITECTURE_CAMERA_MIN_SCALE,
    ARCHITECTURE_CAMERA_FIT_MAX_SCALE,
  )

  return {
    scale,
    translateX: centeredTranslation(viewport.width, bounds.x, bounds.width, scale),
    translateY: centeredTranslation(availableViewportHeight, bounds.y, bounds.height, scale),
  }
}

function cubicPoint(start: number, controlOne: number, controlTwo: number, end: number): number
{
  return (start + controlOne * 3 + controlTwo * 3 + end) / 8
}

function edgeWidth(weight: number): number
{
  return Math.min(3.6, 1.2 + Math.log2(1 + weight) * 0.45)
}

function rectangularBoundaryPoint(
  point: ArchitectureCanvasPoint,
  deltaX: number,
  deltaY: number,
): { readonly x: number; readonly y: number }
{
  const horizontalScale =
    deltaX === 0 ? Number.POSITIVE_INFINITY : ARCHITECTURE_NODE_WIDTH / 2 / Math.abs(deltaX)
  const verticalScale =
    deltaY === 0 ? Number.POSITIVE_INFINITY : ARCHITECTURE_NODE_HEIGHT / 2 / Math.abs(deltaY)
  const boundaryScale = Math.min(horizontalScale, verticalScale)
  return {
    x: point.x + deltaX * boundaryScale,
    y: point.y + deltaY * boundaryScale,
  }
}

function edgeCurve(
  edge: ArchitectureProjectionEdge,
  pointsById: ReadonlyMap<string, ArchitectureCanvasPoint>,
  hasReciprocalEdge: boolean,
): ArchitectureCanvasEdgeCurve | null
{
  const from = pointsById.get(edge.from)
  const to = pointsById.get(edge.to)
  if (from === undefined || to === undefined) return null

  const deltaX = to.x - from.x
  const deltaY = to.y - from.y
  if (deltaX === 0 && deltaY === 0) return null

  const start = rectangularBoundaryPoint(from, deltaX, deltaY)
  const endTowardSource = rectangularBoundaryPoint(to, -deltaX, -deltaY)
  const x1 = start.x
  const y1 = start.y
  const x2 = endTowardSource.x
  const y2 = endTowardSource.y
  const chordLength = Math.hypot(x2 - x1, y2 - y1)
  const normalX = chordLength === 0 ? 0 : -(y2 - y1) / chordLength
  const normalY = chordLength === 0 ? 0 : (x2 - x1) / chordLength
  const reciprocalOffset = hasReciprocalEdge ? 22 : 0
  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY)
  const primaryDistance = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1)
  const controlOffset = Math.max(42, Math.min(116, primaryDistance * 0.45))
  const direction = horizontal ? Math.sign(deltaX) || 1 : Math.sign(deltaY) || 1
  const controlOneX = hasReciprocalEdge
    ? x1 + (x2 - x1) * 0.35 + normalX * reciprocalOffset
    : horizontal
      ? x1 + controlOffset * direction
      : x1
  const controlOneY = hasReciprocalEdge
    ? y1 + (y2 - y1) * 0.35 + normalY * reciprocalOffset
    : horizontal
      ? y1
      : y1 + controlOffset * direction
  const controlTwoX = hasReciprocalEdge
    ? x1 + (x2 - x1) * 0.65 + normalX * reciprocalOffset
    : horizontal
      ? x2 - controlOffset * direction
      : x2
  const controlTwoY = hasReciprocalEdge
    ? y1 + (y2 - y1) * 0.65 + normalY * reciprocalOffset
    : horizontal
      ? y2
      : y2 - controlOffset * direction
  const path = `M${x1},${y1} C${controlOneX},${controlOneY} ${controlTwoX},${controlTwoY} ${x2},${y2}`

  return {
    edge,
    id: architectureEdgeId(edge),
    from,
    to,
    path,
    centerX: cubicPoint(x1, controlOneX, controlTwoX, x2),
    centerY: cubicPoint(y1, controlOneY, controlTwoY, y2),
  }
}

export function ArchitectureCanvas(props: ArchitectureCanvasProps)
{
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const edgeRefs = useRef(new Map<string, HTMLButtonElement>())
  const canvasPanRef = useRef<{
    readonly pointerId: number
    readonly clientX: number
    readonly clientY: number
  } | null>(null)
  const minimapRef = useRef<HTMLButtonElement>(null)
  const minimapPointerRef = useRef<number | null>(null)
  const fittedSceneRef = useRef<string | null>(null)
  const [nodeFocusId, setNodeFocusId] = useState<string | null>(null)
  const [edgeFocusId, setEdgeFocusId] = useState<string | null>(null)
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)
  const [viewport, setViewport] = useState<ArchitectureCanvasViewport>({
    width: 0,
    height: 0,
  })
  const [camera, setCamera] = useState<ArchitectureCanvasCamera>({
    scale: 1,
    translateX: 0,
    translateY: 0,
  })
  const arrowMarkerId = `architecture-arrow-${useId().replaceAll(':', '')}`
  const activeArrowMarkerId = `${arrowMarkerId}-active`
  const layout = useMemo(() => createArchitectureCanvasLayout(props.units), [props.units])
  const points = layout.points
  const bounds = useMemo(() => architectureCanvasBounds(points), [points])
  const sceneIdentity = useMemo(
    () => props.units.map((unit) => `${unit.id}:${unit.position.x}:${unit.position.y}`).join('|'),
    [props.units],
  )
  const pointsById = useMemo(
    () => new Map(points.map((point) => [point.unit.id, point] as const)),
    [points],
  )
  const edgeCurves = useMemo(() =>
  {
    const directedEdgeIds = new Set(props.edges.map((edge) => architectureEdgeId(edge)))
    return props.edges.flatMap((edge) =>
    {
      const reciprocalId = architectureEdgeId({
        from: edge.to,
        to: edge.from,
        weight: edge.weight,
      })
      const curve = edgeCurve(edge, pointsById, directedEdgeIds.has(reciprocalId))
      return curve === null ? [] : [curve]
    })
  }, [pointsById, props.edges])
  const visibleEdgeIds = useMemo(() => new Set(edgeCurves.map((curve) => curve.id)), [edgeCurves])
  const selectedEdgeId = props.selectedEdge === null ? null : architectureEdgeId(props.selectedEdge)
  const hasVisibleSelectedEdge = selectedEdgeId !== null && visibleEdgeIds.has(selectedEdgeId)
  const hasVisibleSelectedUnit =
    props.selectedUnitId !== null && pointsById.has(props.selectedUnitId)
  const activeNodeFocusId =
    nodeFocusId !== null && pointsById.has(nodeFocusId)
      ? nodeFocusId
      : hasVisibleSelectedUnit
        ? props.selectedUnitId
        : (points[0]?.unit.id ?? null)
  const activeEdgeFocusId =
    edgeFocusId !== null && visibleEdgeIds.has(edgeFocusId)
      ? edgeFocusId
      : hasVisibleSelectedEdge
        ? selectedEdgeId
        : (edgeCurves[0]?.id ?? null)
  const inspectedEdgeId = selectedEdgeId ?? focusedEdgeId ?? hoveredEdgeId
  const inspectedEdge = edgeCurves.find((curve) => curve.id === inspectedEdgeId) ?? null
  const outsidePageEdgeCount = useMemo(
    () =>
      props.edges.filter((edge) => !pointsById.has(edge.from) || !pointsById.has(edge.to)).length,
    [pointsById, props.edges],
  )
  const minimapHeight = clamp(
    (ARCHITECTURE_MINIMAP_WIDTH * bounds.height) / Math.max(1, bounds.width),
    ARCHITECTURE_MINIMAP_MIN_HEIGHT,
    ARCHITECTURE_MINIMAP_MAX_HEIGHT,
  )
  const showMinimap = viewport.width >= 640 && viewport.height >= 520 && props.units.length >= 6
  const cameraBottomInset = showMinimap ? minimapHeight + ARCHITECTURE_MINIMAP_CONTROL_GAP : 0
  const visibleWorld = {
    x: Math.max(bounds.x, -camera.translateX / camera.scale),
    y: Math.max(bounds.y, -camera.translateY / camera.scale),
    right: Math.min(bounds.right, (viewport.width - camera.translateX) / camera.scale),
    bottom: Math.min(
      bounds.bottom,
      (viewport.height - cameraBottomInset - camera.translateY) / camera.scale,
    ),
  }

  useEffect(() =>
  {
    const element = viewportRef.current
    if (element === null) return

    const measure = (): void =>
    {
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
      }
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      )
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() =>
  {
    if (viewport.width === 0 || viewport.height === 0 || props.units.length === 0) return

    if (fittedSceneRef.current !== sceneIdentity)
    {
      fittedSceneRef.current = sceneIdentity
      setCamera(fitCamera(bounds, viewport, cameraBottomInset))
      return
    }

    setCamera((current) => clampCamera(current, bounds, viewport, cameraBottomInset))
  }, [bounds, cameraBottomInset, props.units.length, sceneIdentity, viewport])

  const updateCamera = useCallback(
    (update: (current: ArchitectureCanvasCamera) => ArchitectureCanvasCamera): void =>
    {
      if (viewport.width === 0 || viewport.height === 0) return
      setCamera((current) => clampCamera(update(current), bounds, viewport, cameraBottomInset))
    },
    [bounds, cameraBottomInset, viewport],
  )

  const fitCanvas = useCallback((): void =>
  {
    if (viewport.width === 0 || viewport.height === 0) return
    setCamera(fitCamera(bounds, viewport, cameraBottomInset))
  }, [bounds, cameraBottomInset, viewport])

  const zoomAt = useCallback(
    (scale: number, focalX = viewport.width / 2, focalY = viewport.height / 2): void =>
    {
      updateCamera((current) =>
      {
        const nextScale = clamp(scale, ARCHITECTURE_CAMERA_MIN_SCALE, ARCHITECTURE_CAMERA_MAX_SCALE)
        const worldX = (focalX - current.translateX) / current.scale
        const worldY = (focalY - current.translateY) / current.scale
        return {
          scale: nextScale,
          translateX: focalX - worldX * nextScale,
          translateY: focalY - worldY * nextScale,
        }
      })
    },
    [updateCamera, viewport.height, viewport.width],
  )

  const focusWorldPoint = useCallback(
    (x: number, y: number): void =>
    {
      updateCamera((current) => ({
        ...current,
        translateX: viewport.width / 2 - x * current.scale,
        translateY: viewport.height / 2 - y * current.scale,
      }))
    },
    [updateCamera, viewport.height, viewport.width],
  )

  const activateEdge = useCallback(
    (curve: ArchitectureCanvasEdgeCurve): void =>
    {
      const trigger = edgeRefs.current.get(curve.id)
      if (trigger === undefined) return
      trigger.focus()
      props.onSelectEdge(curve.edge, trigger)
    },
    [props.onSelectEdge],
  )

  const focusRelativeNode = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    offset: -1 | 1,
  ): void =>
  {
    event.preventDefault()
    const nextIndex = (index + offset + props.units.length) % props.units.length
    const nextUnit = props.units[nextIndex]
    if (nextUnit === undefined) return
    const nextButton = nodeRefs.current.get(nextUnit.id)
    if (nextButton === undefined) return
    const nextPoint = pointsById.get(nextUnit.id)
    if (nextPoint !== undefined) focusWorldPoint(nextPoint.x, nextPoint.y)
    setNodeFocusId(nextUnit.id)
    nextButton.focus()
  }

  const focusRelativeEdge = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    offset: -1 | 1,
  ): void =>
  {
    event.preventDefault()
    const nextCurve = edgeCurves[(index + offset + edgeCurves.length) % edgeCurves.length]
    if (nextCurve === undefined) return
    setEdgeFocusId(nextCurve.id)
    focusWorldPoint(nextCurve.centerX, nextCurve.centerY)
    edgeRefs.current.get(nextCurve.id)?.focus()
  }

  const onCanvasPointerDown = (event: PointerEvent<HTMLDivElement>): void =>
  {
    if (event.button !== 0) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('button, [data-architecture-edge-hit]') !== null
    )
    {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    canvasPanRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    }
    setPanning(true)
  }

  const onCanvasPointerMove = (event: PointerEvent<HTMLDivElement>): void =>
  {
    const previous = canvasPanRef.current
    if (previous === null || previous.pointerId !== event.pointerId) return
    event.preventDefault()
    canvasPanRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    }
    updateCamera((current) => ({
      ...current,
      translateX: current.translateX + event.clientX - previous.clientX,
      translateY: current.translateY + event.clientY - previous.clientY,
    }))
  }

  const endCanvasPan = (event: PointerEvent<HTMLDivElement>): void =>
  {
    if (canvasPanRef.current?.pointerId !== event.pointerId) return
    canvasPanRef.current = null
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
    {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onCanvasWheel = (event: WheelEvent<HTMLDivElement>): void =>
  {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey)
    {
      const rect = event.currentTarget.getBoundingClientRect()
      const nextScale = camera.scale * Math.exp(-event.deltaY * 0.0015)
      zoomAt(nextScale, event.clientX - rect.left, event.clientY - rect.top)
      return
    }

    const horizontalDelta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
    const verticalDelta = event.shiftKey ? 0 : event.deltaY
    updateCamera((current) => ({
      ...current,
      translateX: current.translateX - horizontalDelta,
      translateY: current.translateY - verticalDelta,
    }))
  }

  const panFromMinimap = (event: PointerEvent<HTMLButtonElement>): void =>
  {
    const element = minimapRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    const minimapScale = Math.min(rect.width / bounds.width, rect.height / bounds.height)
    const offsetX = (rect.width - bounds.width * minimapScale) / 2
    const offsetY = (rect.height - bounds.height * minimapScale) / 2
    const worldX = clamp(
      bounds.x + (event.clientX - rect.left - offsetX) / minimapScale,
      bounds.x,
      bounds.right,
    )
    const worldY = clamp(
      bounds.y + (event.clientY - rect.top - offsetY) / minimapScale,
      bounds.y,
      bounds.bottom,
    )
    focusWorldPoint(worldX, worldY)
  }

  const onMinimapPointerDown = (event: PointerEvent<HTMLButtonElement>): void =>
  {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    minimapPointerRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    panFromMinimap(event)
  }

  const onMinimapPointerMove = (event: PointerEvent<HTMLButtonElement>): void =>
  {
    if (minimapPointerRef.current !== event.pointerId) return
    event.preventDefault()
    panFromMinimap(event)
  }

  const endMinimapPan = (event: PointerEvent<HTMLButtonElement>): void =>
  {
    if (minimapPointerRef.current !== event.pointerId) return
    minimapPointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
    {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  if (props.units.length === 0)
  {
    return (
      <div className="architecture-surface flex min-h-64 items-center justify-center text-sm text-[var(--architecture-text-muted)]">
        No architecture units are available in this bounded projection.
      </div>
    )
  }

  return (
    <div
      ref={viewportRef}
      aria-label={props.ariaLabel}
      className={cn(
        'architecture-surface relative size-full min-h-0 touch-none overflow-hidden overscroll-contain bg-[var(--architecture-page)]',
        panning ? 'cursor-grabbing' : 'cursor-grab',
      )}
      data-architecture-canvas
      data-panning={panning ? 'true' : 'false'}
      onPointerCancel={endCanvasPan}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onCanvasPointerMove}
      onPointerUp={endCanvasPan}
      onWheel={onCanvasWheel}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,var(--architecture-grid-dot)_1px,transparent_1px)] bg-[length:16px_16px]"
      />
      <div
        className="absolute start-0 top-0 will-change-transform"
        data-architecture-stage
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${camera.translateX}px, ${camera.translateY}px) scale(${camera.scale})`,
          transformOrigin: '0 0',
        }}
      >
        <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
          <defs>
            <marker
              id={arrowMarkerId}
              markerHeight="9"
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              orient="auto"
              refX="7"
              refY="3"
              viewBox="0 0 9 6"
            >
              <path d="M0 0 7 3 0 6Z" fill="var(--architecture-edge)" />
            </marker>
            <marker
              id={activeArrowMarkerId}
              markerHeight="9"
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              orient="auto"
              refX="7"
              refY="3"
              viewBox="0 0 9 6"
            >
              <path d="M0 0 7 3 0 6Z" fill="var(--architecture-accent)" />
            </marker>
          </defs>
          {edgeCurves.map((curve) =>
          {
            const selected = curve.id === selectedEdgeId
            const active = selected || curve.id === focusedEdgeId || curve.id === hoveredEdgeId
            return (
              <g key={curve.id}>
                <path
                  d={curve.path}
                  fill="none"
                  markerEnd={`url(#${active ? activeArrowMarkerId : arrowMarkerId})`}
                  opacity={selectedEdgeId === null || selected ? (active ? 1 : 0.78) : 0.2}
                  pointerEvents="none"
                  stroke={active ? 'var(--architecture-accent)' : 'var(--architecture-edge)'}
                  strokeLinecap="round"
                  strokeWidth={
                    selected
                      ? Math.max(2.6, edgeWidth(curve.edge.weight))
                      : edgeWidth(curve.edge.weight)
                  }
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  className="cursor-pointer"
                  data-architecture-edge-hit={curve.id}
                  d={curve.path}
                  fill="none"
                  pointerEvents="stroke"
                  stroke="transparent"
                  strokeLinecap="round"
                  strokeWidth="18"
                  vectorEffect="non-scaling-stroke"
                  onClick={() => activateEdge(curve)}
                  onMouseEnter={() => setHoveredEdgeId(curve.id)}
                  onMouseLeave={() => setHoveredEdgeId(null)}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              </g>
            )
          })}
        </svg>
        {edgeCurves.map((curve, index) =>
        {
          const selected = curve.id === selectedEdgeId
          const active = selected || curve.id === focusedEdgeId || curve.id === hoveredEdgeId
          return (
            <button
              ref={(button) =>
              {
                if (button === null) edgeRefs.current.delete(curve.id)
                else edgeRefs.current.set(curve.id, button)
              }}
              aria-label={`Inspect dependency from ${curve.from.unit.label} to ${curve.to.unit.label}, weight ${curve.edge.weight}`}
              aria-pressed={selected}
              className={cn(
                'absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--architecture-accent)] bg-[var(--architecture-overlay)] px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-[var(--architecture-text)] shadow-[var(--architecture-shadow-node)] outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--architecture-accent)]',
                active ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
              )}
              data-architecture-edge-id={curve.id}
              key={`badge:${curve.id}`}
              style={{ left: curve.centerX, top: curve.centerY }}
              tabIndex={curve.id === activeEdgeFocusId ? 0 : -1}
              type="button"
              onBlur={() => setFocusedEdgeId(null)}
              onClick={(event) => props.onSelectEdge(curve.edge, event.currentTarget)}
              onFocus={() =>
              {
                setEdgeFocusId(curve.id)
                setFocusedEdgeId(curve.id)
              }}
              onKeyDown={(event) =>
              {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                {
                  focusRelativeEdge(event, index, 1)
                }
                else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
                {
                  focusRelativeEdge(event, index, -1)
                }
                else if (event.key === 'Home')
                {
                  event.preventDefault()
                  const first = edgeCurves[0]
                  if (first === undefined) return
                  setEdgeFocusId(first.id)
                  focusWorldPoint(first.centerX, first.centerY)
                  edgeRefs.current.get(first.id)?.focus()
                }
                else if (event.key === 'End')
                {
                  event.preventDefault()
                  const last = edgeCurves.at(-1)
                  if (last === undefined) return
                  setEdgeFocusId(last.id)
                  focusWorldPoint(last.centerX, last.centerY)
                  edgeRefs.current.get(last.id)?.focus()
                }
              }}
              onMouseEnter={() => setHoveredEdgeId(curve.id)}
              onMouseLeave={() => setHoveredEdgeId(null)}
              onPointerDown={(event) => event.stopPropagation()}
            >
              ×{curve.edge.weight}
            </button>
          )
        })}
        {points.map((point, index) =>
        {
          const selected = props.selectedUnitId === point.unit.id
          const connectedToInspectedEdge =
            inspectedEdge !== null &&
            (inspectedEdge.edge.from === point.unit.id || inspectedEdge.edge.to === point.unit.id)
          return (
            <button
              ref={(node) =>
              {
                if (node === null) nodeRefs.current.delete(point.unit.id)
                else nodeRefs.current.set(point.unit.id, node)
              }}
              aria-label={`${point.unit.label}, ${point.unit.fileCount} files`}
              aria-pressed={selected}
              className={cn(
                'absolute z-20 flex h-24 w-[236px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[11px] border px-[15px] pb-3 pt-[11px] text-left text-[var(--architecture-text)] shadow-[var(--architecture-shadow-node)] outline-none transition-[border-color,box-shadow,opacity,transform] hover:-translate-y-[calc(50%+1px)] hover:border-[var(--architecture-accent)] hover:shadow-[var(--architecture-shadow-node-hover)] focus-visible:border-[var(--architecture-accent)] focus-visible:ring-2 focus-visible:ring-[var(--architecture-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--architecture-page)]',
                'border-[var(--architecture-node-edge)] bg-[var(--architecture-node-fill)]',
                selected &&
                  'border-[var(--architecture-accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--architecture-accent)_20%,transparent),var(--architecture-shadow-node-hover)]',
                connectedToInspectedEdge &&
                  'border-[var(--architecture-accent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--architecture-accent)_16%,transparent),var(--architecture-shadow-node)]',
                hasVisibleSelectedEdge &&
                  !connectedToInspectedEdge &&
                  'opacity-35 hover:opacity-100',
              )}
              data-architecture-unit-id={point.unit.id}
              key={point.unit.id}
              style={architectureNodeStyle(point)}
              tabIndex={point.unit.id === activeNodeFocusId ? 0 : -1}
              type="button"
              onClick={(event) => props.onSelect(point.unit, event.currentTarget)}
              onFocus={() => setNodeFocusId(point.unit.id)}
              onKeyDown={(event) =>
              {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                {
                  focusRelativeNode(event, index, 1)
                }
                else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
                {
                  focusRelativeNode(event, index, -1)
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span className="flex min-w-0 items-center justify-between gap-3">
                <span className="truncate text-[13px] font-semibold">{point.unit.label}</span>
                <span className="shrink-0 rounded-full border border-[var(--architecture-node-edge)] bg-[var(--architecture-page)]/40 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-[var(--architecture-text-secondary)]">
                  {point.unit.fileCount}
                </span>
              </span>
              <span className="mt-1 line-clamp-2 min-h-7 text-[10.5px] leading-[1.35] text-[var(--architecture-text-muted)]">
                {point.unit.description ?? `${point.unit.level.slice(0, -1)} architecture unit`}
              </span>
              <span className="mt-auto flex items-center gap-2 font-mono text-[9px] tabular-nums text-[var(--architecture-text-faint)]">
                <span>in {point.unit.inbound}</span>
                <span aria-hidden="true">·</span>
                <span>out {point.unit.outbound}</span>
              </span>
            </button>
          )
        })}
      </div>
      {showMinimap ? (
        <button
          ref={minimapRef}
          aria-label="Architecture minimap. Click or drag to pan; activate with the keyboard to fit."
          className="absolute bottom-[52px] start-3 z-40 cursor-crosshair touch-none overflow-hidden rounded-[11px] border border-[var(--architecture-border)] bg-[var(--architecture-overlay)]/90 shadow-[var(--architecture-shadow-node)] backdrop-blur-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--architecture-accent)]"
          style={{ width: ARCHITECTURE_MINIMAP_WIDTH, height: minimapHeight }}
          type="button"
          onClick={(event) =>
            {
            if (event.detail === 0) fitCanvas()
          }}
          onPointerCancel={endMinimapPan}
          onPointerDown={onMinimapPointerDown}
          onPointerMove={onMinimapPointerMove}
          onPointerUp={endMinimapPan}
        >
          <svg
            aria-hidden="true"
            className="size-full"
            preserveAspectRatio="xMidYMid meet"
            viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
          >
            <rect
              fill="color-mix(in srgb, var(--architecture-page) 72%, transparent)"
              height={bounds.height}
              rx="18"
              stroke="var(--architecture-border-soft)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              width={bounds.width}
              x={bounds.x}
              y={bounds.y}
            />
            {edgeCurves.map((curve) => (
              <path
                d={curve.path}
                fill="none"
                key={`minimap:${curve.id}`}
                opacity={curve.id === selectedEdgeId ? 1 : 0.52}
                stroke={
                  curve.id === selectedEdgeId
                    ? 'var(--architecture-accent)'
                    : 'var(--architecture-edge)'
                }
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {points.map((point) => (
              <circle
                cx={point.x}
                cy={point.y}
                fill={
                  point.unit.id === props.selectedUnitId
                    ? 'var(--architecture-accent)'
                    : 'var(--architecture-text-muted)'
                }
                key={`minimap:${point.unit.id}`}
                r="7"
              />
            ))}
            <rect
              fill="color-mix(in srgb, var(--architecture-accent) 12%, transparent)"
              height={Math.max(0, visibleWorld.bottom - visibleWorld.y)}
              rx="8"
              stroke="var(--architecture-accent)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              width={Math.max(0, visibleWorld.right - visibleWorld.x)}
              x={visibleWorld.x}
              y={visibleWorld.y}
            />
          </svg>
        </button>
      ) : null}
      <fieldset
        aria-label="Canvas navigation"
        className="absolute bottom-3 start-3 z-40 flex items-center gap-0.5 rounded-[11px] border border-[var(--architecture-border)] bg-[var(--architecture-overlay)]/90 p-0.5 shadow-[var(--architecture-shadow-node)] backdrop-blur-md"
      >
        <Button
          aria-label="Zoom out"
          className="text-[var(--architecture-text-muted)] hover:bg-[var(--architecture-hover)] hover:text-[var(--architecture-text)]"
          disabled={camera.scale <= ARCHITECTURE_CAMERA_MIN_SCALE}
          size="icon-xs"
          title="Zoom out"
          variant="ghost"
          onClick={() => zoomAt(camera.scale - ARCHITECTURE_CAMERA_ZOOM_STEP)}
        >
          <MinusIcon />
        </Button>
        <Button
          aria-label={`Zoom level ${Math.round(camera.scale * 100)} percent. Reset to 100 percent.`}
          className="min-w-12 px-1 font-mono text-[10px] tabular-nums text-[var(--architecture-text-secondary)] hover:bg-[var(--architecture-hover)] hover:text-[var(--architecture-text)]"
          size="xs"
          title="Reset zoom to 100%"
          variant="ghost"
          onClick={() => zoomAt(1)}
        >
          {Math.round(camera.scale * 100)}%
        </Button>
        <Button
          aria-label="Zoom in"
          className="text-[var(--architecture-text-muted)] hover:bg-[var(--architecture-hover)] hover:text-[var(--architecture-text)]"
          disabled={camera.scale >= ARCHITECTURE_CAMERA_MAX_SCALE}
          size="icon-xs"
          title="Zoom in"
          variant="ghost"
          onClick={() => zoomAt(camera.scale + ARCHITECTURE_CAMERA_ZOOM_STEP)}
        >
          <PlusIcon />
        </Button>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--architecture-border-soft)]" />
        <Button
          aria-label="Fit architecture to view"
          className="text-[var(--architecture-text-muted)] hover:bg-[var(--architecture-hover)] hover:text-[var(--architecture-text)]"
          size="icon-xs"
          title="Fit to view"
          variant="ghost"
          onClick={fitCanvas}
        >
          <Maximize2Icon />
        </Button>
      </fieldset>
      {outsidePageEdgeCount > 0 ? (
        <p className="absolute bottom-3 end-3 z-30 rounded-md border border-[var(--architecture-border)] bg-[var(--architecture-overlay)] px-2 py-1 text-[10px] text-[var(--architecture-text-muted)] shadow-[var(--architecture-shadow-node)]">
          {outsidePageEdgeCount} returned{' '}
          {outsidePageEdgeCount === 1 ? 'dependency connects' : 'dependencies connect'} units
          outside this page.
        </p>
      ) : null}
    </div>
  )
}
