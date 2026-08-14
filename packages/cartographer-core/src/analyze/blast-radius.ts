// packages/cartographer-core/src/analyze/blast-radius.ts
// bfs traversal of impacted files from a target file or exported symbol

import type { CartographerGraph } from '../contracts/types.js'
import { createGraphRelationIndex } from './graphRelations.js'
import { computeImpactProfile, DEFAULT_MAX_DEPTH, type BlastDirection } from './impactProfile.js'

export { DEFAULT_MAX_DEPTH, type BlastDirection } from './impactProfile.js'

export interface BlastRadiusResult
{
  target: string
  symbol?: string
  // symbol targets filter the first upstream hop; deeper hops stay file-level
  precision: 'file' | 'symbol-first-hop'
  direction: BlastDirection
  maxDepth: number
  // files that import the target (directly or transitively)
  upstream: string[]
  // files the target imports (directly or transitively)
  downstream: string[]
}

export function impactedFileCount(result: BlastRadiusResult): number
{
  return new Set([...result.upstream, ...result.downstream]).size
}

export function computeBlastRadius(
  graph: CartographerGraph,
  rawTarget: string,
  direction: BlastDirection = 'both',
  maxDepth: number = DEFAULT_MAX_DEPTH,
): BlastRadiusResult
{
  const profile = computeImpactProfile(createGraphRelationIndex(graph), {
    target: rawTarget,
    direction,
    maxDepth,
    limitPerDirection: Number.MAX_SAFE_INTEGER,
  })
  return {
    target: profile.target,
    ...(profile.symbol !== undefined ? { symbol: profile.symbol } : {}),
    precision: profile.precision,
    direction,
    maxDepth,
    upstream: profile.upstream.items,
    downstream: profile.downstream.items,
  }
}
