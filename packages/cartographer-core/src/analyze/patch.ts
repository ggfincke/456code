// packages/cartographer-core/src/analyze/patch.ts
// graph patch (proposal) format: parse, apply, direct diff & validation

import type { CartographerGraph, GraphEdge, GraphNode } from '../contracts/types.js'
import type { ProposalBaselineMeta } from '../contracts/atlasContract.js'
import type { GraphSlice } from './aggregate.js'
import { diffGraphsWithMoves, type GraphDiff } from './diff.js'
import { edgeIdentityKey, formatEdgeEndpoints, type EdgeEndpoints } from './edgeIdentity.js'
import { fileDegrees } from './degrees.js'
import type { MovedNode } from './moves.js'
import { compileRuleEvaluator } from './ruleEval.js'

// current patch schema version; v1 is flat ops -> step grouping reserved
export const PATCH_SCHEMA_VERSION = 1
export const MAX_PATCH_OPS = 2000
export const MAX_PATCH_BYTES = 1024 * 1024

// field caps enforced by parseGraphPatch
const MAX_NAME_LENGTH = 120
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_NOTE_LENGTH = 500
const MAX_PATH_LENGTH = 512
const MAX_EXPORTS = 200
const MAX_EXPORT_NAME_LENGTH = 200
const MAX_SYMBOLS = 200

// validation output caps
const CYCLE_PATH_CAP = 40
const BOUNDARY_SAMPLE_CAP = 8

export type GraphPatchBaseline = ProposalBaselineMeta

export interface GraphPatchMeta
{
  // display name; the stored patch id derives from it
  name: string
  description?: string
  author?: string
  createdAt: string
  // graph the author proposed against -> staleness signal downstream
  baseline?: GraphPatchBaseline
}

export type GraphPatchOp =
  | {
      op: 'add_file'
      path: string
      description?: string
      exports?: string[]
      note?: string
    }
  | { op: 'remove_file'; path: string; note?: string }
  | { op: 'move_file'; from: string; to: string; note?: string }
  | {
      op: 'add_import'
      from: string
      to: string
      symbols?: string[]
      typeOnly?: true
      note?: string
    }
  | { op: 'remove_import'; from: string; to: string; note?: string }

export interface GraphPatch
{
  version: typeof PATCH_SCHEMA_VERSION
  meta: GraphPatchMeta
  // applied sequentially; later ops may reference paths earlier ops created
  ops: GraphPatchOp[]
}

export interface PatchIssue
{
  opIndex: number
  severity: 'error' | 'warning'
  message: string
}

// membership for synthesized nodes; the server resolves via config rules
export type PatchNodeResolver = (path: string) => {
  group: string
  system?: string
}

export interface PatchApplyResult
{
  nodes: GraphNode[]
  edges: GraphEdge[]
  // current head path -> original base path; added files have no entry
  originByPath: ReadonlyMap<string, string>
  // net base-to-head moves produced by applied move_file ops
  moved: MovedNode[]
  issues: PatchIssue[]
}

export interface PatchApplyOptions
{
  // evaluation budgets count repeated incident-edge and rule-matching work
  consumeWork?: (amount: number) => void
}

export interface PatchCycleFinding
{
  from: string
  to: string
  // closes to -> ... -> from; both endpoints survive the cap
  path: string[]
  // hops dropped from the middle of `path` by the cap; absent -> nothing lost
  pathOmitted?: number
}

export interface PatchBoundaryFinding
{
  from: string
  to: string
  baseCount: number
  headCount: number
  sample: Array<{ from: string; to: string }>
}

export interface PatchOrphanFinding
{
  file: string
  kind: 'becomes-orphan' | 'added-unconnected'
}

export interface PatchValidation
{
  cycles: PatchCycleFinding[]
  newBoundaries: PatchBoundaryFinding[]
  orphans: PatchOrphanFinding[]
  totals: { cycles: number; newBoundaries: number; orphans: number }
}

