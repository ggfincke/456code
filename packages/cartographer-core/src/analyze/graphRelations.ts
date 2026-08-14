// packages/cartographer-core/src/analyze/graphRelations.ts
// precomputed deterministic graph relationships for repeated architecture queries

import type { CartographerGraph, GraphEdge, GraphNode } from '../contracts/types.js'

export interface GraphRelationIndex
{
  nodeById: ReadonlyMap<string, GraphNode>
  // files imported by each id
  importsOf: ReadonlyMap<string, readonly string[]>
  // files importing each id
  importedBy: ReadonlyMap<string, readonly string[]>
  // full edges are retained for symbol-first-hop filtering
  incomingEdges: ReadonlyMap<string, readonly GraphEdge[]>
}

function pushSet(map: Map<string, Set<string>>, key: string, value: string): void
{
  let values = map.get(key)
  if (!values)
  {
    values = new Set<string>()
    map.set(key, values)
  }
  values.add(value)
}

function edgeTraversalKey(edge: GraphEdge): string
{
  const symbols =
    edge.symbols === undefined
      ? 'unknown'
      : `listed:${JSON.stringify([...new Set(edge.symbols)].sort())}`
  return `${edge.from}\u0000${edge.to}\u0000${symbols}`
}

function compareText(left: string, right: string): number
{
  if (left < right)
  {
    return -1
  }
  return left > right ? 1 : 0
}

function pushIncoming(edgesByTarget: Map<string, Map<string, GraphEdge>>, edge: GraphEdge): void
{
  let edges = edgesByTarget.get(edge.to)
  if (!edges)
  {
    edges = new Map<string, GraphEdge>()
    edgesByTarget.set(edge.to, edges)
  }
  const key = edgeTraversalKey(edge)
  const current = edges.get(key)
  if (!current || compareText(edge.id, current.id) < 0)
  {
    edges.set(key, edge)
  }
}

function sortedAdjacency(source: Map<string, Set<string>>): Map<string, readonly string[]>
{
  return new Map(
    [...source]
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, values]) => [id, [...values].sort()]),
  )
}

export function createGraphRelationIndex(graph: CartographerGraph): GraphRelationIndex
{
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const upstream = new Map<string, Set<string>>()
  const downstream = new Map<string, Set<string>>()
  const incoming = new Map<string, Map<string, GraphEdge>>()

  for (const edge of graph.edges)
  {
    pushSet(downstream, edge.from, edge.to)
    pushSet(upstream, edge.to, edge.from)
    pushIncoming(incoming, edge)
  }

  return {
    nodeById,
    importsOf: sortedAdjacency(downstream),
    importedBy: sortedAdjacency(upstream),
    incomingEdges: new Map(
      [...incoming]
        .sort(([left], [right]) => compareText(left, right))
        .map(([id, edges]) => [
          id,
          [...edges].sort(([left], [right]) => compareText(left, right)).map(([, edge]) => edge),
        ]),
    ),
  }
}
