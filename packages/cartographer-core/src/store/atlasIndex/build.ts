// packages/cartographer-core/src/store/atlasIndex/build.ts
// coarse atlas index membership, aggregation & file ranking

import * as NodePath from 'node:path'
import { fileDegrees } from '../../analyze/degrees.js'
import { selectSystemHierarchy } from '../../analyze/systemHierarchy.js'
import type {
  AtlasIndex,
  AtlasIndexEdge,
  AtlasIndexFile,
  AtlasIndexLevel,
  AtlasIndexScopeSummary,
  AtlasIndexUnit,
  CartographerGraph,
  GraphNode,
  SourceGraphDigest,
} from '../../contracts/types.js'
import { ATLAS_INDEX_SCHEMA_VERSION } from '../../contracts/types.js'
import { BLOCK_UNIT_LIMIT, DIR_UNIT_LIMIT, EDGE_LIMIT, SYSTEM_UNIT_LIMIT } from './constants.js'

interface Membership
{
  systemOf: Map<string, string>
  blockOf: Map<string, string>
  dirOf: Map<string, string>
  systemLabels: Map<string, string>
  systemDescriptions: Map<string, string>
  systemSources: Map<string, 'authored' | 'fallback' | 'inferred'>
  systemOrder: Map<string, number>
  systemSource: 'authored' | 'inferred'
}

interface LevelBuild
{
  units: AtlasIndexUnit[]
  edges: AtlasIndexEdge[]
  total: number
  edgeTotal: number
  retained: Set<string>
  exactEdges: AtlasIndexEdge[]
  parentByKey: Map<string, string>
  totalByParent: Map<string, number>
}

type RetainedUnits = Record<AtlasIndexLevel, Set<string>>

function unitId(level: AtlasIndexLevel, key: string): string
{
  return `${level}:${key}`
}

function dirKey(id: string): string
{
  const slash = id.lastIndexOf('/')
  return slash > 0 ? id.slice(0, slash) : '.'
}

