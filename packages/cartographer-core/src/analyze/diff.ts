// packages/cartographer-core/src/analyze/diff.ts
// structural & public-api diff between two graph snapshots

import type { CartographerGraph, GraphRule } from '../contracts/types.js'
import type { GraphEdge } from '../contracts/types.js'
import { compareEdgeEndpoints, edgeIdentityKey, type EdgeEndpoints } from './edgeIdentity.js'
import {
  aggregateMoveFlows,
  pairMoves,
  type MoveFlow,
  type MovedNode,
  type MovePairing,
} from './moves.js'

export interface ExportChange
{
  name: string
  typeOnly?: boolean
  // head-graph files still importing this removed export
  brokenConsumers?: string[]
}

export interface FileApiChange
{
  file: string
  addedExports: ExportChange[]
  removedExports: ExportChange[]
}

interface ApiChangeSummary
{
  apiFiles: number
  addedExports: number
  removedExports: number
  consumers: number
}

export interface ViolationDelta
{
  from: string
  to: string
  rule: string
  severity: GraphRule['severity']
}

export interface GraphDiff
{
  baseGeneratedAt: string
  headGeneratedAt: string
  baseGitRef?: string
  headGitRef?: string
  // added/removed lists exclude move-explained entries
  addedNodes: string[]
  removedNodes: string[]
  addedEdges: EdgeEndpoints[]
  removedEdges: EdgeEndpoints[]
  movedNodes: MovedNode[]
  // dir-level rollup of ALL moves; counts exact even under list caps
  moveFlows: MoveFlow[]
  // edge churn collapsed from the added+removed edge lists
  movedEdges: number
  // per-file export drift where both current nodes have symbol data
  apiChanges: FileApiChange[]
  newViolations: ViolationDelta[]
  resolvedViolations: ViolationDelta[]
  changed: boolean
}

export function summarizeApiChanges(changes: readonly FileApiChange[]): ApiChangeSummary
{
  let addedExports = 0
  let removedExports = 0
  let consumers = 0
  for (const change of changes)
  {
    addedExports += change.addedExports.length
    removedExports += change.removedExports.length
    for (const entry of change.addedExports)
    {
      consumers += entry.brokenConsumers?.length ?? 0
    }
    for (const entry of change.removedExports)
    {
      consumers += entry.brokenConsumers?.length ?? 0
    }
  }
  return {
    apiFiles: changes.length,
    addedExports,
    removedExports,
    consumers,
  }
}

export function diffGraphs(base: CartographerGraph, head: CartographerGraph): GraphDiff
{
  return diffGraphsCore(base, head, undefined, true)
}

// explicit patch diff uses caller moves + base origins & has no API rows
export function diffGraphsWithMoves(
  base: CartographerGraph,
  head: CartographerGraph,
  pairing: MovePairing,
  originByPath: ReadonlyMap<string, string>,
): GraphDiff
{
  const survivingOrigins = new Set(originByPath.values())
  const addedNodes = head.nodes
    .filter((node) => !originByPath.has(node.id))
    .map((node) => node.id)
    .sort()
  const removedNodes = base.nodes
    .filter((node) => !survivingOrigins.has(node.id))
    .map((node) => node.id)
    .sort()

  const baseEdges = new Map(
    base.edges.map((edge): [string, EdgeEndpoints] => [
      edgeIdentityKey(edge),
      { from: edge.from, to: edge.to },
    ]),
  )
  const matchedBaseEdges = new Set<string>()
  const addedEdges: EdgeEndpoints[] = []
  let movedEdges = 0
  for (const edge of head.edges)
  {
    const from = originByPath.get(edge.from)
    const to = originByPath.get(edge.to)
    if (from === undefined || to === undefined)
    {
      addedEdges.push({ from: edge.from, to: edge.to })
      continue
    }
    const origin = { from, to }
    const key = edgeIdentityKey(origin)
    if (!baseEdges.has(key) || matchedBaseEdges.has(key))
    {
      addedEdges.push({ from: edge.from, to: edge.to })
      continue
    }
    matchedBaseEdges.add(key)
    if (edge.from !== from || edge.to !== to)
    {
      movedEdges += 1
    }
  }
  addedEdges.sort(compareEdgeEndpoints)
  const removedEdges = [...baseEdges]
    .filter(([key]) => !matchedBaseEdges.has(key))
    .map(([, edge]) => edge)
    .sort(compareEdgeEndpoints)

  const movedNodes = pairing.moved
  const moveFlows = aggregateMoveFlows(movedNodes)
  const { newViolations, resolvedViolations } = diffViolations(base, head, pairing.moveMap)
  return {
    baseGeneratedAt: base.generatedAt,
    headGeneratedAt: head.generatedAt,
    ...(base.gitRef ? { baseGitRef: base.gitRef } : {}),
    ...(head.gitRef ? { headGitRef: head.gitRef } : {}),
    addedNodes,
    removedNodes,
    addedEdges,
    removedEdges,
    movedNodes,
    moveFlows,
    movedEdges,
    apiChanges: [],
    newViolations,
    resolvedViolations,
    changed:
      addedNodes.length > 0 ||
      removedNodes.length > 0 ||
      addedEdges.length > 0 ||
      removedEdges.length > 0 ||
      movedNodes.length > 0 ||
      newViolations.length > 0 ||
      resolvedViolations.length > 0,
  }
}

