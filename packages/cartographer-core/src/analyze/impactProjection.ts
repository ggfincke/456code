// packages/cartographer-core/src/analyze/impactProjection.ts
// builds deterministic bounded semantic impact projections from exact graph pairs

import * as NodeCrypto from 'node:crypto'

import type { CartographerGraph, ExportSymbol, GraphEdge, GraphNode } from '../contracts/types.js'
import type { GraphDiff } from './diff.js'
import {
  buildSemanticSnapshot,
  semanticEdgeKey,
  type SemanticEdge,
  type SemanticLevel,
  type SemanticSnapshot,
  type SemanticUnit,
} from './semanticMembership.js'

export const IMPACT_PROJECTION_SCHEMA_VERSION = 1
export const IMPACT_PROJECTION_NODE_LIMIT = 60
export const IMPACT_PROJECTION_EDGE_LIMIT = 120
export const IMPACT_PROJECTION_EVIDENCE_LIMIT = 200
export const IMPACT_PROJECTION_EVIDENCE_PATH_LIMIT = 25
export const IMPACT_PROJECTION_LAYOUT_VERSION = 'semantic-impact-v1'

export type ImpactProjectionLevel = SemanticLevel
export type ImpactProjectionState = 'added' | 'removed' | 'affected' | 'context'
type ChangedProjectionState = Exclude<ImpactProjectionState, 'context'>
type SnapshotSide = 'base' | 'head'

export interface ImpactProjectionExactCount
{
  total: number
  returned: number
  omitted: number
}

export interface ImpactProjectionPosition
{
  x: number
  y: number
}

export interface ImpactProjectionEvidence
{
  id: string
  kind: 'file' | 'relationship' | 'api' | 'violation' | 'move'
  state: ChangedProjectionState
  label: string
  paths: string[]
  pathRefs?: Array<{ path: string; side: 'base' | 'head' }>
}

export interface ImpactProjectionNode
{
  id: string
  label: string
  semanticLevel: ImpactProjectionLevel
  parentId?: string
  relativePath?: string
  position: ImpactProjectionPosition
  tintKey: string
  state: ImpactProjectionState
  stateLabel: 'Added' | 'Removed' | 'Affected' | 'Context'
  badge: 'plus' | 'minus' | 'affected' | 'context'
  stroke: 'solid' | 'dashed' | 'double' | 'muted'
  fileCount: number
  inbound: number
  outbound: number
  affectedConsumerCount: number
  evidenceRefs: string[]
}

export interface ImpactProjectionEdge
{
  id: string
  from: string
  to: string
  relationshipKind: 'imports'
  weight: number
  state: ImpactProjectionState
  stateLabel: 'Added' | 'Removed' | 'Affected' | 'Context'
  stroke: 'solid' | 'dashed' | 'double' | 'muted'
  evidenceRefs: string[]
}

export interface ImpactProjectionBreadcrumb
{
  id: string
  label: string
  level: ImpactProjectionLevel
}

export interface VerifiedImpactProjectionArtifact
{
  version: typeof IMPACT_PROJECTION_SCHEMA_VERSION
  kind: 'impact-diff'
  authority: 'verified'
  resultState: 'graph' | 'no-impact'
  generatedAt: string
  analyzerFingerprint: string
  baseGitRef: string
  headGitRef: string
  baseGraphDigest: `sha256:${string}`
  headGraphDigest: `sha256:${string}`
  rawImpactDigest: `sha256:${string}`
  implementationChangedFileCount: number
  lens: 'architecture' | 'structure'
  semanticLevel: ImpactProjectionLevel
  breadcrumbs: ImpactProjectionBreadcrumb[]
  layoutVersion: typeof IMPACT_PROJECTION_LAYOUT_VERSION
  totals: {
    nodes: ImpactProjectionExactCount
    edges: ImpactProjectionExactCount
    evidence: ImpactProjectionExactCount
    changedFiles: ImpactProjectionExactCount
  }
  nodes: ImpactProjectionNode[]
  edges: ImpactProjectionEdge[]
  evidence: ImpactProjectionEvidence[]
}

export interface BuildVerifiedImpactProjectionInput
{
  base: CartographerGraph
  head: CartographerGraph
  diff: GraphDiff
  baseGraphDigest: `sha256:${string}`
  headGraphDigest: `sha256:${string}`
  rawImpactDigest: `sha256:${string}`
  analyzerFingerprint: string
  implementationChangedFileCount: number
}

interface PathReference
{
  path: string
  side: SnapshotSide
}

interface EvidenceDraft
{
  kind: ImpactProjectionEvidence['kind']
  state: ChangedProjectionState
  label: string
  targets: PathReference[]
  consumers: PathReference[]
  directMembers?: Partial<Record<ImpactProjectionLevel, string[]>>
  relationship?: {
    base?: [string, string]
    head?: [string, string]
  }
}