// patch readers accept only the current contract
export function assertPatchVersion(version: unknown, source: string): void
{
  if (version === PATCH_SCHEMA_VERSION)
  {
    return
  }
  throw new Error(
    `${source} uses patch schema version ${String(version)}; ` +
      `this build requires version ${PATCH_SCHEMA_VERSION}`,
  )
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(obj: JsonObject, field: string, path: string, maxLength: number): string
{
  const value = obj[field]
  if (typeof value !== 'string' || value.length === 0)
  {
    throw new Error(`patch -> ${path}.${field} must be a non-empty string`)
  }
  if (value.length > maxLength)
  {
    throw new Error(`patch -> ${path}.${field} exceeds ${maxLength} characters`)
  }
  return value
}

function readOptionalString(
  obj: JsonObject,
  field: string,
  path: string,
  maxLength: number,
): string | undefined
{
  if (obj[field] === undefined)
  {
    return undefined
  }
  return readString(obj, field, path, maxLength)
}

// repo-relative path sanity; rejects traversal, aliases & non-posix forms
function readPath(obj: JsonObject, field: string, path: string): string
{
  const value = readString(obj, field, path, MAX_PATH_LENGTH)
  if (value.startsWith('/') || value.includes('\\'))
  {
    throw new Error(`patch -> ${path}.${field} must be a repo-relative POSIX path`)
  }
  if (value.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''))
  {
    throw new Error(`patch -> ${path}.${field} must not contain empty, ".", or ".." segments`)
  }
  // control chars (incl. NUL) never belong in a repo path
  for (let i = 0; i < value.length; i += 1)
  {
    if (value.charCodeAt(i) < 0x20)
    {
      throw new Error(`patch -> ${path}.${field} contains control characters`)
    }
  }
  return value
}

function readNameList(
  obj: JsonObject,
  field: string,
  path: string,
  maxEntries: number,
): string[] | undefined
{
  const value = obj[field]
  if (value === undefined)
  {
    return undefined
  }
  if (!Array.isArray(value))
  {
    throw new Error(`patch -> ${path}.${field} must be an array`)
  }
  if (value.length > maxEntries)
  {
    throw new Error(`patch -> ${path}.${field} exceeds ${maxEntries} entries`)
  }
  return value.map((entry, i) =>
  {
    if (typeof entry !== 'string' || entry.length === 0)
    {
      throw new Error(`patch -> ${path}.${field}[${i}] must be a non-empty string`)
    }
    if (entry.length > MAX_EXPORT_NAME_LENGTH)
    {
      throw new Error(
        `patch -> ${path}.${field}[${i}] exceeds ${MAX_EXPORT_NAME_LENGTH} characters`,
      )
    }
    return entry
  })
}

function parseOp(value: unknown, index: number): GraphPatchOp
{
  const path = `ops[${index}]`
  if (!isObject(value))
  {
    throw new Error(`patch -> ${path} must be an object`)
  }
  const note = readOptionalString(value, 'note', path, MAX_NOTE_LENGTH)
  const kind = value.op
  switch (kind)
  {
    case 'add_file':
    {
      const description = readOptionalString(value, 'description', path, MAX_DESCRIPTION_LENGTH)
      const exports = readNameList(value, 'exports', path, MAX_EXPORTS)
      return {
        op: 'add_file',
        path: readPath(value, 'path', path),
        ...(description !== undefined ? { description } : {}),
        ...(exports !== undefined ? { exports } : {}),
        ...(note !== undefined ? { note } : {}),
      }
    }
    case 'remove_file':
      return {
        op: 'remove_file',
        path: readPath(value, 'path', path),
        ...(note !== undefined ? { note } : {}),
      }
    case 'move_file':
      return {
        op: 'move_file',
        from: readPath(value, 'from', path),
        to: readPath(value, 'to', path),
        ...(note !== undefined ? { note } : {}),
      }
    case 'add_import':
    {
      const typeOnly = value.typeOnly
      if (typeOnly !== undefined && typeOnly !== true)
      {
        throw new Error(`patch -> ${path}.typeOnly must be true when present`)
      }
      const symbols = readNameList(value, 'symbols', path, MAX_SYMBOLS)
      return {
        op: 'add_import',
        from: readPath(value, 'from', path),
        to: readPath(value, 'to', path),
        ...(symbols !== undefined ? { symbols } : {}),
        ...(typeOnly === true ? { typeOnly: true } : {}),
        ...(note !== undefined ? { note } : {}),
      }
    }
    case 'remove_import':
      return {
        op: 'remove_import',
        from: readPath(value, 'from', path),
        to: readPath(value, 'to', path),
        ...(note !== undefined ? { note } : {}),
      }
    default:
      throw new Error(`patch -> ${path}.op has unknown kind ${String(kind)}`)
  }
}