function displayPath(key: string): string
{
  if (key === '.')
  {
    return 'Root'
  }
  const tail = key.split('/').pop() ?? key
  return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function increment(map: Map<string, number>, key: string, amount = 1): void
{
  map.set(key, (map.get(key) ?? 0) + amount)
}

function dominant(
  counts: Map<string, number>,
  preferredOrder?: Map<string, number>,
): string | undefined
{
  let top: [string, number] | undefined
  for (const entry of counts)
  {
    if (
      !top ||
      entry[1] > top[1] ||
      (entry[1] === top[1] &&
        (preferredOrder
          ? (preferredOrder.get(entry[0]) ?? Number.MAX_SAFE_INTEGER) <
            (preferredOrder.get(top[0]) ?? Number.MAX_SAFE_INTEGER)
          : entry[0].localeCompare(top[0]) < 0))
    )
    {
      top = entry
    }
  }
  return top?.[0]
}

function buildMembership(graph: CartographerGraph): Membership
{
  const blockOf = new Map(graph.nodes.map((node) => [node.id, node.group]))
  const dirOf = new Map(graph.nodes.map((node) => [node.id, dirKey(node.id)]))
  const hierarchy = selectSystemHierarchy(graph.nodes, graph.systems ?? [])
  return {
    systemOf: hierarchy.systemOfFile,
    blockOf,
    dirOf,
    systemLabels: new Map(
      hierarchy.candidates.map((candidate) => [candidate.key, candidate.label]),
    ),
    systemDescriptions: new Map(
      hierarchy.candidates.map((candidate) => [candidate.key, candidate.description]),
    ),
    systemSources: new Map(
      hierarchy.candidates.map((candidate) => [candidate.key, candidate.source]),
    ),
    systemOrder: new Map(hierarchy.candidates.map((candidate, index) => [candidate.key, index])),
    systemSource: hierarchy.source,
  }
}

function parentByMajority(
  graph: CartographerGraph,
  childOf: Map<string, string>,
  parentOf: Map<string, string>,
  preferredOrder?: Map<string, number>,
): Map<string, string>
{
  const counts = new Map<string, Map<string, number>>()
  for (const node of graph.nodes)
  {
    const child = childOf.get(node.id)
    const parent = parentOf.get(node.id)
    if (!child || !parent)
    {
      continue
    }
    const row = counts.get(child) ?? new Map<string, number>()
    increment(row, parent)
    counts.set(child, row)
  }
  return new Map(
    [...counts].flatMap(([child, row]) =>
    {
      const parent = dominant(row, preferredOrder)
      return parent ? [[child, parent] as [string, string]] : []
    }),
  )
}

function aggregateLevel(
  graph: CartographerGraph,
  level: AtlasIndexLevel,
  keyOf: Map<string, string>,
  labels: Map<string, string>,
  descriptions: Map<string, string>,
  parents: Map<string, string>,
  sources: Map<string, 'authored' | 'fallback' | 'inferred'>,
  unitLimit: number,
  allowedParents?: Set<string>,
): LevelBuild
{
  const counts = new Map<string, number>()
  for (const node of graph.nodes)
  {
    const key = keyOf.get(node.id)
    if (key)
    {
      increment(counts, key)
    }
  }
  const inbound = new Map<string, number>()
  const outbound = new Map<string, number>()
  const edgeWeights = new Map<string, number>()
  const totalByParent = new Map<string, number>()
  for (const key of counts.keys())
  {
    const parent = parents.get(key)
    if (parent !== undefined)
    {
      increment(totalByParent, parent)
    }
  }
  for (const edge of graph.edges)
  {
    const from = keyOf.get(edge.from)
    const to = keyOf.get(edge.to)
    if (!from || !to || from === to)
    {
      continue
    }
    increment(outbound, from)
    increment(inbound, to)
    increment(edgeWeights, `${from}\u0000${to}`)
  }
  const ranked = [...counts].sort((a, b) =>
  {
    const aScore = a[1] * 4 + (inbound.get(a[0]) ?? 0) + (outbound.get(a[0]) ?? 0)
    const bScore = b[1] * 4 + (inbound.get(b[0]) ?? 0) + (outbound.get(b[0]) ?? 0)
    return bScore - aScore || a[0].localeCompare(b[0])
  })
  const visibilityRank = new Map(ranked.map(([key], index): [string, number] => [key, index + 1]))
  const eligible = allowedParents
    ? ranked.filter(([key]) =>
      {
        const parent = parents.get(key)
        return parent !== undefined && allowedParents.has(parent)
      })
    : ranked
  const retained = eligible
    .slice(0, unitLimit)
    .map(([key]) => key)
    .sort()
  const retainedSet = new Set(retained)
  const columns = Math.max(1, Math.ceil(Math.sqrt(retained.length)))
  const units = retained.map((key, order): AtlasIndexUnit =>
  {
    const description = descriptions.get(key)
    const parent = parents.get(key)
    const source = sources.get(key)
    return {
      id: unitId(level, key),
      key,
      level,
      label: labels.get(key) ?? displayPath(key),
      ...(description ? { description } : {}),
      ...(parent
        ? {
            parent: unitId(level === 'blocks' ? 'systems' : 'blocks', parent),
          }
        : {}),
      ...(source ? { source } : {}),
      fileCount: counts.get(key) ?? 0,
      inbound: inbound.get(key) ?? 0,
      outbound: outbound.get(key) ?? 0,
      visibilityRank: visibilityRank.get(key) ?? order + 1,
      order,
      position: {
        x: (order % columns) * 240,
        y: Math.floor(order / columns) * 140,
      },
    }
  })
  const exactEdges = [...edgeWeights]
    .map(([key, weight]): AtlasIndexEdge =>
    {
      const split = key.indexOf('\u0000')
      const from = key.slice(0, split)
      const to = key.slice(split + 1)
      return { from: unitId(level, from), to: unitId(level, to), weight }
    })
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  const edges = exactEdges
    .filter(
      (edge) =>
        retainedSet.has(edge.from.slice(level.length + 1)) &&
        retainedSet.has(edge.to.slice(level.length + 1)),
    )
    .slice(0, EDGE_LIMIT)
  return {
    units,
    edges,
    total: counts.size,
    edgeTotal: edgeWeights.size,
    retained: retainedSet,
    exactEdges,
    parentByKey: parents,
    totalByParent,
  }
}

function scopeSummaries(
  parents: AtlasIndexUnit[],
  children: LevelBuild,
  childLevel: 'blocks' | 'dirs',
): AtlasIndexScopeSummary[]
{
  return parents.map((parent) =>
  {
    const exactChildIds = new Set(
      children.units.filter((unit) => unit.parent === parent.id).map((unit) => unit.id),
    )
    const totalChildren = children.totalByParent.get(parent.key) ?? 0
    const totalEdges = children.exactEdges.filter((edge) =>
    {
      const from = edge.from.slice(childLevel.length + 1)
      const to = edge.to.slice(childLevel.length + 1)
      return (
        children.parentByKey.get(from) === parent.key && children.parentByKey.get(to) === parent.key
      )
    }).length
    const indexedEdges = children.edges.filter(
      (edge) => exactChildIds.has(edge.from) && exactChildIds.has(edge.to),
    ).length
    return {
      parent: parent.id,
      childLevel,
      children: {
        total: totalChildren,
        indexed: exactChildIds.size,
        omitted: totalChildren - exactChildIds.size,
      },
      edges: {
        total: totalEdges,
        indexed: indexedEdges,
        omitted: totalEdges - indexedEdges,
      },
    }
  })
}

function fileRecord(
  node: GraphNode,
  membership: Membership,
  fanIn: Map<string, number>,
  fanOut: Map<string, number>,
  visibilityRank: number,
  retained: RetainedUnits,
): AtlasIndexFile
{
  const system = membership.systemOf.get(node.id)
  const block = membership.blockOf.get(node.id)
  const dir = membership.dirOf.get(node.id)
  return {
    id: node.id,
    label: node.label,
    ...(node.description ? { description: node.description } : {}),
    ...(system && retained.systems.has(system) ? { system: unitId('systems', system) } : {}),
    ...(block && retained.blocks.has(block) ? { block: unitId('blocks', block) } : {}),
    ...(dir && retained.dirs.has(dir) ? { dir: unitId('dirs', dir) } : {}),
    fanIn: fanIn.get(node.id) ?? 0,
    fanOut: fanOut.get(node.id) ?? 0,
    visibilityRank,
  }
}

function rankedFiles(
  graph: CartographerGraph,
  membership: Membership,
  retained: RetainedUnits,
): AtlasIndexFile[]
{
  const { fanIn, fanOut } = fileDegrees(graph.edges)
  return [...graph.nodes]
    .sort((a, b) =>
    {
      const aScore = (fanIn.get(a.id) ?? 0) * 3 + (fanOut.get(a.id) ?? 0)
      const bScore = (fanIn.get(b.id) ?? 0) * 3 + (fanOut.get(b.id) ?? 0)
      return bScore - aScore || a.id.localeCompare(b.id)
    })
    .map((node, index) => fileRecord(node, membership, fanIn, fanOut, index + 1, retained))
}

export function buildAtlasIndex(
  graph: CartographerGraph,
  sourceGraphDigest: SourceGraphDigest,
  root = graph.repoRoot,
): AtlasIndex
{
  const canonicalRoot = NodePath.resolve(root)
  const membership = buildMembership(graph)
  const blockParents = parentByMajority(
    graph,
    membership.blockOf,
    membership.systemOf,
    membership.systemOrder,
  )
  const dirParents = parentByMajority(graph, membership.dirOf, membership.blockOf)
  const groupLabels = new Map(graph.groups.map((group) => [group.id, group.label]))
  const groupDescriptions = new Map(
    graph.groups.flatMap((group) =>
      group.description ? [[group.id, group.description] as [string, string]] : [],
    ),
  )
  const dirLabels = new Map<string, string>()
  for (const key of membership.dirOf.values())
  {
    dirLabels.set(key, key === '.' ? '(root)' : key)
  }
  const systems = aggregateLevel(
    graph,
    'systems',
    membership.systemOf,
    membership.systemLabels,
    membership.systemDescriptions,
    new Map(),
    membership.systemSources,
    SYSTEM_UNIT_LIMIT,
  )
  const blocks = aggregateLevel(
    graph,
    'blocks',
    membership.blockOf,
    groupLabels,
    groupDescriptions,
    blockParents,
    new Map(),
    BLOCK_UNIT_LIMIT,
    systems.retained,
  )
  const dirs = aggregateLevel(
    graph,
    'dirs',
    membership.dirOf,
    dirLabels,
    new Map(),
    dirParents,
    new Map(),
    DIR_UNIT_LIMIT,
    blocks.retained,
  )
  const retained: RetainedUnits = {
    systems: systems.retained,
    blocks: blocks.retained,
    dirs: dirs.retained,
  }
  return {
    version: ATLAS_INDEX_SCHEMA_VERSION,
    sourceGeneratedAt: graph.generatedAt,
    sourceGraphDigest,
    repo: {
      root: canonicalRoot,
      name: NodePath.basename(canonicalRoot),
      scope: graph.scope,
      mode: graph.mode,
      ...(graph.gitRef ? { gitRef: graph.gitRef } : {}),
    },
    counts: {
      files: graph.nodes.length,
      imports: graph.edges.length,
      systems: systems.total,
      blocks: blocks.total,
      dirs: dirs.total,
      indexedSystems: systems.units.length,
      indexedBlocks: blocks.units.length,
      indexedDirs: dirs.units.length,
    },
    systemSource: membership.systemSource,
    units: {
      systems: systems.units,
      blocks: blocks.units,
      dirs: dirs.units,
    },
    edges: {
      systems: systems.edges,
      blocks: blocks.edges,
      dirs: dirs.edges,
    },
    edgeCounts: {
      systems: {
        total: systems.edgeTotal,
        indexed: systems.edges.length,
        omitted: systems.edgeTotal - systems.edges.length,
      },
      blocks: {
        total: blocks.edgeTotal,
        indexed: blocks.edges.length,
        omitted: blocks.edgeTotal - blocks.edges.length,
      },
      dirs: {
        total: dirs.edgeTotal,
        indexed: dirs.edges.length,
        omitted: dirs.edgeTotal - dirs.edges.length,
      },
    },
    scopes: [
      ...scopeSummaries(systems.units, blocks, 'blocks'),
      ...scopeSummaries(blocks.units, dirs, 'dirs'),
    ],
    health: {
      cycles: graph.metrics.cycles,
      orphans: graph.metrics.orphans,
      violatingImports: graph.edges.filter((edge) => (edge.violations?.length ?? 0) > 0).length,
      violatedRules: new Set(graph.edges.flatMap((edge) => edge.violations ?? [])).size,
      ruleTotal: graph.rules?.length ?? 0,
    },
    files: rankedFiles(graph, membership, retained),
  }
}
