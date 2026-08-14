// packages/cartographer-core/src/analyze/edgeIdentity.ts
// structural identity, ordering, and display for edge endpoints

export interface EdgeEndpoints
{
  from: string
  to: string
}

// tuple JSON stays injective for arbitrary path strings
export function edgeIdentityKey(edge: EdgeEndpoints): string
{
  return JSON.stringify([edge.from, edge.to])
}

export function compareEdgeEndpoints(a: EdgeEndpoints, b: EdgeEndpoints): number
{
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
}

export function formatEdgeEndpoints(edge: EdgeEndpoints): string
{
  return `${edge.from} -> ${edge.to}`
}