interface MaterializedEvidence
{
  value: ImpactProjectionEvidence
  targetMembers: Record<ImpactProjectionLevel, Set<string>>
  consumerMembers: Record<ImpactProjectionLevel, Set<string>>
  consumerFiles: Set<string>
  relationshipMembers: Partial<Record<ImpactProjectionLevel, Set<string>>>
}

interface CanonicalEdge
{
  from: string
  to: string
  rawFrom: string
  rawTo: string
  side: SnapshotSide
  metadata: string
}

interface SideUnit
{
  unit: SemanticUnit
  side: SnapshotSide
}

const LEVELS: ImpactProjectionLevel[] = ['systems', 'blocks', 'dirs', 'files']

function hash(...values: string[]): string
{
  const digest = NodeCrypto.createHash('sha256')
  for (const value of values)
  {
    digest.update(value)
    digest.update('\0')
  }
  return digest.digest('hex')
}

function exactCount(total: number, returned: number): ImpactProjectionExactCount
{
  return { total, returned, omitted: total - returned }
}

function compareText(left: string, right: string): number
{
  return left < right ? -1 : left > right ? 1 : 0
}

function uniqueSorted(values: Iterable<string>): string[]
{
  return [...new Set(values)].sort(compareText)
}

function canonicalExport(symbol: ExportSymbol): string
{
  return JSON.stringify([
    symbol.name,
    symbol.typeOnly === true,
    symbol.reExport === true,
    symbol.kind ?? null,
    symbol.signature ?? null,
  ])
}

function canonicalExports(node: GraphNode): string[] | undefined
{
  if (node.exports === undefined) return undefined
  return node.exports.map(canonicalExport).sort(compareText)
}

function exportNameShapes(node: GraphNode): Map<string, string>
{
  return new Map((node.exports ?? []).map((symbol) => [symbol.name, canonicalExport(symbol)]))
}

function canonicalImportMetadata(edge: GraphEdge): string
{
  return JSON.stringify([
    edge.dynamic === true,
    edge.typeOnly === true,
    uniqueSorted(edge.symbols ?? []),
    uniqueSorted(edge.typeSymbols ?? []),
  ])
}

function canonicalEdges(
  graph: CartographerGraph,
  side: SnapshotSide,
  remap: (path: string) => string,
): Map<string, CanonicalEdge>
{
  const result = new Map<string, CanonicalEdge>()
  for (const edge of graph.edges)
  {
    const canonical: CanonicalEdge = {
      from: remap(edge.from),
      to: remap(edge.to),
      rawFrom: edge.from,
      rawTo: edge.to,
      side,
      metadata: canonicalImportMetadata(edge),
    }
    const key = semanticEdgeKey(canonical.from, canonical.to)
    if (result.has(key))
    {
      throw new Error(`impact projection has duplicate canonical relationship ${key}`)
    }
    result.set(key, canonical)
  }
  return result
}

function incomingEdges(graph: CartographerGraph): Map<string, GraphEdge[]>
{
  const incoming = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges)
  {
    const current = incoming.get(edge.to) ?? []
    current.push(edge)
    incoming.set(edge.to, current)
  }
  return incoming
}

function consumersForNames(
  incoming: ReadonlyMap<string, GraphEdge[]>,
  target: string,
  names: ReadonlySet<string>,
): string[]
{
  const consumers = new Set<string>()
  for (const edge of incoming.get(target) ?? [])
  {
    if (
      edge.symbols === undefined ||
      edge.symbols.length === 0 ||
      edge.symbols.some((symbol) => names.has(symbol))
    )
    {
      consumers.add(edge.from)
    }
  }
  return [...consumers].sort(compareText)
}

function membershipDrafts(input: {
  base: CartographerGraph
  head: CartographerGraph
  baseSnapshot: SemanticSnapshot
  headSnapshot: SemanticSnapshot
  moveMap: ReadonlyMap<string, string>
}): EvidenceDraft[]
{
  const headNodes = new Map(input.head.nodes.map((node) => [node.id, node]))
  const drafts: EvidenceDraft[] = []
  for (const baseNode of input.base.nodes)
  {
    const headPath = input.moveMap.get(baseNode.id) ?? baseNode.id
    if (!headNodes.has(headPath)) continue
    const changedLevels = LEVELS.filter((level) =>
    {
      if (level === 'files') return false
      return (
        input.baseSnapshot.memberships[level].get(baseNode.id) !==
        input.headSnapshot.memberships[level].get(headPath)
      )
    })
    if (changedLevels.length === 0) continue
    drafts.push({
      kind: 'file',
      state: 'affected',
      label: `Semantic membership changed for ${headPath}`,
      targets: [
        { path: baseNode.id, side: 'base' },
        { path: headPath, side: 'head' },
      ],
      consumers: [],
    })
  }
  return drafts
}

