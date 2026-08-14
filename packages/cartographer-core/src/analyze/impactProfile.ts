// packages/cartographer-core/src/analyze/impactProfile.ts
// bounded dependency impact queries over a precomputed relationship index

import type { GraphEdge, GraphNode } from '../contracts/types.js'
import type { GraphRelationIndex } from './graphRelations.js'

export type BlastDirection = 'upstream' | 'downstream' | 'both'

export interface BoundedImpactItems
{
  items: string[]
  total: number
  omitted: number
}

export interface ImpactProfileInput
{
  target: string
  direction?: BlastDirection
  maxDepth?: number
  limitPerDirection: number
}

export interface ImpactProfile
{
  target: string
  symbol?: string
  // symbol targets filter the first upstream hop; deeper hops stay file-level
  precision: 'file' | 'symbol-first-hop'
  direction: BlastDirection
  maxDepth: number
  upstream: BoundedImpactItems
  downstream: BoundedImpactItems
  // unique files across the complete, untruncated directions
  impactedFileCount: number
}

export const DEFAULT_MAX_DEPTH = 4

export class ImpactTargetError extends Error
{
  readonly code = 'IMPACT_TARGET_NOT_FOUND'
}

type TargetNode = Pick<GraphNode, 'id' | 'exports'>

function findTarget(index: GraphRelationIndex, target: string): TargetNode
{
  const found = index.nodeById.get(target)
  if (found)
  {
    return found
  }
  const hint = [...index.nodeById.keys()]
    .filter((id) => id.endsWith(target) || id.includes(target))
    .slice(0, 5)
  throw new ImpactTargetError(
    `target "${target}" not in graph${hint.length > 0 ? ` -> did you mean: ${hint.join(', ')}` : ''}`,
  )
}

function validateSymbol(node: TargetNode, target: string, symbol: string): void
{
  if (!node.exports)
  {
    throw new ImpactTargetError(
      `graph has no symbol data for "${target}" -> rebuild w/ \`cartographer build\``,
    )
  }
  if (node.exports.some((entry) => entry.name === symbol))
  {
    return
  }
  const hint = node.exports
    .filter((entry) => entry.name.toLowerCase().includes(symbol.toLowerCase()))
    .slice(0, 5)
    .map((entry) => entry.name)
  throw new ImpactTargetError(
    `"${symbol}" is not exported by ${target}${hint.length > 0 ? ` -> did you mean: ${hint.join(', ')}` : ''}`,
  )
}

function edgePullsSymbol(edge: GraphEdge, symbol: string): boolean
{
  return edge.symbols === undefined || edge.symbols.includes(symbol)
}

// collect nodes newly discovered from the frontier; seen entries are excluded
function bfs(
  adjacency: ReadonlyMap<string, readonly string[]>,
  frontier: string[],
  maxDepth: number,
  seen: Set<string>,
): string[]
{
  const result: string[] = []
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1)
  {
    const next: string[] = []
    for (const id of frontier)
    {
      for (const neighbor of adjacency.get(id) ?? [])
      {
        if (!seen.has(neighbor))
        {
          seen.add(neighbor)
          result.push(neighbor)
          next.push(neighbor)
        }
      }
    }
    frontier = next
  }
  return result.sort()
}

function symbolUpstream(
  index: GraphRelationIndex,
  target: string,
  symbol: string,
  maxDepth: number,
): string[]
{
  const seeds = new Set<string>()
  for (const edge of index.incomingEdges.get(target) ?? [])
  {
    if (edgePullsSymbol(edge, symbol))
    {
      seeds.add(edge.from)
    }
  }
  const orderedSeeds = [...seeds].sort()
  const ripple = bfs(
    index.importedBy,
    orderedSeeds,
    maxDepth - 1,
    new Set([target, ...orderedSeeds]),
  )
  return [...orderedSeeds, ...ripple].sort()
}

function bound(items: string[], limit: number): BoundedImpactItems
{
  return {
    items: items.slice(0, limit),
    total: items.length,
    omitted: Math.max(0, items.length - limit),
  }
}

export function computeImpactProfile(
  index: GraphRelationIndex,
  input: ImpactProfileInput,
): ImpactProfile
{
  if (!Number.isSafeInteger(input.limitPerDirection) || input.limitPerDirection < 0)
  {
    throw new RangeError('limitPerDirection must be a non-negative safe integer')
  }

  const direction = input.direction ?? 'both'
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH
  const hashIndex = input.target.indexOf('#')
  const target = hashIndex === -1 ? input.target : input.target.slice(0, hashIndex)
  const symbol = hashIndex === -1 ? undefined : input.target.slice(hashIndex + 1)
  const node = findTarget(index, target)
  if (symbol !== undefined)
  {
    validateSymbol(node, target, symbol)
  }

  let upstream: string[] = []
  if (direction !== 'downstream')
  {
    upstream =
      symbol === undefined
        ? bfs(index.importedBy, [target], maxDepth, new Set([target]))
        : symbolUpstream(index, target, symbol, maxDepth)
  }
  const downstream =
    direction === 'upstream' ? [] : bfs(index.importsOf, [target], maxDepth, new Set([target]))

  return {
    target,
    ...(symbol !== undefined ? { symbol } : {}),
    precision: symbol === undefined ? 'file' : 'symbol-first-hop',
    direction,
    maxDepth,
    upstream: bound(upstream, input.limitPerDirection),
    downstream: bound(downstream, input.limitPerDirection),
    impactedFileCount: new Set([...upstream, ...downstream]).size,
  }
}
