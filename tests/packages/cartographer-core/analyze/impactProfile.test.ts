// tests/packages/cartographer-core/analyze/impactProfile.test.ts
// deterministic bounded dependency impact over reusable graph relationships

import { describe, expect, it } from 'vite-plus/test'

import { computeBlastRadius } from '../../../../packages/cartographer-core/src/analyze/blast-radius.ts'
import {
  createGraphRelationIndex,
  type GraphRelationIndex,
} from '../../../../packages/cartographer-core/src/analyze/graphRelations.ts'
import {
  computeImpactProfile,
  type ImpactProfile,
} from '../../../../packages/cartographer-core/src/analyze/impactProfile.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
  type GraphEdge,
  type GraphNode,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'

function graph(nodes: GraphNode[], edges: GraphEdge[]): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/repo',
    mode: 'imports',
    generatedAt: '2026-08-07T00:00:00.000Z',
    scope: 'src',
    nodes,
    edges,
    groups: [],
    metrics: { cycles: 0, orphans: 0, maxFanIn: 0, maxFanOut: 0 },
  }
}

function node(id: string, exports?: string[]): GraphNode
{
  return {
    id,
    kind: 'file',
    label: id,
    group: 'src',
    ...(exports ? { exports: exports.map((name) => ({ name })) } : {}),
  }
}

function edge(id: string, from: string, to: string, symbols?: string[]): GraphEdge
{
  return {
    id,
    from,
    to,
    kind: 'imports',
    ...(symbols ? { symbols } : {}),
  }
}

function impact(index: GraphRelationIndex, target = 'target.ts'): ImpactProfile
{
  return computeImpactProfile(index, {
    target,
    direction: 'both',
    maxDepth: 4,
    limitPerDirection: 400,
  })
}

describe('graph relation index', () =>
{
  it('deduplicates and sorts adjacency independently of edge order', () =>
  {
    const nodes = ['target.ts', 'up/a.ts', 'up/b.ts', 'down/a.ts', 'down/b.ts'].map((id) =>
      node(id),
    )
    const edges = [
      edge('e4', 'target.ts', 'down/b.ts'),
      edge('e2', 'up/b.ts', 'target.ts'),
      edge('e5', 'target.ts', 'down/a.ts'),
      edge('duplicate', 'up/b.ts', 'target.ts'),
      edge('e1', 'up/a.ts', 'target.ts'),
    ]
    const forward = createGraphRelationIndex(graph(nodes, edges))
    const reverse = createGraphRelationIndex(graph(nodes, edges.toReversed()))

    expect(forward.importsOf.get('target.ts')).toEqual(['down/a.ts', 'down/b.ts'])
    expect(forward.importedBy.get('target.ts')).toEqual(['up/a.ts', 'up/b.ts'])
    expect(forward.incomingEdges.get('target.ts')?.map((item) => item.from)).toEqual([
      'up/a.ts',
      'up/b.ts',
    ])
    expect(forward.incomingEdges.get('target.ts')?.map((item) => item.id)).toEqual([
      'e1',
      'duplicate',
    ])
    expect(reverse.incomingEdges.get('target.ts')?.map((item) => item.id)).toEqual([
      'e1',
      'duplicate',
    ])
    expect(impact(forward)).toEqual(impact(reverse))
  })
})

describe('computeImpactProfile', () =>
{
  it('truncates each direction while retaining exact totals and unique impact', () =>
  {
    const ids = [
      'target.ts',
      'up/a.ts',
      'up/b.ts',
      'up/c.ts',
      'down/a.ts',
      'down/b.ts',
      'down/c.ts',
      'shared.ts',
    ]
    const index = createGraphRelationIndex(
      graph(
        ids.map((id) => node(id)),
        [
          edge('u1', 'up/a.ts', 'target.ts'),
          edge('u2', 'up/b.ts', 'target.ts'),
          edge('u3', 'up/c.ts', 'target.ts'),
          edge('us', 'shared.ts', 'up/a.ts'),
          edge('d1', 'target.ts', 'down/a.ts'),
          edge('d2', 'target.ts', 'down/b.ts'),
          edge('d3', 'target.ts', 'down/c.ts'),
          edge('ds', 'target.ts', 'shared.ts'),
        ],
      ),
    )

    const result = computeImpactProfile(index, {
      target: 'target.ts',
      direction: 'both',
      maxDepth: 4,
      limitPerDirection: 2,
    })

    expect(result.upstream).toEqual({ items: ['shared.ts', 'up/a.ts'], total: 4, omitted: 2 })
    expect(result.downstream).toEqual({ items: ['down/a.ts', 'down/b.ts'], total: 5, omitted: 3 })
    expect(result.impactedFileCount).toBe(7)
  })

  it('filters only the symbol first hop before continuing at file precision', () =>
  {
    const sourceGraph = graph(
      [
        node('provider.ts', ['keep', 'other']),
        node('consumer.ts'),
        node('other-consumer.ts'),
        node('namespace-consumer.ts'),
        node('ripple.ts'),
        node('excluded-ripple.ts'),
        node('dependency.ts'),
      ],
      [
        edge('keep', 'consumer.ts', 'provider.ts', ['keep']),
        edge('other', 'other-consumer.ts', 'provider.ts', ['other']),
        edge('namespace', 'namespace-consumer.ts', 'provider.ts'),
        edge('ripple', 'ripple.ts', 'consumer.ts'),
        edge('excluded-ripple', 'excluded-ripple.ts', 'other-consumer.ts'),
        edge('dependency', 'provider.ts', 'dependency.ts'),
      ],
    )
    const index = createGraphRelationIndex(sourceGraph)

    const result = computeImpactProfile(index, {
      target: 'provider.ts#keep',
      direction: 'both',
      maxDepth: 2,
      limitPerDirection: 400,
    })

    expect(result.precision).toBe('symbol-first-hop')
    expect(result.upstream).toEqual({
      items: ['consumer.ts', 'namespace-consumer.ts', 'ripple.ts'],
      total: 3,
      omitted: 0,
    })
    expect(result.downstream).toEqual({ items: ['dependency.ts'], total: 1, omitted: 0 })
    expect(result.impactedFileCount).toBe(4)
    expect(computeBlastRadius(sourceGraph, 'provider.ts#keep', 'both', 2)).toEqual({
      target: result.target,
      symbol: result.symbol,
      precision: result.precision,
      direction: result.direction,
      maxDepth: result.maxDepth,
      upstream: result.upstream.items,
      downstream: result.downstream.items,
    })
    expect(() => computeBlastRadius(sourceGraph, 'missing.ts')).toThrowError(
      'target "missing.ts" not in graph',
    )
  })
})
