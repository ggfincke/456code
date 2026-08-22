// tests/packages/cartographer-core/store/atlasIndex/build.test.ts
// verifies v6 structure, crosswalks, deterministic omissions & strict reads

import { describe, expect, it } from 'vite-plus/test'

import { parseAtlasIndex } from '../../../../../packages/cartographer-core/src/contracts/atlasIndexCodec.ts'
import {
  ATLAS_INDEX_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
  type GraphEdge,
  type GraphGroup,
  type GraphNode,
  type GraphRule,
} from '../../../../../packages/cartographer-core/src/contracts/types.ts'
import { buildAtlasIndex } from '../../../../../packages/cartographer-core/src/store/atlasIndex/build.ts'

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}` as const

function padded(value: number): string
{
  return value.toString().padStart(4, '0')
}

function systemSlice(
  system: 'system-a' | 'system-b',
  count: number,
): { readonly nodes: GraphNode[]; readonly groups: GraphGroup[]; readonly edges: GraphEdge[] }
{
  const prefix = system === 'system-a' ? 'a' : 'b'
  const nodes = Array.from({ length: count }, (_, index): GraphNode =>
  {
    const block = `${prefix}/block-${padded(index)}`
    return {
      id: `src/${block}/file.ts`,
      kind: 'file',
      label: `file-${padded(index)}.ts`,
      group: block,
      system,
    }
  })
  const groups = nodes.map((node): GraphGroup => ({
    id: node.group,
    label: node.group,
    fileCount: 1,
  }))
  const edges = nodes.slice(1).map((node, index): GraphEdge => ({
    id: `${prefix}-edge-${padded(index)}`,
    from: nodes[index]!.id,
    to: node.id,
    kind: 'imports',
    ...(index === 0
      ? { violations: system === 'system-a' ? ['rule-a'] : ['rule-a', 'rule-b'] }
      : {}),
  }))
  return { nodes, groups, edges }
}

function rule(id: string): GraphRule
{
  return {
    id,
    from: 'system-a',
    to: 'system-b',
    verdict: 'forbid',
    severity: 'error',
  }
}

function overCapGraph(reverse = false): CartographerGraph
{
  // 2,002 blocks exceed the 2,000-block index cap. Matching chains keep the
  // ranking deterministic while system-b loses two endpoint blocks.
  const systemA = systemSlice('system-a', 1_002)
  const systemB = systemSlice('system-b', 1_000)
  const ordered = <A>(values: A[]): A[] =>
    reverse ? values.map((_, index) => values[values.length - index - 1]!) : values
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/repo',
    mode: 'imports',
    generatedAt: '2026-08-09T00:00:00.000Z',
    gitRef: '1'.repeat(40),
    scope: '.',
    nodes: ordered([...systemA.nodes, ...systemB.nodes]),
    edges: ordered([...systemA.edges, ...systemB.edges]),
    groups: ordered([...systemA.groups, ...systemB.groups]),
    systems: ordered([
      {
        id: 'system-a',
        label: 'System A',
        fileCount: systemA.nodes.length,
        source: 'authored',
      },
      {
        id: 'system-b',
        label: 'System B',
        fileCount: systemB.nodes.length,
        source: 'authored',
      },
    ]),
    rules: [rule('rule-a'), rule('rule-b'), rule('rule-unused')],
    metrics: { cycles: 7, orphans: 9, maxFanIn: 1, maxFanOut: 1 },
  }
}

function structureGraph(): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/repo',
    mode: 'imports',
    generatedAt: '2026-08-20T12:00:00.000Z',
    gitRef: '2'.repeat(40),
    scope: '.',
    nodes: [
      {
        id: 'src/api/index.ts',
        kind: 'file',
        label: 'index.ts',
        group: 'shared',
        system: 'system-a',
      },
      {
        id: 'src/worker/index.ts',
        kind: 'file',
        label: 'index.ts',
        group: 'shared',
        system: 'system-a',
      },
      {
        id: 'src/worker/nested/job.ts',
        kind: 'file',
        label: 'job.ts',
        group: 'worker',
        system: 'system-b',
      },
    ],
    edges: [
      {
        id: 'api-worker',
        from: 'src/api/index.ts',
        to: 'src/worker/index.ts',
        kind: 'imports',
      },
      {
        id: 'worker-job',
        from: 'src/worker/index.ts',
        to: 'src/worker/nested/job.ts',
        kind: 'imports',
      },
    ],
    groups: [
      { id: 'shared', label: 'Shared', fileCount: 2 },
      { id: 'worker', label: 'Worker', fileCount: 1 },
    ],
    systems: [
      { id: 'system-a', label: 'System A', fileCount: 2, source: 'authored' },
      { id: 'system-b', label: 'System B', fileCount: 1, source: 'authored' },
    ],
    metrics: { cycles: 0, orphans: 0, maxFanIn: 1, maxFanOut: 1 },
  }
}

describe('buildAtlasIndex v6', () =>
{
  it('retains exact per-parent omissions and objective health deterministically', () =>
  {
    const index = buildAtlasIndex(overCapGraph(), SOURCE_DIGEST)
    const reordered = buildAtlasIndex(overCapGraph(true), SOURCE_DIGEST)
    const systemB = index.scopes.find((scope) => scope.parent === 'systems:system-b')

    expect(index).toEqual(reordered)
    expect(index.counts).toMatchObject({
      blocks: 2_002,
      indexedBlocks: 2_000,
    })
    expect(systemB).toEqual({
      parent: 'systems:system-b',
      childLevel: 'blocks',
      children: { total: 1_000, indexed: 998, omitted: 2 },
      edges: { total: 999, indexed: 997, omitted: 2 },
    })
    expect(index.health).toEqual({
      cycles: 7,
      orphans: 9,
      violatingImports: 2,
      violatedRules: 2,
      ruleTotal: 3,
    })
    expect(parseAtlasIndex(index)).toEqual(index)
  })

  it('builds nested Structure scopes and explicit architecture crosswalk ambiguity', () =>
  {
    const index = buildAtlasIndex(structureGraph(), SOURCE_DIGEST)
    if (index.version !== ATLAS_INDEX_SCHEMA_VERSION)
    {
      throw new Error('expected a current atlas index')
    }

    expect(index.structure).toMatchObject({
      rootId: 'dirs:.',
      counts: { directories: 5, files: 3, edges: 2, fileEdges: 2 },
    })
    expect(index.structure.directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'dirs:.',
          childDirectoryIds: ['dirs:src'],
          descendantFileCount: 3,
        }),
        expect.objectContaining({
          id: 'dirs:src/worker',
          childDirectoryIds: ['dirs:src/worker/nested'],
          directFileIds: ['src/worker/index.ts'],
          descendantFileCount: 2,
        }),
      ]),
    )
    expect(index.structure.edges).toEqual([
      { parent: 'dirs:src', from: 'dirs:src/api', to: 'dirs:src/worker', weight: 1 },
      {
        parent: 'dirs:src/worker',
        from: 'src/worker/index.ts',
        to: 'dirs:src/worker/nested',
        weight: 1,
      },
    ])
    expect(index.crosswalks.blocksToDirectories).toContainEqual({
      sourceId: 'blocks:shared',
      targetIds: ['dirs:src/api', 'dirs:src/worker'],
      matchedFileCount: 1,
      status: 'ambiguous',
    })

    expect(() => parseAtlasIndex({ ...index, version: 5 })).toThrow(
      'atlas index has an invalid schema',
    )
  })

  it('validates mixed-case directory paths with the builder canonical ordering', () =>
  {
    const source = structureGraph()
    const ids = new Map([
      ['src/api/index.ts', 'Apps/api/index.ts'],
      ['src/worker/index.ts', 'apps/worker/index.ts'],
      ['src/worker/nested/job.ts', 'src/worker/nested/job.ts'],
    ])
    const graph: CartographerGraph = {
      ...source,
      nodes: source.nodes.map((node) => ({ ...node, id: ids.get(node.id)! })),
      edges: source.edges.map((edge) => ({
        ...edge,
        from: ids.get(edge.from)!,
        to: ids.get(edge.to)!,
      })),
    }

    const index = buildAtlasIndex(graph, SOURCE_DIGEST)
    if (index.version !== ATLAS_INDEX_SCHEMA_VERSION)
    {
      throw new Error('expected a current atlas index')
    }

    expect(
      index.structure.directories
        .filter((directory) => directory.depth === 1)
        .map((directory) => directory.key),
    ).toEqual(['Apps', 'apps', 'src'])
    expect(parseAtlasIndex(index)).toEqual(index)
  })

  it('rejects false scope counts and impossible violated-rule totals', () =>
  {
    const index = buildAtlasIndex(overCapGraph(), SOURCE_DIGEST)
    const falseScope = structuredClone(index)
    const scope = falseScope.scopes.find((entry) => entry.parent === 'systems:system-b')
    if (!scope)
    {
      throw new Error('expected system-b scope')
    }
    scope.children.indexed += 1
    scope.children.total += 1

    const falseHealth = structuredClone(index)
    falseHealth.health.violatedRules = falseHealth.health.ruleTotal + 1

    expect(() => parseAtlasIndex(falseScope)).toThrow('atlas index has an invalid schema')
    expect(() => parseAtlasIndex(falseHealth)).toThrow('atlas index has an invalid schema')
  })
})
