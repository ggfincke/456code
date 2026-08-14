// packages/cartographer-core/src/analyze/journeyHops.ts
// shortest static-import path between two journey stop file sets

// hops past this depth stop being a legible narrative claim -> report none
export const JOURNEY_HOP_MAX_DEPTH = 12

export interface JourneyHop
{
  // edges traversed from the source file to the target file
  distance: number
  // full path incl. both endpoints
  via: string[]
}

export interface JourneyHopSearch
{
  hop?: JourneyHop
  // true -> unexplored edges remain beyond the configured search depth
  depthExceeded: boolean
}

// BFS from any source to the nearest target, carrying parentOf for path
// reconstruction; neighbor iteration is sorted so equal-length paths pick
// the same witness on every build
export function findHop(
  adjacency: Map<string, string[]>,
  fromIds: string[],
  toIds: Set<string>,
  maxDepth: number,
): JourneyHopSearch
{
  const sources = [...fromIds].sort()
  for (const source of sources)
  {
    if (toIds.has(source))
    {
      // a stop resolving onto the previous stop's own file is a zero-hop step
      return { hop: { distance: 0, via: [source] }, depthExceeded: false }
    }
  }
  const parent = new Map<string, string>()
  const depth = new Map<string, number>()
  const queue: string[] = []
  for (const source of sources)
  {
    if (!depth.has(source))
    {
      depth.set(source, 0)
      queue.push(source)
    }
  }
  let cursor = 0
  let depthExceeded = false
  while (cursor < queue.length)
  {
    const current = queue[cursor]!
    cursor += 1
    const currentDepth = depth.get(current)!
    if (currentDepth >= maxDepth)
    {
      if ((adjacency.get(current) ?? []).some((next) => !depth.has(next)))
      {
        depthExceeded = true
      }
      continue
    }
    for (const next of [...(adjacency.get(current) ?? [])].sort())
    {
      if (depth.has(next))
      {
        continue
      }
      depth.set(next, currentDepth + 1)
      parent.set(next, current)
      if (toIds.has(next))
      {
        return {
          hop: {
            distance: currentDepth + 1,
            via: reconstruct(parent, next, maxDepth),
          },
          depthExceeded: false,
        }
      }
      queue.push(next)
    }
  }
  return { depthExceeded }
}

// walk parentOf back to the seeded source, then flip to source -> target order
function reconstruct(parent: Map<string, string>, target: string, maxDepth: number): string[]
{
  const path = [target]
  let step = parent.get(target)
  while (step !== undefined && path.length <= maxDepth + 1)
  {
    path.push(step)
    step = parent.get(step)
  }
  return path.reverse()
}