function publicApiDrafts(input: {
  base: CartographerGraph
  head: CartographerGraph
  moveMap: ReadonlyMap<string, string>
}): EvidenceDraft[]
{
  const headByPath = new Map(input.head.nodes.map((node) => [node.id, node]))
  const baseIncoming = incomingEdges(input.base)
  const headIncoming = incomingEdges(input.head)
  const drafts: EvidenceDraft[] = []
  for (const baseNode of input.base.nodes)
  {
    const headPath = input.moveMap.get(baseNode.id) ?? baseNode.id
    const headNode = headByPath.get(headPath)
    if (headNode === undefined) continue
    const baseExports = canonicalExports(baseNode)
    const headExports = canonicalExports(headNode)
    if (baseExports === undefined || headExports === undefined)
    {
      if (baseExports !== headExports)
      {
        throw new Error(`impact projection cannot compare incomplete public API for ${headPath}`)
      }
      continue
    }
    if (JSON.stringify(baseExports) === JSON.stringify(headExports)) continue
    const baseShapes = exportNameShapes(baseNode)
    const headShapes = exportNameShapes(headNode)
    const changedNames = new Set(
      uniqueSorted([...baseShapes.keys(), ...headShapes.keys()]).filter(
        (name) => baseShapes.get(name) !== headShapes.get(name),
      ),
    )
    const baseConsumers = consumersForNames(baseIncoming, baseNode.id, changedNames)
    const headConsumers = consumersForNames(headIncoming, headPath, changedNames)
    drafts.push({
      kind: 'api',
      state: 'affected',
      label: `Public API changed in ${headPath}`,
      targets: [
        { path: baseNode.id, side: 'base' },
        { path: headPath, side: 'head' },
      ],
      consumers: [
        ...baseConsumers.map((path): PathReference => ({ path, side: 'base' })),
        ...headConsumers.map((path): PathReference => ({ path, side: 'head' })),
      ],
    })
  }
  return drafts
}

function relationshipDrafts(input: {
  base: CartographerGraph
  head: CartographerGraph
  moveMap: ReadonlyMap<string, string>
}): EvidenceDraft[]
{
  const baseEdges = canonicalEdges(input.base, 'base', (path) => input.moveMap.get(path) ?? path)
  const headEdges = canonicalEdges(input.head, 'head', (path) => path)
  const keys = uniqueSorted([...baseEdges.keys(), ...headEdges.keys()])
  const drafts: EvidenceDraft[] = []
  for (const key of keys)
  {
    const base = baseEdges.get(key)
    const head = headEdges.get(key)
    if (base !== undefined && head !== undefined && base.metadata === head.metadata) continue
    const state: ChangedProjectionState =
      base === undefined ? 'added' : head === undefined ? 'removed' : 'affected'
    const preferred = head ?? base!
    const targets: PathReference[] = []
    if (base !== undefined)
    {
      targets.push({ path: base.rawFrom, side: 'base' }, { path: base.rawTo, side: 'base' })
    }
    if (head !== undefined)
    {
      targets.push({ path: head.rawFrom, side: 'head' }, { path: head.rawTo, side: 'head' })
    }
    drafts.push({
      kind: 'relationship',
      state,
      label:
        state === 'affected'
          ? `Import metadata changed from ${preferred.from} to ${preferred.to}`
          : `Import ${state} from ${preferred.from} to ${preferred.to}`,
      targets,
      consumers: [{ path: preferred.rawFrom, side: preferred.side }],
      relationship: {
        ...(base === undefined ? {} : { base: [base.rawFrom, base.rawTo] }),
        ...(head === undefined ? {} : { head: [head.rawFrom, head.rawTo] }),
      },
    })
  }
  return drafts
}

function violationIdentities(
  graph: CartographerGraph,
  side: SnapshotSide,
  remap: (path: string) => string,
): Map<
  string,
  { from: string; to: string; rawFrom: string; rawTo: string; rule: string; side: SnapshotSide }
>
{
  const result = new Map<
    string,
    { from: string; to: string; rawFrom: string; rawTo: string; rule: string; side: SnapshotSide }
  >()
  const severity = new Map((graph.rules ?? []).map((rule) => [rule.id, rule.severity]))
  for (const edge of graph.edges)
  {
    for (const rule of edge.violations ?? [])
    {
      const value = {
        from: remap(edge.from),
        to: remap(edge.to),
        rawFrom: edge.from,
        rawTo: edge.to,
        rule,
        side,
      }
      const key = JSON.stringify([value.from, value.to, rule, severity.get(rule) ?? 'error'])
      result.set(key, value)
    }
  }
  return result
}