function diffGraphsCore(
  base: CartographerGraph,
  head: CartographerGraph,
  pairing: MovePairing | undefined,
  withApi: boolean,
): GraphDiff
{
  const baseNodes = new Set(base.nodes.map((n) => n.id))
  const headNodes = new Set(head.nodes.map((n) => n.id))
  const baseEdges = new Map(
    base.edges.map((edge): [string, EdgeEndpoints] => [
      edgeIdentityKey(edge),
      { from: edge.from, to: edge.to },
    ]),
  )
  const headEdges = new Map(
    head.edges.map((edge): [string, EdgeEndpoints] => [
      edgeIdentityKey(edge),
      { from: edge.from, to: edge.to },
    ]),
  )

  const rawAddedNodes = [...headNodes].filter((id) => !baseNodes.has(id)).sort()
  const rawRemovedNodes = [...baseNodes].filter((id) => !headNodes.has(id)).sort()
  const rawAddedEdges = [...headEdges]
    .filter(([key]) => !baseEdges.has(key))
    .map(([, edge]) => edge)
    .sort(compareEdgeEndpoints)
  const rawRemovedEdges = [...baseEdges]
    .filter(([key]) => !headEdges.has(key))
    .map(([, edge]) => edge)
    .sort(compareEdgeEndpoints)

  const { moved, moveMap } = pairing ?? pairMoves(base, head, rawRemovedNodes, rawAddedNodes)
  const movedTo = new Set(moved.map((m) => m.to))
  const addedNodes = rawAddedNodes.filter((id) => !movedTo.has(id))
  const removedNodes = rawRemovedNodes.filter((id) => !moveMap.has(id))

  // collapse edge churn that just followed a move: a removed edge whose
  // move-remapped key reappears in the added list cancels its counterpart
  const removedEdgeSet = new Set(rawRemovedEdges.map(edgeIdentityKey))
  const addedEdgeSet = new Set(rawAddedEdges.map(edgeIdentityKey))
  const dropRemoved = new Set<string>()
  const dropAdded = new Set<string>()
  const remap = (id: string): string => moveMap.get(id) ?? id
  for (const edge of base.edges)
  {
    const key = edgeIdentityKey(edge)
    if (!removedEdgeSet.has(key) || dropRemoved.has(key))
    {
      continue
    }
    const remapped = edgeIdentityKey({
      from: remap(edge.from),
      to: remap(edge.to),
    })
    if (addedEdgeSet.has(remapped) && !dropAdded.has(remapped))
    {
      dropRemoved.add(key)
      dropAdded.add(remapped)
    }
  }
  const movedEdges = dropRemoved.size
  const addedEdges = rawAddedEdges.filter((edge) => !dropAdded.has(edgeIdentityKey(edge)))
  const removedEdges = rawRemovedEdges.filter((edge) => !dropRemoved.has(edgeIdentityKey(edge)))

  const moveFlows = aggregateMoveFlows(moved)
  const apiChanges = withApi ? diffApi(base, head, moveMap) : []
  const { newViolations, resolvedViolations } = diffViolations(base, head, moveMap)

  return {
    baseGeneratedAt: base.generatedAt,
    headGeneratedAt: head.generatedAt,
    ...(base.gitRef ? { baseGitRef: base.gitRef } : {}),
    ...(head.gitRef ? { headGitRef: head.gitRef } : {}),
    addedNodes,
    removedNodes,
    addedEdges,
    removedEdges,
    movedNodes: moved,
    moveFlows,
    movedEdges,
    apiChanges,
    newViolations,
    resolvedViolations,
    changed:
      addedNodes.length > 0 ||
      removedNodes.length > 0 ||
      addedEdges.length > 0 ||
      removedEdges.length > 0 ||
      moved.length > 0 ||
      apiChanges.length > 0 ||
      newViolations.length > 0 ||
      resolvedViolations.length > 0,
  }
}

function diffViolations(
  base: CartographerGraph,
  head: CartographerGraph,
  moveMap: ReadonlyMap<string, string>,
): { newViolations: ViolationDelta[]; resolvedViolations: ViolationDelta[] }
{
  // key base violations in head space so ones that merely followed a move
  // cancel against their head counterpart, like the edge churn collapse above
  const remap = (id: string): string => moveMap.get(id) ?? id
  const baseViolations = violationIdentities(base, remap)
  const headViolations = violationIdentities(head)
  return {
    newViolations: violationDelta(headViolations, baseViolations),
    resolvedViolations: violationDelta(baseViolations, headViolations),
  }
}

