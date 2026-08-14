// tests/packages/cartographer-core/store/atlasIndexPersistence.test.ts
// generation-safe atlas index persistence, validation & hierarchy

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vite-plus/test'
import {
  parseAtlasIndexFilePage,
  parseAtlasIndexSummary,
} from '../../../../packages/cartographer-core/src/contracts/atlasIndexCodec.ts'
import { buildAtlasIndex } from '../../../../packages/cartographer-core/src/store/atlasIndex/build.ts'
import { graphContentDigest } from '../../../../packages/cartographer-core/src/store/atlasIndex/digest.ts'
import { saveGraph } from '../../../../packages/cartographer-core/src/store/index.ts'
import {
  atlasIndexSummary,
  ensureAtlasIndex,
} from '../../../../packages/cartographer-core/src/store/atlasIndex/persist.ts'
import {
  atlasIndexPath,
  graphJsonPath,
} from '../../../../packages/cartographer-core/src/store/paths.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type AtlasIndex,
  type CartographerGraph,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'
import { selectSystemHierarchy } from '../../../../packages/cartographer-core/src/analyze/systemHierarchy.ts'
import { trackedTempRoot } from '../helpers/trackedTempRoot.ts'

const tempRoots = trackedTempRoot('carto-tg5-')
const tempDir = tempRoots.create

afterAll(tempRoots.cleanup)

function makeGraph(generatedAt: string): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/tmp/fixture',
    mode: 'imports',
    generatedAt,
    scope: 'src',
    nodes: [
      { id: 'src/a.ts', kind: 'file', label: 'a.ts', group: 'src/core' },
      { id: 'src/b.ts', kind: 'file', label: 'b.ts', group: 'src/core' },
    ],
    edges: [{ id: 'e0', from: 'src/a.ts', to: 'src/b.ts', kind: 'imports' }],
    groups: [{ id: 'src/core', label: 'core', fileCount: 2 }],
    metrics: { cycles: 0, orphans: 0, maxFanIn: 1, maxFanOut: 1 },
  }
}

interface HierarchyFile
{
  id: string
  group: string
  system?: string
}

function hierarchyGraph(
  files: HierarchyFile[],
  systems?: CartographerGraph['systems'],
): CartographerGraph
{
  const groupCounts = new Map<string, number>()
  for (const file of files)
  {
    groupCounts.set(file.group, (groupCounts.get(file.group) ?? 0) + 1)
  }
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: '/tmp/hierarchy-fixture',
    mode: 'imports',
    generatedAt: '2026-07-10T00:00:00.000Z',
    scope: 'src',
    nodes: files.map((file) => ({
      id: file.id,
      kind: 'file',
      label: NodePath.basename(file.id),
      group: file.group,
      ...(file.system === undefined ? {} : { system: file.system }),
    })),
    edges: [],
    groups: [...groupCounts]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, fileCount]) => ({ id, label: id, fileCount })),
    ...(systems ? { systems } : {}),
    metrics: { cycles: 0, orphans: 0, maxFanIn: 0, maxFanOut: 0 },
  }
}

function referencedHierarchyGraph(): CartographerGraph
{
  const graph = hierarchyGraph([
    { id: 'packages/a/src/a.ts', group: 'packages/a' },
    { id: 'packages/a/src/b.ts', group: 'packages/a' },
    { id: 'packages/b/src/c.ts', group: 'packages/b' },
    { id: 'packages/b/src/d.ts', group: 'packages/b' },
  ])
  return {
    ...graph,
    edges: [
      {
        id: 'cross-system',
        from: 'packages/a/src/a.ts',
        to: 'packages/b/src/c.ts',
        kind: 'imports',
      },
    ],
    metrics: { cycles: 0, orphans: 2, maxFanIn: 1, maxFanOut: 1 },
  }
}

function buildIndex(graph: CartographerGraph, root = graph.repoRoot): AtlasIndex
{
  const graphBytes = `${JSON.stringify(graph, null, 2)}\n`
  return buildAtlasIndex(graph, graphContentDigest(graphBytes), root)
}