function violationDrafts(input: {
  base: CartographerGraph
  head: CartographerGraph
  moveMap: ReadonlyMap<string, string>
}): EvidenceDraft[]
{
  const base = violationIdentities(input.base, 'base', (path) => input.moveMap.get(path) ?? path)
  const head = violationIdentities(input.head, 'head', (path) => path)
  const drafts: EvidenceDraft[] = []
  for (const key of uniqueSorted([...base.keys(), ...head.keys()]))
  {
    const before = base.get(key)
    const after = head.get(key)
    if ((before === undefined) === (after === undefined)) continue
    const value = after ?? before!
    const state: ChangedProjectionState = after === undefined ? 'removed' : 'added'
    drafts.push({
      kind: 'violation',
      state,
      label: `${state === 'added' ? 'New' : 'Resolved'} ${value.rule} violation from ${value.from} to ${value.to}`,
      targets: [
        { path: value.rawFrom, side: value.side },
        { path: value.rawTo, side: value.side },
      ],
      consumers: [{ path: value.rawFrom, side: value.side }],
      relationship: {
        ...(before === undefined ? {} : { base: [before.rawFrom, before.rawTo] }),
        ...(after === undefined ? {} : { head: [after.rawFrom, after.rawTo] }),
      },
    })
  }
  return drafts
}

function labelDrafts(input: {
  base: CartographerGraph
  head: CartographerGraph
  baseSnapshot: SemanticSnapshot
  headSnapshot: SemanticSnapshot
}): EvidenceDraft[]
{
  const drafts: EvidenceDraft[] = []
  for (const level of ['systems', 'blocks'] as const)
  {
    const before = input.baseSnapshot.units[level]
    const after = input.headSnapshot.units[level]
    for (const id of uniqueSorted([...before.keys(), ...after.keys()]))
    {
      const baseUnit = before.get(id)
      const headUnit = after.get(id)
      if (baseUnit === undefined || headUnit === undefined || baseUnit.label === headUnit.label)
        continue
      drafts.push({
        kind: 'file',
        state: 'affected',
        label: `${level === 'systems' ? 'System' : 'Block'} label changed from ${baseUnit.label} to ${headUnit.label}`,
        targets: [],
        consumers: [],
        directMembers: { [level]: [id] },
      })
    }
  }
  return drafts
}

function validateMoveMap(input: BuildVerifiedImpactProjectionInput): Map<string, string>
{
  const base = new Set(input.base.nodes.map((node) => node.id))
  const head = new Set(input.head.nodes.map((node) => node.id))
  const from = new Set<string>()
  const to = new Set<string>()
  const pairs = [...input.diff.movedNodes].sort(
    (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to),
  )
  for (const move of pairs)
  {
    if (!base.has(move.from) || !head.has(move.to) || from.has(move.from) || to.has(move.to))
    {
      throw new Error('impact projection received an invalid move identity')
    }
    from.add(move.from)
    to.add(move.to)
  }
  return new Map(pairs.map((move) => [move.from, move.to]))
}

function allDrafts(input: {
  source: BuildVerifiedImpactProjectionInput
  baseSnapshot: SemanticSnapshot
  headSnapshot: SemanticSnapshot
  moveMap: ReadonlyMap<string, string>
}): EvidenceDraft[]
{
  const baseIds = new Set(
    input.source.base.nodes.map((node) => input.moveMap.get(node.id) ?? node.id),
  )
  const headIds = new Set(input.source.head.nodes.map((node) => node.id))
  const drafts: EvidenceDraft[] = []
  for (const node of input.source.head.nodes)
  {
    if (!baseIds.has(node.id))
    {
      drafts.push({
        kind: 'file',
        state: 'added',
        label: `Added ${node.id}`,
        targets: [{ path: node.id, side: 'head' }],
        consumers: [],
      })
    }
  }
  for (const node of input.source.base.nodes)
  {
    const canonical = input.moveMap.get(node.id) ?? node.id
    if (!headIds.has(canonical))
    {
      drafts.push({
        kind: 'file',
        state: 'removed',
        label: `Removed ${node.id}`,
        targets: [{ path: node.id, side: 'base' }],
        consumers: [],
      })
    }
  }
  for (const [from, to] of input.moveMap)
  {
    drafts.push({
      kind: 'move',
      state: 'affected',
      label: `Moved ${from} to ${to}`,
      targets: [
        { path: from, side: 'base' },
        { path: to, side: 'head' },
      ],
      consumers: [],
    })
  }
  drafts.push(
    ...membershipDrafts({
      base: input.source.base,
      head: input.source.head,
      baseSnapshot: input.baseSnapshot,
      headSnapshot: input.headSnapshot,
      moveMap: input.moveMap,
    }),
    ...publicApiDrafts({
      base: input.source.base,
      head: input.source.head,
      moveMap: input.moveMap,
    }),
    ...relationshipDrafts({
      base: input.source.base,
      head: input.source.head,
      moveMap: input.moveMap,
    }),
    ...violationDrafts({
      base: input.source.base,
      head: input.source.head,
      moveMap: input.moveMap,
    }),
    ...labelDrafts({
      base: input.source.base,
      head: input.source.head,
      baseSnapshot: input.baseSnapshot,
      headSnapshot: input.headSnapshot,
    }),
  )
  return drafts.sort(
    (left, right) =>
      stateRank(left.state) - stateRank(right.state) ||
      compareText(left.kind, right.kind) ||
      compareText(left.label, right.label),
  )
}

