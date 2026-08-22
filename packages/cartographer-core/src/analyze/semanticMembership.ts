// packages/cartographer-core/src/analyze/semanticMembership.ts
// computes uncapped semantic memberships, physical directories, layouts, and edges

import type { CartographerGraph, GraphNode } from '../contracts/types.js'
import { selectSystemHierarchy } from './systemHierarchy.js'

export type SemanticLevel = 'systems' | 'blocks' | 'dirs' | 'files'

export interface SemanticPosition
{
  x: number
  y: number
}

export interface SemanticUnit
{
  id: string
  key: string
  label: string
  level: SemanticLevel
  parentId?: string
  relativePath?: string
  position: SemanticPosition
  fileCount: number
  directFileCount: number
  inbound: number
  outbound: number
}

export interface SemanticEdge
{
  from: string
  to: string
  weight: number
}

export interface SemanticDirectoryScopeEdge extends SemanticEdge
{
  parent: string
}

export interface SemanticSnapshot
{
  memberships: Record<SemanticLevel, Map<string, string>>
  units: Record<SemanticLevel, Map<string, SemanticUnit>>
  edges: Record<SemanticLevel, Map<string, SemanticEdge>>
  directoryScopeEdges: SemanticDirectoryScopeEdge[]
}

export const SEMANTIC_LEVELS: SemanticLevel[] = ['systems', 'blocks', 'dirs', 'files']

export function semanticUnitId(level: SemanticLevel, key: string): string
{
  return level === 'files' ? key : `${level}:${key}`
}

export function semanticEdgeKey(from: string, to: string): string
{
  return `${from}\u0000${to}`
}

function compareText(left: string, right: string): number
{
  return left < right ? -1 : left > right ? 1 : 0
}

export function directoryOf(path: string): string
{
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '.' : path.slice(0, slash)
}