export function parseGraphPatch(value: unknown): GraphPatch
{
  if (!isObject(value))
  {
    throw new Error('patch -> payload must be an object')
  }
  assertPatchVersion(value.version, 'patch')
  const metaValue = value.meta
  if (!isObject(metaValue))
  {
    throw new Error('patch -> meta must be an object')
  }
  const meta: GraphPatchMeta = {
    name: readString(metaValue, 'name', 'meta', MAX_NAME_LENGTH),
    createdAt: readString(metaValue, 'createdAt', 'meta', MAX_NAME_LENGTH),
  }
  const description = readOptionalString(metaValue, 'description', 'meta', MAX_DESCRIPTION_LENGTH)
  if (description !== undefined)
  {
    meta.description = description
  }
  const author = readOptionalString(metaValue, 'author', 'meta', MAX_NAME_LENGTH)
  if (author !== undefined)
  {
    meta.author = author
  }
  const baselineValue = metaValue.baseline
  if (baselineValue !== undefined)
  {
    if (!isObject(baselineValue))
    {
      throw new Error('patch -> meta.baseline must be an object')
    }
    const baseline: GraphPatchBaseline = {}
    const generatedAt = readOptionalString(
      baselineValue,
      'generatedAt',
      'meta.baseline',
      MAX_NAME_LENGTH,
    )
    if (generatedAt !== undefined)
    {
      baseline.generatedAt = generatedAt
    }
    const gitRef = readOptionalString(baselineValue, 'gitRef', 'meta.baseline', MAX_NAME_LENGTH)
    if (gitRef !== undefined)
    {
      baseline.gitRef = gitRef
    }
    meta.baseline = baseline
  }
  const opsValue = value.ops
  if (!Array.isArray(opsValue) || opsValue.length === 0)
  {
    throw new Error('patch -> ops must be a non-empty array')
  }
  if (opsValue.length > MAX_PATCH_OPS)
  {
    throw new Error(`patch -> ops exceeds ${MAX_PATCH_OPS} entries`)
  }
  return {
    version: PATCH_SCHEMA_VERSION,
    meta,
    ops: opsValue.map((op, i) => parseOp(op, i)),
  }
}

function basenameOf(id: string): string
{
  return id.slice(id.lastIndexOf('/') + 1)
}

// re-stamp one edge's violations; the field stays absent when nothing fires so
// patched edges serialize exactly like analyzer-built ones
function withViolations(edge: GraphEdge, violations: string[] | undefined): GraphEdge
{
  if (edge.violations === undefined && violations === undefined)
  {
    return edge
  }
  const next: GraphEdge = { ...edge }
  delete next.violations
  if (violations !== undefined)
  {
    next.violations = violations
  }
  return next
}