function canonicalFile(
  path: string,
  side: SnapshotSide,
  moveMap: ReadonlyMap<string, string>,
): string
{
  return side === 'base' ? (moveMap.get(path) ?? path) : path
}

function memberForReference(input: {
  reference: PathReference
  level: ImpactProjectionLevel
  baseSnapshot: SemanticSnapshot
  headSnapshot: SemanticSnapshot
  moveMap: ReadonlyMap<string, string>
}): string | undefined
{
  if (input.level === 'files')
  {
    const snapshot = input.reference.side === 'base' ? input.baseSnapshot : input.headSnapshot
    if (!snapshot.memberships.files.has(input.reference.path)) return undefined
    return canonicalFile(input.reference.path, input.reference.side, input.moveMap)
  }
  const snapshot = input.reference.side === 'base' ? input.baseSnapshot : input.headSnapshot
  return snapshot.memberships[input.level].get(input.reference.path)
}

function materializeEvidence(input: {
  drafts: readonly EvidenceDraft[]
  baseSnapshot: SemanticSnapshot
  headSnapshot: SemanticSnapshot
  moveMap: ReadonlyMap<string, string>
}): MaterializedEvidence[]
{
  const materialized = input.drafts.map((draft) =>
  {
    const targetMembers = Object.fromEntries(
      LEVELS.map((level) => [level, new Set<string>()]),
    ) as Record<ImpactProjectionLevel, Set<string>>
    const consumerMembers = Object.fromEntries(
      LEVELS.map((level) => [level, new Set<string>()]),
    ) as Record<ImpactProjectionLevel, Set<string>>
    for (const level of LEVELS)
    {
      for (const id of draft.directMembers?.[level] ?? []) targetMembers[level].add(id)
      for (const reference of draft.targets)
      {
        const member = memberForReference({ ...input, reference, level })
        if (member !== undefined) targetMembers[level].add(member)
      }
      for (const reference of draft.consumers)
      {
        const member = memberForReference({ ...input, reference, level })
        if (member !== undefined) consumerMembers[level].add(member)
      }
    }
    const relationshipMembers: Partial<Record<ImpactProjectionLevel, Set<string>>> = {}
    for (const level of LEVELS)
    {
      const pairs = new Set<string>()
      for (const [side, endpoints] of [
        ['base', draft.relationship?.base] as const,
        ['head', draft.relationship?.head] as const,
      ])
      {
        if (endpoints === undefined) continue
        const from = memberForReference({
          ...input,
          reference: { path: endpoints[0], side },
          level,
        })
        const to = memberForReference({
          ...input,
          reference: { path: endpoints[1], side },
          level,
        })
        if (from !== undefined && to !== undefined && from !== to)
        {
          pairs.add(semanticEdgeKey(from, to))
        }
      }
      if (pairs.size > 0) relationshipMembers[level] = pairs
    }
    if (LEVELS.every((level) => targetMembers[level].size === 0))
    {
      throw new Error(`impact projection could not resolve evidence: ${draft.label}`)
    }
    const references = [...draft.targets, ...draft.consumers]
    const paths = uniqueSorted(references.map((reference) => reference.path))
    const returnedPaths = paths.slice(0, IMPACT_PROJECTION_EVIDENCE_PATH_LIMIT)
    const returnedPathSet = new Set(returnedPaths)
    const pathRefs = [
      ...new Map(
        references
          .filter((reference) => returnedPathSet.has(reference.path))
          .map((reference) => [`${reference.side}\0${reference.path}`, reference] as const),
      ).values(),
    ].sort(
      (left, right) => compareText(left.path, right.path) || compareText(left.side, right.side),
    )
    const id = `evidence:${hash(draft.kind, draft.state, draft.label, JSON.stringify(paths))}`
    return {
      value: {
        id,
        kind: draft.kind,
        state: draft.state,
        label: draft.label,
        paths: returnedPaths,
        pathRefs,
      },
      targetMembers,
      consumerMembers,
      consumerFiles: new Set(
        draft.consumers.map((reference) =>
          canonicalFile(reference.path, reference.side, input.moveMap),
        ),
      ),
      relationshipMembers,
    }
  })
  const unique = new Map<string, MaterializedEvidence>()
  for (const item of materialized) unique.set(item.value.id, item)
  return [...unique.values()]
}