export function directoryPrefixes(directory: string): string[]
{
  if (directory === '.') return ['.']
  const prefixes = ['.']
  let prefix = ''
  for (const segment of directory.split('/'))
  {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`
    prefixes.push(prefix)
  }
  return prefixes
}

export function parentDirectory(directory: string): string | undefined
{
  if (directory === '.') return undefined
  const slash = directory.lastIndexOf('/')
  return slash < 0 ? '.' : directory.slice(0, slash)
}

function displayPath(path: string): string
{
  if (path === '.') return 'Root'
  return path
    .split('/')
    .at(-1)!
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (value) => value.toUpperCase())
}

function increment(map: Map<string, number>, key: string, amount = 1): void
{
  map.set(key, (map.get(key) ?? 0) + amount)
}

function majorityParents(
  nodes: readonly GraphNode[],
  childByFile: ReadonlyMap<string, string>,
  parentByFile: ReadonlyMap<string, string>,
): Map<string, string>
{
  const counts = new Map<string, Map<string, number>>()
  for (const node of nodes)
  {
    const child = childByFile.get(node.id)
    const parent = parentByFile.get(node.id)
    if (child === undefined || parent === undefined) continue
    const candidates = counts.get(child) ?? new Map<string, number>()
    increment(candidates, parent)
    counts.set(child, candidates)
  }
  return new Map(
    [...counts].map(([child, candidates]) => [
      child,
      [...candidates].sort(
        (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
      )[0]![0],
    ]),
  )
}

function gridPosition(index: number, total: number): SemanticPosition
{
  const columns = Math.max(1, Math.ceil(Math.sqrt(total)))
  return {
    x: (index % columns) * 240,
    y: Math.floor(index / columns) * 150,
  }
}

function aggregateEdges(
  graph: CartographerGraph,
  membership: ReadonlyMap<string, string>,
): Map<string, SemanticEdge>
{
  const edges = new Map<string, SemanticEdge>()
  for (const edge of graph.edges)
  {
    const from = membership.get(edge.from)
    const to = membership.get(edge.to)
    if (from === undefined || to === undefined || from === to) continue
    const key = semanticEdgeKey(from, to)
    const current = edges.get(key)
    edges.set(key, { from, to, weight: (current?.weight ?? 0) + 1 })
  }
  return edges
}

function degrees(edges: ReadonlyMap<string, SemanticEdge>): {
  inbound: Map<string, number>
  outbound: Map<string, number>
}
{
  const inbound = new Map<string, number>()
  const outbound = new Map<string, number>()
  for (const edge of edges.values())
  {
    increment(outbound, edge.from, edge.weight)
    increment(inbound, edge.to, edge.weight)
  }
  return { inbound, outbound }
}

function regularUnits(input: {
  graph: CartographerGraph
  level: Exclude<SemanticLevel, 'dirs'>
  membership: Map<string, string>
  labels: ReadonlyMap<string, string>
  parents: ReadonlyMap<string, string>
}): { units: Map<string, SemanticUnit>; edges: Map<string, SemanticEdge> }
{
  const counts = new Map<string, number>()
  for (const node of input.graph.nodes)
  {
    const id = input.membership.get(node.id)
    if (id !== undefined) increment(counts, id)
  }
  const edges = aggregateEdges(input.graph, input.membership)
  const { inbound, outbound } = degrees(edges)
  const ids = [...counts.keys()].sort()
  const units = new Map(
    ids.map((id, index): [string, SemanticUnit] =>
    {
      const key = input.level === 'files' ? id : id.slice(input.level.length + 1)
      const parentId = input.parents.get(key)
      return [
        id,
        {
          id,
          key,
          level: input.level,
          label: input.labels.get(key) ?? displayPath(key),
          ...(parentId === undefined ? {} : { parentId }),
          ...(input.level === 'files' ? { relativePath: id } : {}),
          position: gridPosition(index, ids.length),
          fileCount: counts.get(id) ?? 0,
          directFileCount: counts.get(id) ?? 0,
          inbound: inbound.get(id) ?? 0,
          outbound: outbound.get(id) ?? 0,
        },
      ]
    }),
  )
  return { units, edges }
}

function directoryUnits(
  graph: CartographerGraph,
  membership: Map<string, string>,
): { units: Map<string, SemanticUnit>; edges: Map<string, SemanticEdge> }
{
  const directCounts = new Map<string, number>()
  const descendantCounts = new Map<string, number>()
  const directories = new Set<string>(['.'])
  for (const node of graph.nodes)
  {
    const leaf = directoryOf(node.id)
    increment(directCounts, leaf)
    for (const prefix of directoryPrefixes(leaf))
    {
      directories.add(prefix)
      increment(descendantCounts, prefix)
    }
  }
  const edges = aggregateEdges(graph, membership)
  const { inbound, outbound } = degrees(edges)
  const keys = [...directories].sort((left, right) =>
  {
    const depth = (value: string) => (value === '.' ? 0 : value.split('/').length)
    return depth(left) - depth(right) || compareText(left, right)
  })
  const siblingIndex = new Map<string, number>()
  const siblingCount = new Map<string, number>()
  for (const key of keys)
  {
    const parent = parentDirectory(key)
    if (parent !== undefined) increment(siblingCount, parent)
  }
  const units = new Map<string, SemanticUnit>()
  for (const key of keys)
  {
    const parent = parentDirectory(key)
    const index = parent === undefined ? 0 : (siblingIndex.get(parent) ?? 0)
    if (parent !== undefined) siblingIndex.set(parent, index + 1)
    const depth = key === '.' ? 0 : key.split('/').length
    const id = semanticUnitId('dirs', key)
    units.set(id, {
      id,
      key,
      level: 'dirs',
      label: displayPath(key),
      ...(parent === undefined ? {} : { parentId: semanticUnitId('dirs', parent) }),
      relativePath: key,
      position: {
        x: index * 240,
        y: depth * 150,
      },
      fileCount: descendantCounts.get(key) ?? 0,
      directFileCount: directCounts.get(key) ?? 0,
      inbound: inbound.get(id) ?? 0,
      outbound: outbound.get(id) ?? 0,
    })
  }
  return { units, edges }
}

function directoryScopeEdges(
  graph: CartographerGraph,
  directoryByFile: ReadonlyMap<string, string>,
): SemanticDirectoryScopeEdge[]
{
  const weights = new Map<string, SemanticDirectoryScopeEdge>()
  for (const edge of graph.edges)
  {
    const fromLeaf = directoryByFile.get(edge.from)
    const toLeaf = directoryByFile.get(edge.to)
    if (fromLeaf === undefined || toLeaf === undefined) continue
    const fromChain = directoryPrefixes(fromLeaf)
    const toChain = directoryPrefixes(toLeaf)
    let commonLength = 0
    while (
      commonLength < fromChain.length &&
      commonLength < toChain.length &&
      fromChain[commonLength] === toChain[commonLength]
    )
    {
      commonLength += 1
    }
    if (commonLength === 0) continue
    const common = fromChain[commonLength - 1]!
    const parent = semanticUnitId('dirs', common)
    const from =
      commonLength < fromChain.length ? semanticUnitId('dirs', fromChain[commonLength]!) : edge.from
    const to =
      commonLength < toChain.length ? semanticUnitId('dirs', toChain[commonLength]!) : edge.to
    if (from === to) continue
    const key = `${parent}\u0000${from}\u0000${to}`
    const current = weights.get(key)
    weights.set(key, { parent, from, to, weight: (current?.weight ?? 0) + 1 })
  }
  return [...weights.values()].sort(
    (left, right) =>
      compareText(left.parent, right.parent) ||
      compareText(left.from, right.from) ||
      compareText(left.to, right.to),
  )
}

export function buildSemanticSnapshot(graph: CartographerGraph): SemanticSnapshot
{
  const hierarchy = selectSystemHierarchy(graph.nodes, graph.systems ?? [])
  const systemKeys = hierarchy.systemOfFile
  const blockKeys = new Map(graph.nodes.map((node): [string, string] => [node.id, node.group]))
  const directoryKeys = new Map(
    graph.nodes.map((node): [string, string] => [node.id, directoryOf(node.id)]),
  )
  const memberships: SemanticSnapshot['memberships'] = {
    systems: new Map([...systemKeys].map(([file, key]) => [file, semanticUnitId('systems', key)])),
    blocks: new Map([...blockKeys].map(([file, key]) => [file, semanticUnitId('blocks', key)])),
    dirs: new Map([...directoryKeys].map(([file, key]) => [file, semanticUnitId('dirs', key)])),
    files: new Map(graph.nodes.map((node): [string, string] => [node.id, node.id])),
  }
  const systems = regularUnits({
    graph,
    level: 'systems',
    membership: memberships.systems,
    labels: new Map(hierarchy.candidates.map((candidate) => [candidate.key, candidate.label])),
    parents: new Map(),
  })
  const blocks = regularUnits({
    graph,
    level: 'blocks',
    membership: memberships.blocks,
    labels: new Map(graph.groups.map((group) => [group.id, group.label])),
    parents: new Map(
      [...majorityParents(graph.nodes, blockKeys, systemKeys)].map(([key, parent]) => [
        key,
        semanticUnitId('systems', parent),
      ]),
    ),
  })
  const dirs = directoryUnits(graph, memberships.dirs)
  const files = regularUnits({
    graph,
    level: 'files',
    membership: memberships.files,
    labels: new Map(graph.nodes.map((node) => [node.id, node.label])),
    parents: new Map(
      graph.nodes.map((node): [string, string] => [
        node.id,
        semanticUnitId('dirs', directoryOf(node.id)),
      ]),
    ),
  })
  return {
    memberships,
    units: {
      systems: systems.units,
      blocks: blocks.units,
      dirs: dirs.units,
      files: files.units,
    },
    edges: {
      systems: systems.edges,
      blocks: blocks.edges,
      dirs: dirs.edges,
      files: files.edges,
    },
    directoryScopeEdges: directoryScopeEdges(graph, directoryKeys),
  }
}
