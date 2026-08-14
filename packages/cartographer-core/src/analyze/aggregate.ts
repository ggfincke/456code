// packages/cartographer-core/src/analyze/aggregate.ts
// fold file-level graph into group-level nodes & edges

import type { CartographerGraph, GraphGroup } from '../contracts/types.js'

// structural subset shared by backend & web graph consumers
export type GraphSlice = Pick<CartographerGraph, 'nodes' | 'edges' | 'groups'>

export interface GroupEdge
{
  from: string
  to: string
  count: number
}

// graph groups in analyzer order
export function graphGroups(graph: GraphSlice): GraphGroup[]
{
  return graph.groups
}

// cross-group import counts, heaviest first; intra-group edges dropped
export function aggregateGroupEdges(graph: GraphSlice): GroupEdge[]
{
  const groupOf = new Map(graph.nodes.map((n) => [n.id, n.group]))
  const counts = new Map<string, Map<string, number>>()
  for (const edge of graph.edges)
  {
    const from = groupOf.get(edge.from)
    const to = groupOf.get(edge.to)
    if (!from || !to || from === to)
    {
      continue
    }
    let row = counts.get(from)
    if (!row)
    {
      row = new Map<string, number>()
      counts.set(from, row)
    }
    row.set(to, (row.get(to) ?? 0) + 1)
  }
  const edges: GroupEdge[] = []
  for (const [from, row] of counts)
  {
    for (const [to, count] of row)
    {
      edges.push({ from, to, count })
    }
  }
  return edges.sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
}
