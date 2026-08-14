// packages/cartographer-core/src/analyze/moves.ts
// pair removed/added nodes into moves & aggregate dir-level flows

import type { CartographerGraph } from '../contracts/types.js'

// structural subset -> callers with partial payloads qualify
export type MoveGraphSlice = Pick<CartographerGraph, 'nodes' | 'edges'>

export interface MovedNode
{
  from: string
  to: string
}

export interface MoveFlow
{
  from: string
  to: string
  count: number
}

export interface MovePairing
{
  moved: MovedNode[]
  moveMap: Map<string, string>
}

// keep in sync w/ web/shared/lib/pathKeys.ts dirKeyOf
export function dirKeyOf(id: string): string
{
  const i = id.lastIndexOf('/')
  return i > 0 ? id.slice(0, i) : '.'
}

function basenameOf(id: string): string
{
  return id.slice(id.lastIndexOf('/') + 1)
}

// count of equal trailing path segments; >= 1 whenever basenames match
function suffixScore(a: string, b: string): number
{
  const as = a.split('/')
  const bs = b.split('/')
  let n = 0
  while (n < as.length && n < bs.length && as[as.length - 1 - n] === bs[bs.length - 1 - n])
  {
    n += 1
  }
  return n
}

// neighbors of each candidate id, restricted to the stable anchor set
function stableNeighbors(
  edges: MoveGraphSlice['edges'],
  candidates: Set<string>,
  stable: Set<string>,
): Map<string, Set<string>>
{
  const neighbors = new Map<string, Set<string>>()
  const add = (id: string, other: string): void =>
  {
    if (!candidates.has(id) || !stable.has(other))
    {
      return
    }
    let set = neighbors.get(id)
    if (!set)
    {
      set = new Set<string>()
      neighbors.set(id, set)
    }
    set.add(other)
  }
  for (const edge of edges)
  {
    add(edge.from, edge.to)
    add(edge.to, edge.from)
  }
  return neighbors
}

function overlap(a: Set<string> | undefined, b: Set<string> | undefined): number
{
  if (!a || !b)
  {
    return 0
  }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let n = 0
  for (const id of small)
  {
    if (large.has(id))
    {
      n += 1
    }
  }
  return n
}

function groupByBasename(ids: readonly string[]): Map<string, string[]>
{
  const groups = new Map<string, string[]>()
  for (const id of ids)
  {
    const key = basenameOf(id)
    const group = groups.get(key)
    if (group)
    {
      group.push(id)
    }
    else
    {
      groups.set(key, [id])
    }
  }
  return groups
}

// v1 pairing: basename-equal candidates scored by shared stable neighbors,
// then trailing-path agreement; greedy best-first, deterministic order.
// gate: neighbor evidence or a matching parent dir -> refuse coincidences
export function pairMoves(
  base: MoveGraphSlice,
  head: MoveGraphSlice,
  removedNodes: readonly string[],
  addedNodes: readonly string[],
): MovePairing
{
  const baseIds = new Set(base.nodes.map((n) => n.id))
  const stable = new Set(head.nodes.map((n) => n.id).filter((id) => baseIds.has(id)))
  const removedSet = new Set(removedNodes)
  const addedSet = new Set(addedNodes)
  const removedNeighbors = stableNeighbors(base.edges, removedSet, stable)
  const addedNeighbors = stableNeighbors(head.edges, addedSet, stable)

  const removedByBase = groupByBasename(removedNodes)
  const addedByBase = groupByBasename(addedNodes)
  const moved: MovedNode[] = []

  for (const basename of [...removedByBase.keys()].sort((a, b) => a.localeCompare(b)))
  {
    const removed = removedByBase.get(basename)!
    const added = addedByBase.get(basename)
    if (!added)
    {
      continue
    }
    const candidates: Array<{ r: string; a: string; n: number; s: number }> = []
    for (const r of removed)
    {
      for (const a of added)
      {
        const n = overlap(removedNeighbors.get(r), addedNeighbors.get(a))
        const s = suffixScore(r, a)
        if (n >= 1 || s >= 2)
        {
          candidates.push({ r, a, n, s })
        }
      }
    }
    candidates.sort(
      (x, y) => y.n - x.n || y.s - x.s || x.r.localeCompare(y.r) || x.a.localeCompare(y.a),
    )
    const assignedR = new Set<string>()
    const assignedA = new Set<string>()
    for (const c of candidates)
    {
      if (!assignedR.has(c.r) && !assignedA.has(c.a))
      {
        assignedR.add(c.r)
        assignedA.add(c.a)
        moved.push({ from: c.r, to: c.a })
      }
    }
  }

  moved.sort((a, b) => a.from.localeCompare(b.from))
  return { moved, moveMap: new Map(moved.map((m) => [m.from, m.to])) }
}

// dir-level flow rollup over ALL moves; counts stay exact under list caps
export function aggregateMoveFlows(moved: readonly MovedNode[]): MoveFlow[]
{
  const counts = new Map<string, Map<string, number>>()
  for (const move of moved)
  {
    const from = dirKeyOf(move.from)
    const to = dirKeyOf(move.to)
    let row = counts.get(from)
    if (!row)
    {
      row = new Map<string, number>()
      counts.set(from, row)
    }
    row.set(to, (row.get(to) ?? 0) + 1)
  }
  const flows: MoveFlow[] = []
  for (const [from, row] of counts)
  {
    for (const [to, count] of row)
    {
      flows.push({ from, to, count })
    }
  }
  return flows.sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
}