function expectSharedHierarchy(
  graph: CartographerGraph,
  source: 'authored' | 'inferred',
  expected: Record<string, string>,
): void
{
  const index = buildIndex(graph)
  const indexKeyById = new Map(
    index.units.systems.map((unit): [string, string] => [unit.id, unit.key]),
  )
  const coarse = Object.fromEntries(
    index.files.map((file) => [file.id, file.system ? indexKeyById.get(file.system) : undefined]),
  )
  const selected = selectSystemHierarchy(
    graph.nodes.map((node) => ({
      id: node.id,
      group: node.group,
      ...(node.system === undefined ? {} : { system: node.system }),
    })),
    graph.systems ?? [],
  )
  const analyzer = Object.fromEntries(selected.systemOfFile)
  const expectedKeys = [...new Set(Object.values(expected))].sort()

  expect(index.systemSource).toBe(source)
  expect(index.units.systems.map((unit) => unit.key).sort()).toEqual(expectedKeys)
  expect(selected.candidates.map((candidate) => candidate.key).sort()).toEqual(expectedKeys)
  expect(coarse).toEqual(expected)
  expect(analyzer).toEqual(expected)
}

interface GenerationPayload
{
  graph: string
  index: string
}

function generationPayload(root: string, generatedAt: string): GenerationPayload
{
  const graph = makeGraph(generatedAt)
  const graphBytes = `${JSON.stringify(graph, null, 2)}\n`
  return {
    graph: graphBytes,
    index: `${JSON.stringify(buildAtlasIndex(graph, graphContentDigest(graphBytes), root))}\n`,
  }
}

let artifactWrite = 0

function replaceArtifact(path: string, value: string): void
{
  artifactWrite += 1
  const temp = `${path}.${process.pid}.${artifactWrite}.race`
  NodeFS.writeFileSync(temp, value)
  NodeFS.renameSync(temp, path)
}

function publishGeneration(root: string, payload: GenerationPayload): void
{
  replaceArtifact(graphJsonPath(root), payload.graph)
  replaceArtifact(atlasIndexPath(root), payload.index)
}