function chooseLevel(evidence: readonly MaterializedEvidence[]): ImpactProjectionLevel
{
  const membersByLevel = new Map<ImpactProjectionLevel, Set<string>>()
  for (const level of LEVELS)
  {
    const members = new Set<string>()
    for (const item of evidence)
    {
      for (const id of item.targetMembers[level]) members.add(id)
      for (const id of item.consumerMembers[level]) members.add(id)
    }
    membersByLevel.set(level, members)
  }
  if (membersByLevel.get('systems')!.size > 1) return 'systems'
  if (membersByLevel.get('blocks')!.size > 1) return 'blocks'
  if (membersByLevel.get('dirs')!.size > 1) return 'dirs'
  if (membersByLevel.get('files')!.size > 0) return 'files'
  return LEVELS.find((level) => membersByLevel.get(level)!.size > 0) ?? 'files'
}

function remapSemanticEdges(
  edges: ReadonlyMap<string, SemanticEdge>,
  level: ImpactProjectionLevel,
  moveMap: ReadonlyMap<string, string>,
): Map<string, SemanticEdge>
{
  if (level !== 'files') return new Map(edges)
  const result = new Map<string, SemanticEdge>()
  for (const edge of edges.values())
  {
    const from = moveMap.get(edge.from) ?? edge.from
    const to = moveMap.get(edge.to) ?? edge.to
    if (from === to) continue
    const key = semanticEdgeKey(from, to)
    const current = result.get(key)
    result.set(key, { from, to, weight: (current?.weight ?? 0) + edge.weight })
  }
  return result
}

function remapBaseUnits(
  snapshot: SemanticSnapshot,
  level: ImpactProjectionLevel,
  moveMap: ReadonlyMap<string, string>,
): Map<string, SemanticUnit>
{
  if (level !== 'files') return new Map(snapshot.units[level])
  const result = new Map<string, SemanticUnit>()
  for (const unit of snapshot.units.files.values())
  {
    const id = moveMap.get(unit.id) ?? unit.id
    result.set(id, { ...unit, id, key: id })
  }
  return result
}

function stateRank(state: ImpactProjectionState): number
{
  switch (state)
  {
    case 'added':
      return 0
    case 'removed':
      return 1
    case 'affected':
      return 2
    case 'context':
      return 3
  }
}

function treatment(state: ImpactProjectionState): {
  stateLabel: ImpactProjectionNode['stateLabel']
  badge: ImpactProjectionNode['badge']
  stroke: ImpactProjectionNode['stroke']
}
{
  switch (state)
  {
    case 'added':
      return { stateLabel: 'Added', badge: 'plus', stroke: 'solid' }
    case 'removed':
      return { stateLabel: 'Removed', badge: 'minus', stroke: 'dashed' }
    case 'affected':
      return { stateLabel: 'Affected', badge: 'affected', stroke: 'double' }
    case 'context':
      return { stateLabel: 'Context', badge: 'context', stroke: 'muted' }
  }
}

function edgeTreatment(
  state: ImpactProjectionState,
): Pick<ImpactProjectionEdge, 'stateLabel' | 'stroke'>
{
  const value = treatment(state)
  return { stateLabel: value.stateLabel, stroke: value.stroke }
}

function sideUnit(
  id: string,
  baseUnits: ReadonlyMap<string, SemanticUnit>,
  headUnits: ReadonlyMap<string, SemanticUnit>,
): { base?: SideUnit; head?: SideUnit }
{
  const base = baseUnits.get(id)
  const head = headUnits.get(id)
  return {
    ...(base === undefined ? {} : { base: { unit: base, side: 'base' as const } }),
    ...(head === undefined ? {} : { head: { unit: head, side: 'head' as const } }),
  }
}