// sequential, order-sensitive apply over id-keyed maps; errors skip the op
export function applyPatch(
  base: Pick<CartographerGraph, 'nodes' | 'edges' | 'rules'>,
  patch: GraphPatch,
  resolveNode: PatchNodeResolver,
  options: PatchApplyOptions = {},
): PatchApplyResult
{
  const nodes = new Map(base.nodes.map((n) => [n.id, n]))
  const edges = new Map(base.edges.map((e) => [edgeIdentityKey(e), e]))
  const incidentKeys = new Map<string, Set<string>>()
  const originByPath = new Map(base.nodes.map((node) => [node.id, node.id]))
  const issues: PatchIssue[] = []
  let syntheticEdgeCount = 0

  const addIncidentKey = (path: string, key: string): void =>
  {
    let keys = incidentKeys.get(path)
    if (!keys)
    {
      keys = new Set<string>()
      incidentKeys.set(path, keys)
    }
    keys.add(key)
  }
  const removeIncidentKey = (path: string, key: string): void =>
  {
    const keys = incidentKeys.get(path)
    if (!keys)
    {
      return
    }
    keys.delete(key)
    if (keys.size === 0)
    {
      incidentKeys.delete(path)
    }
  }
  const setEdge = (key: string, edge: GraphEdge): void =>
  {
    const exists = edges.has(key)
    edges.set(key, edge)
    // overwriting an endpoint key keeps its Map/Set insertion position
    if (!exists)
    {
      addIncidentKey(edge.from, key)
      addIncidentKey(edge.to, key)
    }
  }
  const deleteEdge = (key: string): GraphEdge | undefined =>
  {
    const edge = edges.get(key)
    if (!edge)
    {
      return undefined
    }
    edges.delete(key)
    removeIncidentKey(edge.from, key)
    removeIncidentKey(edge.to, key)
    return edge
  }

  // build from the deduplicated Map so last-value/first-position semantics
  // stay identical to the original endpoint-keyed initialization
  for (const [key, edge] of edges)
  {
    addIncidentKey(edge.from, key)
    addIncidentKey(edge.to, key)
  }

  const error = (opIndex: number, message: string): void =>
  {
    issues.push({ opIndex, severity: 'error', message })
  }
  const warning = (opIndex: number, message: string): void =>
  {
    issues.push({ opIndex, severity: 'warning', message })
  }

  patch.ops.forEach((op, i) =>
  {
    switch (op.op)
    {
      case 'add_file':
      {
        if (nodes.has(op.path))
        {
          error(i, `add_file: ${op.path} already exists`)
          return
        }
        const membership = resolveNode(op.path)
        const node: GraphNode = {
          id: op.path,
          kind: 'file',
          label: basenameOf(op.path),
          group: membership.group,
        }
        if (membership.system !== undefined)
        {
          node.system = membership.system
        }
        if (op.description !== undefined)
        {
          node.description = op.description
        }
        if (op.exports !== undefined)
        {
          node.exports = op.exports.map((name) => ({ name }))
        }
        nodes.set(op.path, node)
        return
      }
      case 'remove_file':
      {
        if (!nodes.delete(op.path))
        {
          error(i, `remove_file: ${op.path} does not exist`)
          return
        }
        originByPath.delete(op.path)
        const keys = [...(incidentKeys.get(op.path) ?? [])]
        options.consumeWork?.(keys.length)
        for (const key of keys)
        {
          deleteEdge(key)
        }
        return
      }
      case 'move_file':
      {
        const node = nodes.get(op.from)
        if (!node)
        {
          error(i, `move_file: ${op.from} does not exist`)
          return
        }
        if (op.from === op.to)
        {
          warning(i, `move_file: ${op.from} already at target`)
          return
        }
        if (nodes.has(op.to))
        {
          error(i, `move_file: target ${op.to} already exists`)
          return
        }
        nodes.delete(op.from)
        const origin = originByPath.get(op.from)
        originByPath.delete(op.from)
        const membership = resolveNode(op.to)
        const movedNode: GraphNode = {
          ...node,
          id: op.to,
          label: basenameOf(op.to),
          group: membership.group,
        }
        if (membership.system !== undefined)
        {
          movedNode.system = membership.system
        }
        else
        {
          delete movedNode.system
        }
        nodes.set(op.to, movedNode)
        if (origin !== undefined)
        {
          originByPath.set(op.to, origin)
        }
        // retarget incident edges; keys change w/ the endpoints
        const keys = [...(incidentKeys.get(op.from) ?? [])]
        options.consumeWork?.(keys.length)
        for (const key of keys)
        {
          const edge = deleteEdge(key)
          if (!edge)
          {
            continue
          }
          const retargeted: GraphEdge = {
            ...edge,
            from: edge.from === op.from ? op.to : edge.from,
            to: edge.to === op.from ? op.to : edge.to,
          }
          setEdge(edgeIdentityKey(retargeted), retargeted)
        }
        return
      }
      case 'add_import':
      {
        if (!nodes.has(op.from))
        {
          error(i, `add_import: ${op.from} does not exist`)
          return
        }
        if (!nodes.has(op.to))
        {
          error(i, `add_import: ${op.to} does not exist`)
          return
        }
        const endpoints = { from: op.from, to: op.to }
        const key = edgeIdentityKey(endpoints)
        if (edges.has(key))
        {
          warning(i, `add_import: ${formatEdgeEndpoints(endpoints)} already exists`)
          return
        }
        const edge: GraphEdge = {
          // fresh id namespace -> never collides w/ analyzer e<N> ids
          id: `p${syntheticEdgeCount}`,
          from: op.from,
          to: op.to,
          kind: 'imports',
        }
        syntheticEdgeCount += 1
        if (op.symbols !== undefined)
        {
          edge.symbols = op.symbols
        }
        if (op.typeOnly)
        {
          edge.typeOnly = true
        }
        setEdge(key, edge)
        return
      }
      case 'remove_import':
      {
        const endpoints = { from: op.from, to: op.to }
        const key = edgeIdentityKey(endpoints)
        if (!deleteEdge(key))
        {
          error(i, `remove_import: ${formatEdgeEndpoints(endpoints)} does not exist`)
        }
        return
      }
    }
  })

  // violations are endpoint-derived, so moved & newly imported edges must be
  // re-judged against the head's own rules or stale verdicts survive the patch
  const violationsOf = compileRuleEvaluator(base.rules ?? [], options.consumeWork)
  for (const [key, edge] of edges)
  {
    edges.set(key, withViolations(edge, violationsOf(edge.from, edge.to)))
  }

  const moved = [...originByPath]
    .filter(([to, from]) => from !== to)
    .map(([to, from]) => ({ from, to }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    originByPath,
    moved,
    issues,
  }
}

// hypothetical head graph carrying the base's identity fields
export function patchHeadGraph(
  base: CartographerGraph,
  patch: GraphPatch,
  applied: PatchApplyResult,
): CartographerGraph
{
  return {
    ...base,
    generatedAt: patch.meta.createdAt,
    nodes: applied.nodes,
    edges: applied.edges,
  }
}

// direct diff from explicit ops; no move inference, no api drift claims
export function patchToDiff(
  base: CartographerGraph,
  applied: PatchApplyResult,
  head: CartographerGraph,
): GraphDiff
{
  return diffGraphsWithMoves(
    base,
    head,
    {
      moved: applied.moved,
      moveMap: new Map(applied.moved.map((m) => [m.from, m.to])),
    },
    applied.originByPath,
  )
}

function baseEndpointsOf(
  edge: EdgeEndpoints,
  originByPath: ReadonlyMap<string, string>,
): EdgeEndpoints | undefined
{
  const from = originByPath.get(edge.from)
  const to = originByPath.get(edge.to)
  return from === undefined || to === undefined ? undefined : { from, to }
}

function projectedBaseBoundaryCounts(
  base: GraphSlice,
  head: GraphSlice,
  originByPath: ReadonlyMap<string, string>,
): Map<string, number>
{
  const baseGroupOf = new Map(base.nodes.map((node) => [node.id, node.group]))
  const headGroupOf = new Map(head.nodes.map((node) => [node.id, node.group]))
  const currentPathByOrigin = new Map([...originByPath].map(([path, origin]) => [origin, path]))
  const groupOfOrigin = (origin: string): string | undefined =>
  {
    const currentPath = currentPathByOrigin.get(origin)
    return currentPath === undefined ? baseGroupOf.get(origin) : headGroupOf.get(currentPath)
  }
  const counts = new Map<string, number>()
  for (const edge of base.edges)
  {
    const from = groupOfOrigin(edge.from)
    const to = groupOfOrigin(edge.to)
    if (!from || !to || from === to)
    {
      continue
    }
    const key = edgeIdentityKey({ from, to })
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

interface DirectedAdjacency
{
  vertices: string[]
  out: Map<string, string[]>
  reverse: Map<string, string[]>
}

function directedAdjacency(head: GraphSlice): DirectedAdjacency
{
  const vertices: string[] = []
  const out = new Map<string, string[]>()
  const reverse = new Map<string, string[]>()
  const ensureVertex = (id: string): void =>
  {
    if (out.has(id))
    {
      return
    }
    vertices.push(id)
    out.set(id, [])
    reverse.set(id, [])
  }

  for (const node of head.nodes)
  {
    ensureVertex(node.id)
  }
  for (const edge of head.edges)
  {
    // dangling endpoints are invalid graph data, but retaining them here
    // preserves the prior reachability behavior for defensive callers
    ensureVertex(edge.from)
    ensureVertex(edge.to)
    out.get(edge.from)!.push(edge.to)
    reverse.get(edge.to)!.push(edge.from)
  }
  return { vertices, out, reverse }
}

// iterative Kosaraju avoids call-stack limits on repository-sized graphs
function stronglyConnectedComponents(adjacency: DirectedAdjacency): Map<string, number>
{
  const seen = new Set<string>()
  const finished: string[] = []
  for (const root of adjacency.vertices)
  {
    if (seen.has(root))
    {
      continue
    }
    seen.add(root)
    const stack: Array<{ id: string; nextIndex: number }> = [{ id: root, nextIndex: 0 }]
    while (stack.length > 0)
    {
      const frame = stack[stack.length - 1]!
      const next = adjacency.out.get(frame.id)![frame.nextIndex]
      if (next !== undefined)
      {
        frame.nextIndex += 1
        if (!seen.has(next))
        {
          seen.add(next)
          stack.push({ id: next, nextIndex: 0 })
        }
        continue
      }
      finished.push(frame.id)
      stack.pop()
    }
  }

  const componentOf = new Map<string, number>()
  let component = 0
  for (let i = finished.length - 1; i >= 0; i -= 1)
  {
    const root = finished[i]!
    if (componentOf.has(root))
    {
      continue
    }
    componentOf.set(root, component)
    const stack = [root]
    while (stack.length > 0)
    {
      const current = stack.pop()!
      for (const next of adjacency.reverse.get(current)!)
      {
        if (!componentOf.has(next))
        {
          componentOf.set(next, component)
          stack.push(next)
        }
      }
    }
    component += 1
  }
  return componentOf
}

interface CyclePathWitness
{
  path: string[]
  omitted: number
}

// bound the witness like evidenceBounds bounds its lists: keep the endpoints,
// drop from the middle, & report the hop count lost so the clip is observable
function clipCyclePath(path: string[]): CyclePathWitness
{
  if (path.length <= CYCLE_PATH_CAP)
  {
    return { path, omitted: 0 }
  }
  const head = Math.ceil(CYCLE_PATH_CAP / 2)
  const tail = CYCLE_PATH_CAP - head
  return {
    path: [...path.slice(0, head), ...path.slice(path.length - tail)],
    omitted: path.length - CYCLE_PATH_CAP,
  }
}

// BFS within one SCC preserves the former shortest witness & edge ordering
function findComponentPath(
  out: Map<string, string[]>,
  componentOf: ReadonlyMap<string, number>,
  component: number,
  from: string,
  to: string,
): CyclePathWitness | undefined
{
  const parent = new Map<string, string>()
  const queue = [from]
  const seen = new Set([from])
  let cursor = 0
  while (cursor < queue.length)
  {
    const current = queue[cursor]!
    cursor += 1
    for (const next of out.get(current) ?? [])
    {
      if (componentOf.get(next) !== component || seen.has(next))
      {
        continue
      }
      if (next === to)
      {
        // walk the whole parent chain first; clipping the assembled witness is
        // what keeps `from` at path[0] once the cap bites
        const path = [to]
        let step: string | undefined = current
        while (step !== undefined)
        {
          path.push(step)
          step = parent.get(step)
        }
        return clipCyclePath(path.toReversed())
      }
      seen.add(next)
      parent.set(next, current)
      queue.push(next)
    }
  }
  return undefined
}

// structural findings for a hypothetical head vs its base
export function validatePatchStructure(
  base: GraphSlice,
  head: GraphSlice,
  originByPath: ReadonlyMap<string, string>,
): PatchValidation
{
  const baseEdgeKeys = new Set(base.edges.map(edgeIdentityKey))
  const newEdges = head.edges.filter((edge) =>
  {
    const baseEndpoints = baseEndpointsOf(edge, originByPath)
    return baseEndpoints === undefined || !baseEdgeKeys.has(edgeIdentityKey(baseEndpoints))
  })

  // one head SCC pass replaces a whole-graph BFS for every new edge
  const adjacency = directedAdjacency(head)
  const componentOf = stronglyConnectedComponents(adjacency)
  const cycles: PatchCycleFinding[] = []
  const reportedComponents = new Set<number>()
  for (const edge of newEdges)
  {
    const component = componentOf.get(edge.from)
    if (
      component === undefined ||
      component !== componentOf.get(edge.to) ||
      reportedComponents.has(component)
    )
    {
      continue
    }
    const witness =
      edge.from === edge.to
        ? { path: [edge.from], omitted: 0 }
        : findComponentPath(adjacency.out, componentOf, component, edge.to, edge.from)
    if (witness)
    {
      reportedComponents.add(component)
      cycles.push({
        from: edge.from,
        to: edge.to,
        path: witness.path,
        ...(witness.omitted > 0 ? { pathOmitted: witness.omitted } : {}),
      })
    }
  }

  // boundaries: cross-group pairs that had zero imports before the patch
  const baseCounts = projectedBaseBoundaryCounts(base, head, originByPath)
  const headGroupOf = new Map(head.nodes.map((n) => [n.id, n.group]))
  const headPairs = new Map<
    string,
    {
      from: string
      to: string
      count: number
      sample: Array<{ from: string; to: string }>
    }
  >()
  for (const edge of head.edges)
  {
    const from = headGroupOf.get(edge.from)
    const to = headGroupOf.get(edge.to)
    if (!from || !to || from === to)
    {
      continue
    }
    const key = edgeIdentityKey({ from, to })
    let pair = headPairs.get(key)
    if (!pair)
    {
      pair = { from, to, count: 0, sample: [] }
      headPairs.set(key, pair)
    }
    pair.count += 1
    if (pair.sample.length < BOUNDARY_SAMPLE_CAP)
    {
      pair.sample.push({ from: edge.from, to: edge.to })
    }
  }
  const newBoundaries: PatchBoundaryFinding[] = []
  for (const [key, pair] of headPairs)
  {
    const baseCount = baseCounts.get(key) ?? 0
    if (baseCount === 0)
    {
      newBoundaries.push({
        from: pair.from,
        to: pair.to,
        baseCount,
        headCount: pair.count,
        sample: pair.sample,
      })
    }
  }
  newBoundaries.sort(
    (a, b) => b.headCount - a.headCount || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )

  // orphans: connectivity lost by the patch, or proposed files w/o wiring
  const baseDegrees = fileDegrees(
    base.edges,
    base.nodes.map((node) => node.id),
  )
  const headDegrees = fileDegrees(
    head.edges,
    head.nodes.map((node) => node.id),
  )
  const degreeOf = (degrees: ReturnType<typeof fileDegrees>, id: string): number =>
    (degrees.fanIn.get(id) ?? 0) + (degrees.fanOut.get(id) ?? 0)
  const orphans: PatchOrphanFinding[] = []
  for (const node of head.nodes)
  {
    if (degreeOf(headDegrees, node.id) > 0)
    {
      continue
    }
    const origin = originByPath.get(node.id)
    const baseDegree = origin === undefined ? undefined : degreeOf(baseDegrees, origin)
    if (baseDegree === undefined)
    {
      orphans.push({ file: node.id, kind: 'added-unconnected' })
    }
    else if (baseDegree > 0)
    {
      orphans.push({ file: node.id, kind: 'becomes-orphan' })
    }
  }
  orphans.sort((a, b) => a.file.localeCompare(b.file))

  return {
    cycles,
    newBoundaries,
    orphans,
    totals: {
      cycles: cycles.length,
      newBoundaries: newBoundaries.length,
      orphans: orphans.length,
    },
  }
}