describe('generation-safe validated index cache', () =>
{
  it('returns the same parsed index until the artifacts regenerate', () =>
  {
    const root = tempDir()
    saveGraph(makeGraph('2026-07-10T00:00:00.000Z'), root)
    const first = ensureAtlasIndex(root)
    const second = ensureAtlasIndex(root)
    // identical object -> no reparse/revalidation happened
    expect(second).toBe(first)

    // atomic regeneration swaps the cache to the new generation
    saveGraph(makeGraph('2026-07-10T01:00:00.000Z'), root)
    const third = ensureAtlasIndex(root)
    expect(third).not.toBe(first)
    expect(third.sourceGeneratedAt).toBe('2026-07-10T01:00:00.000Z')
    // & the new generation is itself cached
    expect(ensureAtlasIndex(root)).toBe(third)
  })

  it('does not bind an old index value to a newer artifact stamp pair', async () =>
  {
    const root = tempDir()
    const indexPath = atlasIndexPath(root)
    const next = generationPayload(root, '2026-07-10T01:00:00.000Z')
    saveGraph(makeGraph('2026-07-10T00:00:00.000Z'), root)

    let indexStats = 0
    let swapped = false
    vi.resetModules()
    vi.doMock('node:fs', async () =>
    {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        statSync: (...args: unknown[]): ReturnType<typeof NodeFS.statSync> =>
        {
          if (String(args[0]) === indexPath)
          {
            indexStats += 1
            if (indexStats === 2)
            {
              publishGeneration(root, next)
              swapped = true
            }
          }
          return Reflect.apply(actual.statSync, actual, args) as ReturnType<typeof NodeFS.statSync>
        },
      }
    })
    try
    {
      const persistence =
        await import('../../../../packages/cartographer-core/src/store/atlasIndex/persist.ts')
      const index = persistence.ensureAtlasIndex(root)
      expect(swapped).toBe(true)
      expect(index.sourceGeneratedAt).toBe('2026-07-10T01:00:00.000Z')
      expect(persistence.ensureAtlasIndex(root)).toBe(index)
    }
    finally
    {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('repairs a newer generation interrupted by a stale rebuild write', async () =>
  {
    const root = tempDir()
    const indexPath = atlasIndexPath(root)
    const next = generationPayload(root, '2026-07-10T01:00:00.000Z')
    saveGraph(makeGraph('2026-07-10T00:00:00.000Z'), root)
    NodeFS.writeFileSync(indexPath, '{}\n')

    let interrupted = false
    vi.resetModules()
    vi.doMock('../../../../packages/cartographer-core/src/store/artifactFs.ts', async () =>
    {
      const actual = await vi.importActual<
        typeof import('../../../../packages/cartographer-core/src/store/artifactFs.ts')
      >('../../../../packages/cartographer-core/src/store/artifactFs.ts')
      return {
        ...actual,
        writeFileAtomic: (path: string, value: string): void =>
        {
          if (!interrupted && path === indexPath)
          {
            publishGeneration(root, next)
            interrupted = true
          }
          actual.writeFileAtomic(path, value)
        },
      }
    })
    try
    {
      const persistence =
        await import('../../../../packages/cartographer-core/src/store/atlasIndex/persist.ts')
      const index = persistence.ensureAtlasIndex(root)
      const stored = JSON.parse(NodeFS.readFileSync(indexPath, 'utf-8')) as {
        sourceGeneratedAt?: string
      }
      expect(interrupted).toBe(true)
      expect(index.sourceGeneratedAt).toBe('2026-07-10T01:00:00.000Z')
      expect(stored.sourceGeneratedAt).toBe('2026-07-10T01:00:00.000Z')
      expect(persistence.ensureAtlasIndex(root)).toBe(index)
    }
    finally
    {
      vi.doUnmock('../../../../packages/cartographer-core/src/store/artifactFs.ts')
      vi.resetModules()
    }
  })

  it('uses the normal graph version guard before rebuilding', () =>
  {
    const root = tempDir()
    const graphPath = graphJsonPath(root)
    saveGraph(makeGraph('2026-07-10T00:00:00.000Z'), root)
    NodeFS.writeFileSync(atlasIndexPath(root), '{}\n')
    NodeFS.writeFileSync(
      graphPath,
      `${JSON.stringify({
        ...makeGraph('2026-07-10T01:00:00.000Z'),
        version: GRAPH_SCHEMA_VERSION + 1,
      })}\n`,
    )

    expect(() => ensureAtlasIndex(root)).toThrow(
      `${graphPath} uses graph schema version ${GRAPH_SCHEMA_VERSION + 1}`,
    )
  })

  it('rebuilds an index from a different schema', () =>
  {
    const root = tempDir()
    const path = atlasIndexPath(root)
    saveGraph(makeGraph('2026-07-10T00:00:00.000Z'), root)
    const v1 = JSON.parse(NodeFS.readFileSync(path, 'utf-8')) as Record<string, unknown>
    NodeFS.writeFileSync(path, `${JSON.stringify({ ...v1, version: 1 })}\n`)

    expect(ensureAtlasIndex(root)).toEqual(v1)
    expect(JSON.parse(NodeFS.readFileSync(path, 'utf-8'))).toEqual(v1)
  })
})

describe('shared atlas index codecs', () =>
{
  it('rejects malformed summary references & preserves additive fields', () =>
  {
    const summary = atlasIndexSummary(buildIndex(referencedHierarchyGraph()))
    const additive = {
      ...summary,
      futureRootField: true,
      repo: { ...summary.repo, futureRepoField: 'kept' },
      units: {
        ...summary.units,
        systems: summary.units.systems.map((unit, index) =>
          index === 0 ? { ...unit, futureUnitField: 1 } : unit,
        ),
      },
    }
    expect(parseAtlasIndexSummary(additive)).toBe(additive)

    const invalidParent = structuredClone(summary)
    invalidParent.units.blocks[0]!.parent = 'systems:missing'
    const invalidEndpoint = structuredClone(summary)
    invalidEndpoint.edges.systems[0]!.to = 'systems:missing'
    const invalidMembership = structuredClone(summary)
    invalidMembership.topFiles[0]!.system = 'systems:missing'
    const invalidUnitOptional = structuredClone(summary)
    Object.assign(invalidUnitOptional.units.systems[0]!, { description: 42 })
    const invalidRepoOptional = structuredClone(summary)
    Object.assign(invalidRepoOptional.repo, { gitRef: 42 })
    const invalidSourceGraphDigest = structuredClone(summary)
    invalidSourceGraphDigest.sourceGraphDigest = 'sha256:not-a-digest'
    for (const invalid of [
      invalidParent,
      invalidEndpoint,
      invalidMembership,
      invalidUnitOptional,
      invalidRepoOptional,
      invalidSourceGraphDigest,
    ])
    {
      expect(() => parseAtlasIndexSummary(invalid)).toThrow(
        'atlas index summary has an invalid schema',
      )
    }
  })

  it('rebuilds stored indexes with invalid references or edge endpoints', () =>
  {
    const corruptions: Array<(index: AtlasIndex) => void> = [
      (index) =>
      {
        index.units.blocks[0]!.parent = 'systems:missing'
      },
      (index) =>
      {
        index.edges.systems[0]!.to = 'systems:missing'
      },
    ]
    for (const corrupt of corruptions)
    {
      const root = tempDir()
      saveGraph(referencedHierarchyGraph(), root)
      const path = atlasIndexPath(root)
      const expected = JSON.parse(NodeFS.readFileSync(path, 'utf-8')) as AtlasIndex
      const invalid = structuredClone(expected)
      corrupt(invalid)
      NodeFS.writeFileSync(path, `${JSON.stringify(invalid)}\n`)

      expect(ensureAtlasIndex(root)).toEqual(expected)
      expect(JSON.parse(NodeFS.readFileSync(path, 'utf-8'))).toEqual(expected)
    }
  })

  it('rejects malformed cursor-query file pages', () =>
  {
    const file = buildIndex(referencedHierarchyGraph()).files[0]!
    const additive = {
      items: [{ ...file, futureFileField: true }],
      total: 1,
      nextCursor: 'next-page',
      futurePageField: true,
    }
    expect(parseAtlasIndexFilePage(additive)).toBe(additive)

    const malformed = [
      { items: [file], total: 1, nextCursor: '' },
      { items: [{ ...file, system: 42 }], total: 1 },
      { items: [file, { ...file }], total: 2 },
      { items: [file], total: 0 },
    ]
    for (const page of malformed)
    {
      expect(() => parseAtlasIndexFilePage(page)).toThrow(
        'atlas index file page has an invalid schema',
      )
    }
  })
})

const hierarchyFixtures: Array<{
  name: string
  graph: CartographerGraph
  source: 'authored' | 'inferred'
  expected: Record<string, string>
}> = [
  {
    name: 'authored-degenerate fallback',
    graph: hierarchyGraph(
      [
        { id: 'packages/a/src/a.ts', group: 'packages/a', system: 'Core' },
        { id: 'packages/a/src/b.ts', group: 'packages/a', system: 'Core' },
        { id: 'packages/b/src/c.ts', group: 'packages/b', system: 'Other' },
        { id: 'packages/b/src/d.ts', group: 'packages/b', system: 'Other' },
      ],
      [
        {
          id: 'Core',
          label: 'Core',
          fileCount: 2,
          source: 'authored',
        },
        {
          id: 'Other',
          label: 'Other',
          fileCount: 2,
          source: 'fallback',
        },
      ],
    ),
    source: 'inferred' as const,
    expected: {
      'packages/a/src/a.ts': 'packages/a',
      'packages/a/src/b.ts': 'packages/a',
      'packages/b/src/c.ts': 'packages/b',
      'packages/b/src/d.ts': 'packages/b',
    },
  },
  {
    name: 'dominant src split',
    graph: hierarchyGraph([
      { id: 'src/app/a.ts', group: 'src/app' },
      { id: 'src/app/b.ts', group: 'src/app' },
      { id: 'src/lib/c.ts', group: 'src/lib' },
      { id: 'src/lib/d.ts', group: 'src/lib' },
    ]),
    source: 'inferred' as const,
    expected: {
      'src/app/a.ts': 'src/app',
      'src/app/b.ts': 'src/app',
      'src/lib/c.ts': 'src/lib',
      'src/lib/d.ts': 'src/lib',
    },
  },
  {
    name: 'deep package split',
    graph: hierarchyGraph([
      { id: 'packages/a/src/a.ts', group: 'packages/a' },
      { id: 'packages/a/src/b.ts', group: 'packages/a' },
      { id: 'packages/b/src/c.ts', group: 'packages/b' },
      { id: 'packages/b/src/d.ts', group: 'packages/b' },
    ]),
    source: 'inferred' as const,
    expected: {
      'packages/a/src/a.ts': 'packages/a',
      'packages/a/src/b.ts': 'packages/a',
      'packages/b/src/c.ts': 'packages/b',
      'packages/b/src/d.ts': 'packages/b',
    },
  },
]

describe('shared system hierarchy', () =>
{
  it.each(hierarchyFixtures)('$name keeps coarse and detailed membership aligned', (fixture) =>
  {
    expectSharedHierarchy(fixture.graph, fixture.source, fixture.expected)
  })
})
