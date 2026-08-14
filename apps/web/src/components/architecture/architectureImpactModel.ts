// apps/web/src/components/architecture/architectureImpactModel.ts
// builds a truthful fixed-union model from bounded architecture impact evidence

import type {
  ArchitectureFileApiChange,
  ArchitectureImpactResult,
  ArchitectureImpactResultV2,
} from '@t3tools/contracts'

import type { ArchitectureFileSource } from './architectureResourceIdentity'

export type ArchitectureImpactView = 'before' | 'diff' | 'after'

export type ArchitectureImpactNodeKind =
  | 'added'
  | 'removed'
  | 'moved-from'
  | 'moved-to'
  | 'move-flow-from'
  | 'move-flow-to'
  | 'api'
  | 'context'

export type ArchitectureImpactNodeEntity = 'file' | 'directory'

export type ArchitectureImpactEdgeKind =
  'added-import' | 'removed-import' | 'move' | 'move-flow' | 'new-violation' | 'resolved-violation'

export interface ArchitectureImpactBoundedStrings
{
  readonly items: readonly string[]
  readonly total: number
  readonly omitted: number
}

export interface ArchitectureImpactExportEvidence
{
  readonly name: string
  readonly typeOnly: boolean
  readonly brokenConsumers: ArchitectureImpactBoundedStrings | null
}

export interface ArchitectureImpactExportList
{
  readonly items: readonly ArchitectureImpactExportEvidence[]
  readonly total: number
  readonly omitted: number
}

export interface ArchitectureImpactApiEvidence
{
  readonly addedExports: ArchitectureImpactExportList
  readonly removedExports: ArchitectureImpactExportList
}

export interface ArchitectureImpactNode
{
  readonly id: string
  readonly path: string
  readonly entity: ArchitectureImpactNodeEntity
  readonly base: boolean
  readonly head: boolean
  readonly kinds: readonly ArchitectureImpactNodeKind[]
  readonly api: ArchitectureImpactApiEvidence | null
}

export interface ArchitectureImpactEdge
{
  readonly id: string
  readonly from: string
  readonly to: string
  readonly base: boolean
  readonly head: boolean
  readonly kind: ArchitectureImpactEdgeKind
  readonly rule: string | null
  readonly severity: 'error' | 'warn' | 'info' | null
  readonly count: number | null
}

export interface ArchitectureImpactOmission
{
  readonly label: string
  readonly count: number
}

export interface ArchitectureImpactModel
{
  readonly nodes: readonly ArchitectureImpactNode[]
  readonly edges: readonly ArchitectureImpactEdge[]
  readonly omissions: readonly ArchitectureImpactOmission[]
  readonly baseSource: ArchitectureFileSource | null
  readonly headSource: ArchitectureFileSource | null
}

interface MutableNode
{
  readonly path: string
  entity: ArchitectureImpactNodeEntity
  base: boolean
  head: boolean
  readonly kinds: Set<ArchitectureImpactNodeKind>
  api: ArchitectureImpactApiEvidence | null
}

function impactHasSources(result: ArchitectureImpactResult): result is ArchitectureImpactResultV2
{
  return result.version === 2
}

function nodeId(path: string): string
{
  return `impact-node:${encodeURIComponent(path)}`
}

function edgeId(
  kind: ArchitectureImpactEdgeKind,
  from: string,
  to: string,
  discriminator: string | number,
): string
{
  return `impact-edge:${encodeURIComponent(JSON.stringify([kind, from, to, discriminator]))}`
}

function addOmission(omissions: ArchitectureImpactOmission[], label: string, count: number): void
{
  if (count > 0) omissions.push({ label, count })
}

function copyExportList(
  list: ArchitectureFileApiChange['addedExports'],
): ArchitectureImpactExportList
{
  return {
    items: list.items.map((entry) => ({
      name: entry.name,
      typeOnly: entry.typeOnly === true,
      brokenConsumers: entry.brokenConsumers
        ? {
            items: [...entry.brokenConsumers.items],
            total: entry.brokenConsumers.total,
            omitted: entry.brokenConsumers.omitted,
          }
        : null,
    })),
    total: list.total,
    omitted: list.omitted,
  }
}

