// apps/web/src/components/architecture/impactProjectionScene.ts
// adapts one shared impact projection into graph-canvas presentation records

import type {
  ArchitectureGraphProjection,
  ArchitectureGraphProjectionEdge,
  ArchitectureGraphProjectionNode,
} from '@t3tools/contracts'

import type {
  ArchitectureGraphCanvasEdge,
  ArchitectureGraphCanvasNode,
} from './ArchitectureGraphCanvas'

export interface ImpactProjectionScene
{
  readonly nodes: readonly ArchitectureGraphCanvasNode[]
  readonly edges: readonly ArchitectureGraphCanvasEdge[]
  readonly nodesById: ReadonlyMap<string, ArchitectureGraphProjectionNode>
  readonly edgesById: ReadonlyMap<string, ArchitectureGraphProjectionEdge>
}

function semanticLabel(level: ArchitectureGraphProjectionNode['semanticLevel']): string
{
  switch (level)
  {
    case 'systems':
      return 'system'
    case 'blocks':
      return 'block'
    case 'dirs':
      return 'directory'
    case 'files':
      return 'file'
  }
}

function nodeDescription(node: ArchitectureGraphProjectionNode): string
{
  if (node.relativePath !== undefined) return node.relativePath
  return `${node.stateLabel} ${semanticLabel(node.semanticLevel)}`
}

function nodeFooter(node: ArchitectureGraphProjectionNode): string[]
{
  const labels = [
    `${node.fileCount.toLocaleString()} ${node.fileCount === 1 ? 'file' : 'files'}`,
    `in ${node.inbound.toLocaleString()}`,
    `out ${node.outbound.toLocaleString()}`,
  ]
  if (node.affectedConsumerCount > 0)
  {
    labels.push(`${node.affectedConsumerCount.toLocaleString()} consumers`)
  }
  return labels
}

function sceneNode(node: ArchitectureGraphProjectionNode): ArchitectureGraphCanvasNode
{
  return {
    id: node.id,
    label: node.label,
    description: nodeDescription(node),
    badgeLabel: node.stateLabel,
    footerLabels: nodeFooter(node),
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    position: node.position,
    tintKey: node.tintKey,
    tone: node.state,
    stroke: node.stroke,
    ariaLabel: `${node.label}, ${node.stateLabel.toLowerCase()} ${semanticLabel(node.semanticLevel)}, ${node.fileCount.toLocaleString()} files`,
  }
}

function sceneEdge(
  edge: ArchitectureGraphProjectionEdge,
  nodes: ReadonlyMap<string, ArchitectureGraphProjectionNode>,
): ArchitectureGraphCanvasEdge
{
  const from = nodes.get(edge.from)?.label ?? edge.from
  const to = nodes.get(edge.to)?.label ?? edge.to
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    weight: edge.weight,
    label: edge.stateLabel,
    tone: edge.state,
    stroke: edge.stroke,
    showBadge: true,
    ariaLabel: `Inspect ${edge.stateLabel.toLowerCase()} ${edge.relationshipKind} relationship from ${from} to ${to}, weight ${edge.weight.toLocaleString()}`,
  }
}

export function createImpactProjectionScene(
  projection: ArchitectureGraphProjection,
): ImpactProjectionScene
{
  const nodesById = new Map(projection.nodes.map((node) => [node.id, node] as const))
  const edgesById = new Map(projection.edges.map((edge) => [edge.id, edge] as const))
  return {
    nodes: projection.nodes.map(sceneNode),
    edges: projection.edges.map((edge) => sceneEdge(edge, nodesById)),
    nodesById,
    edgesById,
  }
}
