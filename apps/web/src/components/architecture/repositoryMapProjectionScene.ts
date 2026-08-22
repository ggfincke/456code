// apps/web/src/components/architecture/repositoryMapProjectionScene.ts
// adapts one standing projection into Repository Map canvas presentation records

import type {
  ArchitectureGraphProjection,
  ArchitectureGraphProjectionEdge,
  ArchitectureGraphProjectionNode,
} from '@t3tools/contracts'

import type {
  ArchitectureGraphCanvasEdge,
  ArchitectureGraphCanvasNode,
} from './ArchitectureGraphCanvas'

export interface RepositoryMapProjectionScene
{
  readonly nodes: readonly ArchitectureGraphCanvasNode[]
  readonly edges: readonly ArchitectureGraphCanvasEdge[]
  readonly nodesById: ReadonlyMap<string, ArchitectureGraphProjectionNode>
  readonly edgesById: ReadonlyMap<string, ArchitectureGraphProjectionEdge>
}

function levelLabel(level: ArchitectureGraphProjectionNode['semanticLevel']): string
{
  switch (level)
  {
    case 'systems':
      return 'System'
    case 'blocks':
      return 'Block'
    case 'dirs':
      return 'Directory'
    case 'files':
      return 'File'
  }
}

function sceneNode(node: ArchitectureGraphProjectionNode): ArchitectureGraphCanvasNode
{
  const kind = levelLabel(node.semanticLevel)
  return {
    id: node.id,
    label: node.label,
    description: node.relativePath ?? `${kind} membership`,
    badgeLabel: kind,
    footerLabels: [
      `${node.fileCount.toLocaleString()} ${node.fileCount === 1 ? 'file' : 'files'}`,
      `in ${node.inbound.toLocaleString()}`,
      `out ${node.outbound.toLocaleString()}`,
    ],
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    position: node.position,
    tintKey: node.tintKey,
    tone: 'identity',
    stroke: 'solid',
    ariaLabel: `${node.label}, ${kind.toLowerCase()}, ${node.fileCount.toLocaleString()} files, ${node.inbound.toLocaleString()} incoming, ${node.outbound.toLocaleString()} outgoing`,
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
    label: edge.relationshipKind,
    tone: 'identity',
    stroke: 'solid',
    showBadge: false,
    ariaLabel: `Inspect ${edge.relationshipKind} relationship from ${from} to ${to}, weight ${edge.weight.toLocaleString()}`,
  }
}

export function createRepositoryMapProjectionScene(
  projection: ArchitectureGraphProjection,
): RepositoryMapProjectionScene
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