function combineNodes(input: {
  level: ImpactProjectionLevel
  evidence: readonly MaterializedEvidence[]
  baseSnapshot: SemanticSnapshot
  headSnapshot: SemanticSnapshot
  moveMap: ReadonlyMap<string, string>
}): {
  nodes: ImpactProjectionNode[]
  focus: Set<string>
  baseEdges: Map<string, SemanticEdge>
  headEdges: Map<string, SemanticEdge>
  relationshipEvidence: Map<string, Set<string>>
}
{
  const baseUnits = remapBaseUnits(input.baseSnapshot, input.level, input.moveMap)
  const headUnits = input.headSnapshot.units[input.level]
  const baseEdges = remapSemanticEdges(
    input.baseSnapshot.edges[input.level],
    input.level,
    input.moveMap,
  )
  const headEdges = input.headSnapshot.edges[input.level]
  const focus = new Set<string>()
  const evidenceByNode = new Map<string, Set<string>>()
  const consumersByTarget = new Map<string, Set<string>>()
  const relationshipEvidence = new Map<string, Set<string>>()
  const addReference = (id: string, evidenceId: string): void =>
  {
    focus.add(id)
    const refs = evidenceByNode.get(id) ?? new Set<string>()
    refs.add(evidenceId)
    evidenceByNode.set(id, refs)
  }
  for (const item of input.evidence)
  {
    for (const id of item.targetMembers[input.level])
    {
      addReference(id, item.value.id)
      const consumers = consumersByTarget.get(id) ?? new Set<string>()
      for (const consumer of item.consumerFiles)
      {
        consumers.add(consumer)
      }
      consumersByTarget.set(id, consumers)
    }
    for (const id of item.consumerMembers[input.level]) addReference(id, item.value.id)
    for (const key of item.relationshipMembers[input.level] ?? [])
    {
      const refs = relationshipEvidence.get(key) ?? new Set<string>()
      refs.add(item.value.id)
      relationshipEvidence.set(key, refs)
    }
  }
  const changedFocus = new Set(focus)
  for (const edges of [baseEdges, headEdges])
  {
    for (const edge of edges.values())
    {
      if (changedFocus.has(edge.from) || changedFocus.has(edge.to))
      {
        focus.add(edge.from)
        focus.add(edge.to)
      }
    }
  }
  const nodes: ImpactProjectionNode[] = []
  for (const id of focus)
  {
    const available = sideUnit(id, baseUnits, headUnits)
    if (available.base === undefined && available.head === undefined)
    {
      throw new Error(`impact projection references missing semantic unit ${id}`)
    }
    const changed = evidenceByNode.has(id)
    const state: ImpactProjectionState =
      available.base === undefined
        ? 'added'
        : available.head === undefined
          ? 'removed'
          : changed
            ? 'affected'
            : 'context'
    const display = available.head?.unit ?? available.base!.unit
    const positioned = available.base?.unit ?? available.head!.unit
    const visual = treatment(state)
    nodes.push({
      id,
      label: display.label,
      semanticLevel: input.level,
      ...(display.parentId === undefined ? {} : { parentId: display.parentId }),
      ...(display.relativePath === undefined || display.relativePath === '.'
        ? {}
        : { relativePath: display.relativePath }),
      position: positioned.position,
      tintKey: hash(id).slice(0, 12),
      state,
      ...visual,
      fileCount: display.fileCount,
      inbound: display.inbound,
      outbound: display.outbound,
      affectedConsumerCount: consumersByTarget.get(id)?.size ?? 0,
      evidenceRefs: uniqueSorted(evidenceByNode.get(id) ?? []),
    })
  }
  nodes.sort(
    (left, right) =>
      stateRank(left.state) - stateRank(right.state) ||
      right.affectedConsumerCount - left.affectedConsumerCount ||
      right.inbound + right.outbound - (left.inbound + left.outbound) ||
      compareText(left.id, right.id),
  )
  return { nodes, focus, baseEdges, headEdges, relationshipEvidence }
}

function combineEdges(input: {
  focus: ReadonlySet<string>
  baseEdges: ReadonlyMap<string, SemanticEdge>
  headEdges: ReadonlyMap<string, SemanticEdge>
  relationshipEvidence: ReadonlyMap<string, Set<string>>
}): ImpactProjectionEdge[]
{
  const result: ImpactProjectionEdge[] = []
  const keys = uniqueSorted([...input.baseEdges.keys(), ...input.headEdges.keys()])
  for (const key of keys)
  {
    const base = input.baseEdges.get(key)
    const head = input.headEdges.get(key)
    const edge = head ?? base!
    if (!input.focus.has(edge.from) || !input.focus.has(edge.to)) continue
    let state: ImpactProjectionState = 'context'
    if (base === undefined) state = 'added'
    else if (head === undefined) state = 'removed'
    else if (base.weight !== head.weight || input.relationshipEvidence.has(key)) state = 'affected'
    result.push({
      id: `edge:${hash(edge.from, edge.to, 'imports')}`,
      from: edge.from,
      to: edge.to,
      relationshipKind: 'imports',
      weight: head?.weight ?? base!.weight,
      state,
      ...edgeTreatment(state),
      evidenceRefs: uniqueSorted(input.relationshipEvidence.get(key) ?? []),
    })
  }
  return result.sort(
    (left, right) =>
      stateRank(left.state) - stateRank(right.state) ||
      right.weight - left.weight ||
      compareText(left.id, right.id),
  )
}