// identities keep their own graph's paths; only the key is move-normalized
function violationIdentities(
  graph: CartographerGraph,
  remap: (id: string) => string = (id) => id,
): Map<string, ViolationDelta>
{
  const severityByRule = new Map((graph.rules ?? []).map((rule) => [rule.id, rule.severity]))
  const identities = new Map<string, ViolationDelta>()
  for (const edge of graph.edges)
  {
    for (const rule of edge.violations ?? [])
    {
      const severity = severityByRule.get(rule) ?? 'error'
      const identity = { from: edge.from, to: edge.to, rule, severity }
      const key = JSON.stringify([remap(edge.from), remap(edge.to), rule, severity])
      identities.set(key, identity)
    }
  }
  return identities
}

function violationDelta(
  source: ReadonlyMap<string, ViolationDelta>,
  comparison: ReadonlyMap<string, ViolationDelta>,
): ViolationDelta[]
{
  return [...source]
    .filter(([key]) => !comparison.has(key))
    .map(([, violation]) => violation)
    .sort(
      (a, b) =>
        a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    )
}

// export drift across files whose current graphs both carry symbol data
function diffApi(
  base: CartographerGraph,
  head: CartographerGraph,
  moveMap: ReadonlyMap<string, string>,
): FileApiChange[]
{
  const headByFile = new Map(head.nodes.map((n) => [n.id, n]))
  const headIncoming = incomingEdges(head)
  const changes: FileApiChange[] = []
  for (const baseNode of base.nodes)
  {
    const headNode = headByFile.get(moveMap.get(baseNode.id) ?? baseNode.id)
    if (!headNode || !baseNode.exports || !headNode.exports)
    {
      continue
    }
    const baseExports = new Map(baseNode.exports.map((e) => [e.name, e]))
    const headExports = new Map(headNode.exports.map((e) => [e.name, e]))
    const removedExports: ExportChange[] = []
    for (const [name, entry] of baseExports)
    {
      if (headExports.has(name))
      {
        continue
      }
      removedExports.push({
        name,
        ...(entry.typeOnly ? { typeOnly: true } : {}),
        brokenConsumers: symbolConsumers(headIncoming, headNode.id, name),
      })
    }
    const addedExports: ExportChange[] = []
    for (const [name, entry] of headExports)
    {
      if (baseExports.has(name))
      {
        continue
      }
      addedExports.push({
        name,
        ...(entry.typeOnly ? { typeOnly: true } : {}),
      })
    }
    if (removedExports.length > 0 || addedExports.length > 0)
    {
      changes.push({
        file: headNode.id,
        addedExports: sortChanges(addedExports),
        removedExports: sortChanges(removedExports),
      })
    }
  }
  return changes.sort((a, b) => a.file.localeCompare(b.file))
}

function incomingEdges(graph: CartographerGraph): Map<string, GraphEdge[]>
{
  const incoming = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges)
  {
    const edges = incoming.get(edge.to)
    if (edges)
    {
      edges.push(edge)
    }
    else
    {
      incoming.set(edge.to, [edge])
    }
  }
  return incoming
}

// importers pulling the name; symbol-less edges (star/namespace) count too
function symbolConsumers(incoming: Map<string, GraphEdge[]>, file: string, name: string): string[]
{
  const consumers = new Set<string>()
  for (const edge of incoming.get(file) ?? [])
  {
    if (edge.symbols === undefined || edge.symbols.includes(name))
    {
      consumers.add(edge.from)
    }
  }
  return [...consumers].sort()
}

function sortChanges(changes: ExportChange[]): ExportChange[]
{
  return changes.sort((a, b) => a.name.localeCompare(b.name))
}

export function formatDiffSummary(diff: GraphDiff): string
{
  const apiSummary = summarizeApiChanges(diff.apiChanges)
  const apiTotal = apiSummary.addedExports + apiSummary.removedExports
  if (!diff.changed)
  {
    return 'no architectural drift'
  }
  const parts: string[] = []
  if (diff.addedNodes.length > 0)
  {
    parts.push(`+${diff.addedNodes.length} file(s)`)
  }
  if (diff.removedNodes.length > 0)
  {
    parts.push(`-${diff.removedNodes.length} file(s)`)
  }
  if (diff.movedNodes.length > 0)
  {
    parts.push(`${diff.movedNodes.length} moved file(s)`)
  }
  if (diff.addedEdges.length > 0)
  {
    parts.push(`+${diff.addedEdges.length} import(s)`)
  }
  if (diff.removedEdges.length > 0)
  {
    parts.push(`-${diff.removedEdges.length} import(s)`)
  }
  if (diff.movedEdges > 0)
  {
    parts.push(`${diff.movedEdges} moved import(s)`)
  }
  if (apiTotal > 0)
  {
    parts.push(`${apiTotal} exported-symbol change(s)`)
  }
  if (diff.newViolations.length > 0)
  {
    parts.push(`${diff.newViolations.length} new rule violation(s)`)
  }
  if (diff.resolvedViolations.length > 0)
  {
    parts.push(`${diff.resolvedViolations.length} resolved rule violation(s)`)
  }
  return parts.join(', ')
}