export function createArchitectureImpactModel(
  result: ArchitectureImpactResult,
): ArchitectureImpactModel
{
  const mutableNodes = new Map<string, MutableNode>()
  const edges: ArchitectureImpactEdge[] = []
  const addedPaths = new Set(result.addedNodes.items)
  const removedPaths = new Set(result.removedNodes.items)
  const movedFromPaths = new Set(result.movedNodes.items.map((move) => move.from))
  const movedToPaths = new Set(result.movedNodes.items.map((move) => move.to))
  const ensureNode = (path: string, entity: ArchitectureImpactNodeEntity = 'file'): MutableNode =>
  {
    const current = mutableNodes.get(path)
    if (current)
    {
      if (entity === 'file') current.entity = 'file'
      return current
    }
    const created: MutableNode = {
      path,
      entity,
      base: false,
      head: false,
      kinds: new Set(['context']),
      api: null,
    }
    mutableNodes.set(path, created)
    return created
  }
  const markNode = (
    path: string,
    side: 'base' | 'head',
    kind: ArchitectureImpactNodeKind,
  ): void =>
  {
    const node = ensureNode(path)
    node[side] = true
    node.kinds.delete('context')
    node.kinds.add(kind)
  }
  const markContext = (path: string, side: 'base' | 'head'): void =>
  {
    ensureNode(path)[side] = true
  }
  const markTransitionNode = (
    path: string,
    kind: ArchitectureImpactNodeKind,
    entity: ArchitectureImpactNodeEntity,
  ): void =>
  {
    const node = ensureNode(path, entity)
    node.kinds.delete('context')
    node.kinds.add(kind)
  }
  const addEdge = (
    kind: ArchitectureImpactEdgeKind,
    from: string,
    to: string,
    side: 'base' | 'head' | 'both' | 'diff',
    discriminator: string | number,
    rule: string | null = null,
    severity: ArchitectureImpactEdge['severity'] = null,
    count: number | null = null,
  ): void =>
  {
    edges.push({
      id: edgeId(kind, from, to, discriminator),
      from,
      to,
      base: side === 'base' || side === 'both',
      head: side === 'head' || side === 'both',
      kind,
      rule,
      severity,
      count,
    })
  }

  for (const path of result.addedNodes.items) markNode(path, 'head', 'added')
  for (const path of result.removedNodes.items) markNode(path, 'base', 'removed')
  for (const [index, edge] of result.addedEdges.items.entries())
  {
    markContext(edge.from, 'head')
    markContext(edge.to, 'head')
    addEdge('added-import', edge.from, edge.to, 'head', index)
  }
  for (const [index, edge] of result.removedEdges.items.entries())
  {
    markContext(edge.from, 'base')
    markContext(edge.to, 'base')
    addEdge('removed-import', edge.from, edge.to, 'base', index)
  }
  for (const [index, move] of result.movedNodes.items.entries())
  {
    markNode(move.from, 'base', 'moved-from')
    markNode(move.to, 'head', 'moved-to')
    addEdge('move', move.from, move.to, 'diff', index)
  }
  for (const [index, flow] of result.moveFlows.items.entries())
  {
    markTransitionNode(flow.from, 'move-flow-from', 'directory')
    markTransitionNode(flow.to, 'move-flow-to', 'directory')
    addEdge('move-flow', flow.from, flow.to, 'diff', index, null, null, flow.count)
  }
  for (const api of result.apiChanges.items)
  {
    const node = ensureNode(api.file)
    const hasBaseMembership = removedPaths.has(api.file) || movedFromPaths.has(api.file)
    const hasHeadMembership = addedPaths.has(api.file) || movedToPaths.has(api.file)
    if (hasBaseMembership || hasHeadMembership)
    {
      node.base = hasBaseMembership
      node.head = hasHeadMembership
    }
    else
    {
      node.base = true
      node.head = true
    }
    node.kinds.delete('context')
    node.kinds.add('api')
    node.api = {
      addedExports: copyExportList(api.addedExports),
      removedExports: copyExportList(api.removedExports),
    }
  }
  for (const [index, violation] of result.newViolations.items.entries())
  {
    markContext(violation.from, 'head')
    markContext(violation.to, 'head')
    addEdge(
      'new-violation',
      violation.from,
      violation.to,
      'head',
      index,
      violation.rule,
      violation.severity,
    )
  }
  for (const [index, violation] of result.resolvedViolations.items.entries())
  {
    markContext(violation.from, 'base')
    markContext(violation.to, 'base')
    addEdge(
      'resolved-violation',
      violation.from,
      violation.to,
      'base',
      index,
      violation.rule,
      violation.severity,
    )
  }

  const omissions: ArchitectureImpactOmission[] = []
  addOmission(omissions, 'added files', result.addedNodes.omitted)
  addOmission(omissions, 'removed files', result.removedNodes.omitted)
  addOmission(omissions, 'added imports', result.addedEdges.omitted)
  addOmission(omissions, 'removed imports', result.removedEdges.omitted)
  addOmission(omissions, 'moved files', result.movedNodes.omitted)
  addOmission(omissions, 'move flows', result.moveFlows.omitted)
  addOmission(omissions, 'API files', result.apiChanges.omitted)
  for (const api of result.apiChanges.items)
  {
    addOmission(omissions, `added exports in ${api.file}`, api.addedExports.omitted)
    addOmission(omissions, `removed exports in ${api.file}`, api.removedExports.omitted)
    for (const removedExport of api.removedExports.items)
    {
      if (!removedExport.brokenConsumers) continue
      addOmission(
        omissions,
        `broken consumers of ${removedExport.name}`,
        removedExport.brokenConsumers.omitted,
      )
    }
  }
  addOmission(omissions, 'new violations', result.newViolations.omitted)
  addOmission(omissions, 'resolved violations', result.resolvedViolations.omitted)

  const kindOrder: Readonly<Record<ArchitectureImpactNodeKind, number>> = {
    added: 0,
    removed: 1,
    'moved-from': 2,
    'moved-to': 3,
    'move-flow-from': 4,
    'move-flow-to': 5,
    api: 6,
    context: 7,
  }
  const nodes = [...mutableNodes.values()]
    .map<ArchitectureImpactNode>((node) => ({
      id: nodeId(node.path),
      path: node.path,
      entity: node.entity,
      base: node.base,
      head: node.head,
      kinds: [...node.kinds].sort((left, right) => kindOrder[left] - kindOrder[right]),
      api: node.api,
    }))
    .sort((left, right) =>
    {
      const leftPriority = Math.min(...left.kinds.map((kind) => kindOrder[kind]))
      const rightPriority = Math.min(...right.kinds.map((kind) => kindOrder[kind]))
      return leftPriority - rightPriority || left.path.localeCompare(right.path)
    })

  return {
    nodes,
    edges,
    omissions,
    baseSource: impactHasSources(result) ? result.baseSource : null,
    headSource: impactHasSources(result) ? result.headSource : null,
  }
}

export function architectureImpactNodeVisible(
  node: ArchitectureImpactNode,
  view: ArchitectureImpactView,
): boolean
{
  return view === 'diff' || (view === 'before' ? node.base : node.head)
}

export function architectureImpactEdgeVisible(
  edge: ArchitectureImpactEdge,
  view: ArchitectureImpactView,
): boolean
{
  return view === 'diff' || (view === 'before' ? edge.base : edge.head)
}

export function architectureImpactNodeSource(
  model: ArchitectureImpactModel,
  node: ArchitectureImpactNode,
  view: ArchitectureImpactView,
): ArchitectureFileSource | null
{
  if (node.entity === 'directory') return null
  if (view === 'before') return node.base ? model.baseSource : null
  if (view === 'after') return node.head ? model.headSource : null
  if (node.kinds.includes('removed') || node.kinds.includes('moved-from'))
  {
    return node.base ? model.baseSource : null
  }
  return node.head ? model.headSource : node.base ? model.baseSource : null
}