function noImpactArtifact(
  input: BuildVerifiedImpactProjectionInput,
): VerifiedImpactProjectionArtifact
{
  return {
    version: IMPACT_PROJECTION_SCHEMA_VERSION,
    kind: 'impact-diff',
    authority: 'verified',
    resultState: 'no-impact',
    generatedAt: input.head.generatedAt,
    analyzerFingerprint: input.analyzerFingerprint,
    baseGitRef: input.base.gitRef!,
    headGitRef: input.head.gitRef!,
    baseGraphDigest: input.baseGraphDigest,
    headGraphDigest: input.headGraphDigest,
    rawImpactDigest: input.rawImpactDigest,
    implementationChangedFileCount: input.implementationChangedFileCount,
    lens: 'structure',
    semanticLevel: 'files',
    breadcrumbs: [],
    layoutVersion: IMPACT_PROJECTION_LAYOUT_VERSION,
    totals: {
      nodes: exactCount(0, 0),
      edges: exactCount(0, 0),
      evidence: exactCount(0, 0),
      changedFiles: exactCount(input.implementationChangedFileCount, 0),
    },
    nodes: [],
    edges: [],
    evidence: [],
  }
}

export function buildVerifiedImpactProjection(
  input: BuildVerifiedImpactProjectionInput,
): VerifiedImpactProjectionArtifact
{
  if (
    !Number.isSafeInteger(input.implementationChangedFileCount) ||
    input.implementationChangedFileCount < 0
  )
  {
    throw new Error('implementationChangedFileCount must be a non-negative safe integer')
  }
  if (input.base.gitRef === undefined || input.head.gitRef === undefined)
  {
    throw new Error('impact projection requires exact base and head Git refs')
  }
  if (
    (input.diff.baseGitRef !== undefined && input.diff.baseGitRef !== input.base.gitRef) ||
    (input.diff.headGitRef !== undefined && input.diff.headGitRef !== input.head.gitRef)
  )
  {
    throw new Error('impact projection graph and raw impact refs do not match')
  }
  const moveMap = validateMoveMap(input)
  const baseSnapshot = buildSemanticSnapshot(input.base)
  const headSnapshot = buildSemanticSnapshot(input.head)
  const drafts = allDrafts({ source: input, baseSnapshot, headSnapshot, moveMap })
  if (drafts.length === 0) return noImpactArtifact(input)
  const materialized = materializeEvidence({ drafts, baseSnapshot, headSnapshot, moveMap })
  const semanticLevel = chooseLevel(materialized)
  const combined = combineNodes({
    level: semanticLevel,
    evidence: materialized,
    baseSnapshot,
    headSnapshot,
    moveMap,
  })
  const completeEdges = combineEdges(combined)
  const returnedEvidence = materialized
    .map((item) => item.value)
    .slice(0, IMPACT_PROJECTION_EVIDENCE_LIMIT)
  const returnedEvidenceIds = new Set(returnedEvidence.map((item) => item.id))
  const returnedNodes = combined.nodes.slice(0, IMPACT_PROJECTION_NODE_LIMIT).map((node) => ({
    ...node,
    evidenceRefs: node.evidenceRefs.filter((ref) => returnedEvidenceIds.has(ref)),
  }))
  const returnedNodeIds = new Set(returnedNodes.map((node) => node.id))
  const returnedEdges = completeEdges
    .filter((edge) => returnedNodeIds.has(edge.from) && returnedNodeIds.has(edge.to))
    .slice(0, IMPACT_PROJECTION_EDGE_LIMIT)
    .map((edge) => ({
      ...edge,
      evidenceRefs: edge.evidenceRefs.filter((ref) => returnedEvidenceIds.has(ref)),
    }))
  return {
    version: IMPACT_PROJECTION_SCHEMA_VERSION,
    kind: 'impact-diff',
    authority: 'verified',
    resultState: 'graph',
    generatedAt: input.head.generatedAt,
    analyzerFingerprint: input.analyzerFingerprint,
    baseGitRef: input.base.gitRef,
    headGitRef: input.head.gitRef,
    baseGraphDigest: input.baseGraphDigest,
    headGraphDigest: input.headGraphDigest,
    rawImpactDigest: input.rawImpactDigest,
    implementationChangedFileCount: input.implementationChangedFileCount,
    lens: semanticLevel === 'systems' || semanticLevel === 'blocks' ? 'architecture' : 'structure',
    semanticLevel,
    // scope breadcrumbs are added by the authority-aware server projection.
    breadcrumbs: [],
    layoutVersion: IMPACT_PROJECTION_LAYOUT_VERSION,
    totals: {
      nodes: exactCount(combined.nodes.length, returnedNodes.length),
      edges: exactCount(completeEdges.length, returnedEdges.length),
      evidence: exactCount(materialized.length, returnedEvidence.length),
      changedFiles: exactCount(input.implementationChangedFileCount, 0),
    },
    nodes: returnedNodes,
    edges: returnedEdges,
    evidence: returnedEvidence,
  }
}
