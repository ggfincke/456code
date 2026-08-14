// packages/cartographer-core/src/query/contextQuery.ts
// node-only loading and typed queries over published graph json contexts

import * as NodeFS from 'node:fs'

import { diffGraphs, type GraphDiff } from '../analyze/diff.js'
import { matchesRule } from '../analyze/glob.js'
import { createGraphRelationIndex, type GraphRelationIndex } from '../analyze/graphRelations.js'
import {
  computeImpactProfile,
  ImpactTargetError,
  type ImpactProfile,
  type ImpactProfileInput,
} from '../analyze/impactProfile.js'
import { assertGraphVersion, type CartographerGraph } from '../contracts/types.js'
import { normalizeGraphJson } from '../store/graphJson.js'

export type ContextQueryFailureCode =
  | 'graph-not-found'
  | 'graph-read-failed'
  | 'graph-invalid'
  | 'unsupported-version'
  | 'target-not-found'

export class ContextQueryError extends Error
{
  readonly code: ContextQueryFailureCode
  readonly source: string | undefined

  constructor(code: ContextQueryFailureCode, message: string, source?: string)
  {
    super(message)
    this.code = code
    this.source = source
  }
}

export interface ContextQueryGraph
{
  graph: CartographerGraph
  relations: GraphRelationIndex
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorDetail(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

function isOptionalString(value: unknown): boolean
{
  return value === undefined || typeof value === 'string'
}

function isNonEmptyString(value: unknown): value is string
{
  return typeof value === 'string' && value.trim().length > 0
}

function isNonEmptyStringArray(value: unknown): value is string[]
{
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isOptionalBoolean(value: unknown): boolean
{
  return value === undefined || typeof value === 'boolean'
}

function isNonNegativeInteger(value: unknown): boolean
{
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validResolvedTotal(value: unknown, resolved: unknown): boolean
{
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      (value as number) >= 1 &&
      (!Array.isArray(resolved) || (value as number) >= resolved.length))
  )
}

function validMarker(value: unknown): boolean
{
  return (
    isObject(value) &&
    (value.kind === 'important' ||
      value.kind === 'warning' ||
      value.kind === 'question' ||
      value.kind === 'todo') &&
    typeof value.text === 'string' &&
    isOptionalString(value.scope)
  )
}

function validMarkers(value: unknown): boolean
{
  return value === undefined || (Array.isArray(value) && value.every(validMarker))
}

function validDocumentation(value: unknown): boolean
{
  if (!isObject(value))
  {
    return false
  }
  return (
    typeof value.text === 'string' &&
    (value.syntax === 'tsdoc' || value.syntax === 'jsdoc' || value.syntax === 'python-docstring') &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) &&
        value.tags.every(
          (tag) => isObject(tag) && typeof tag.name === 'string' && isOptionalString(tag.value),
        )))
  )
}

function validExport(value: unknown): boolean
{
  if (!isObject(value))
  {
    return false
  }
  return (
    isNonEmptyString(value.name) &&
    isOptionalBoolean(value.typeOnly) &&
    isOptionalBoolean(value.reExport) &&
    (value.kind === undefined ||
      value.kind === 'fn' ||
      value.kind === 'const' ||
      value.kind === 'class' ||
      value.kind === 'interface' ||
      value.kind === 'type' ||
      value.kind === 'enum' ||
      value.kind === 'namespace' ||
      value.kind === 'default') &&
    isOptionalString(value.signature) &&
    isOptionalString(value.def) &&
    (value.documentation === undefined || validDocumentation(value.documentation)) &&
    (value.comments === undefined ||
      (Array.isArray(value.comments) &&
        value.comments.every(
          (comment) => isObject(comment) && typeof comment.text === 'string',
        ))) &&
    validMarkers(value.markers)
  )
}

function validNode(value: unknown): boolean
{
  if (!isObject(value))
  {
    return false
  }
  return (
    isNonEmptyString(value.id) &&
    value.kind === 'file' &&
    isNonEmptyString(value.label) &&
    isNonEmptyString(value.group) &&
    isOptionalString(value.system) &&
    (value.exports === undefined ||
      (Array.isArray(value.exports) && value.exports.every(validExport))) &&
    isOptionalString(value.description) &&
    (value.descriptionStale === undefined || value.descriptionStale === true) &&
    (value.descriptionSource === undefined ||
      value.descriptionSource === 'header' ||
      value.descriptionSource === 'annotation-sidecar') &&
    (value.headerPathStale === undefined || value.headerPathStale === true) &&
    validMarkers(value.markers)
  )
}

function validEdge(value: unknown): boolean
{
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.from) &&
    isNonEmptyString(value.to) &&
    value.kind === 'imports' &&
    isOptionalBoolean(value.dynamic) &&
    (value.symbols === undefined || isNonEmptyStringArray(value.symbols)) &&
    (value.typeOnly === undefined || value.typeOnly === true) &&
    (value.typeSymbols === undefined || isNonEmptyStringArray(value.typeSymbols)) &&
    (value.violations === undefined || isNonEmptyStringArray(value.violations))
  )
}

function validGroup(value: unknown): boolean
{
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    isOptionalString(value.description) &&
    isNonNegativeInteger(value.fileCount)
  )
}

function validMetrics(value: unknown): boolean
{
  return (
    isObject(value) &&
    isNonNegativeInteger(value.cycles) &&
    isNonNegativeInteger(value.orphans) &&
    isNonNegativeInteger(value.maxFanIn) &&
    isNonNegativeInteger(value.maxFanOut)
  )
}

function validSystem(value: unknown): boolean
{
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    isOptionalString(value.description) &&
    isNonNegativeInteger(value.fileCount) &&
    (value.source === 'authored' || value.source === 'fallback') &&
    (value.rank === undefined || (typeof value.rank === 'number' && Number.isFinite(value.rank)))
  )
}

function validRuleEnforcement(value: unknown): boolean
{
  return (
    isObject(value) &&
    isNonEmptyString(value.mechanism) &&
    isOptionalString(value.file) &&
    (value.line === undefined || (typeof value.line === 'number' && Number.isFinite(value.line))) &&
    isOptionalString(value.rule) &&
    (value.status === undefined ||
      value.status === 'verified' ||
      value.status === 'citation-missing' ||
      value.status === 'citation-not-found') &&
    isOptionalString(value.fileHash)
  )
}

function validRule(value: unknown): boolean
{
  if (!isObject(value))
  {
    return false
  }
  const allowViaCount =
    typeof value.allowVia === 'string'
      ? isNonEmptyString(value.allowVia)
        ? 1
        : null
      : value.allowVia === undefined
        ? undefined
        : isNonEmptyStringArray(value.allowVia)
          ? value.allowVia.length
          : null
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.from) &&
    isNonEmptyString(value.to) &&
    (value.verdict === 'forbid' || value.verdict === 'allow-only') &&
    allowViaCount !== null &&
    (value.verdict === 'allow-only' ? (allowViaCount ?? 0) > 0 : allowViaCount === undefined) &&
    (value.severity === 'error' || value.severity === 'warn' || value.severity === 'info') &&
    isOptionalString(value.why) &&
    (value.enforcedBy === undefined || validRuleEnforcement(value.enforcedBy)) &&
    (value.generated === undefined || typeof value.generated === 'boolean')
  )
}

function validJourneyStop(value: unknown): boolean
{
  if (!isObject(value))
  {
    return false
  }
  const hasResolved = Array.isArray(value.resolved) && value.resolved.length > 0
  const hasHopDistance = value.hopDistance !== undefined
  const hasHopVia = value.hopVia !== undefined
  const hopDistanceValid =
    !hasHopDistance ||
    (Number.isSafeInteger(value.hopDistance) && (value.hopDistance as number) >= 0)
  const hopViaValid = !hasHopVia || isNonEmptyStringArray(value.hopVia)
  return (
    isNonEmptyString(value.at) &&
    isNonEmptyString(value.title) &&
    (value.timing === 'immediate' ||
      value.timing === 'transaction' ||
      value.timing === 'deferred') &&
    isOptionalString(value.why) &&
    (value.resolved === undefined ||
      (isNonEmptyStringArray(value.resolved) && value.resolved.length > 0)) &&
    validResolvedTotal(value.resolvedTotal, value.resolved) &&
    (value.resolvedTotal === undefined || hasResolved) &&
    (value.stale === undefined || value.stale === true) &&
    hasResolved !== (value.stale === true) &&
    hasHopDistance === hasHopVia &&
    hopDistanceValid &&
    hopViaValid &&
    (!hasHopDistance || (value.hopVia as string[]).length === (value.hopDistance as number) + 1) &&
    (value.hopDepthExceeded === undefined || value.hopDepthExceeded === true) &&
    !(value.hopDepthExceeded === true && (hasHopDistance || hasHopVia))
  )
}

function validJourney(value: unknown): boolean
{
  if (
    !isObject(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.title) ||
    !isOptionalString(value.why) ||
    !Array.isArray(value.stops) ||
    value.stops.length < 2 ||
    !value.stops.every(validJourneyStop)
  )
  {
    return false
  }
  const stops = value.stops as JsonObject[]
  return stops.every((current, index) =>
  {
    if (index === 0)
    {
      return (
        current.hopDistance === undefined &&
        current.hopVia === undefined &&
        current.hopDepthExceeded === undefined
      )
    }
    if (current.hopVia === undefined && current.hopDepthExceeded !== true)
    {
      return true
    }
    const previous = stops[index - 1]!
    return Array.isArray(previous.resolved) && Array.isArray(current.resolved)
  })
}

function validRuntime(value: unknown): boolean
{
  if (!isObject(value))
  {
    return false
  }
  const hasResolved = Array.isArray(value.resolved) && value.resolved.length > 0
  return (
    isNonEmptyString(value.key) &&
    isNonEmptyString(value.label) &&
    isNonEmptyStringArray(value.roots) &&
    value.roots.length > 0 &&
    (value.resolved === undefined ||
      (isNonEmptyStringArray(value.resolved) && value.resolved.length > 0)) &&
    validResolvedTotal(value.resolvedTotal, value.resolved) &&
    (value.resolvedTotal === undefined || hasResolved) &&
    (value.stale === undefined || value.stale === true) &&
    hasResolved !== (value.stale === true)
  )
}

function validCoChange(value: unknown): boolean
{
  return (
    isObject(value) &&
    isNonEmptyString(value.a) &&
    isNonEmptyString(value.b) &&
    isNonNegativeInteger(value.count) &&
    typeof value.strength === 'number' &&
    Number.isFinite(value.strength) &&
    value.strength >= 0 &&
    value.strength <= 1
  )
}

function validOptionalReferences(value: unknown, identities: ReadonlySet<string>): boolean
{
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((identity) => typeof identity === 'string' && identities.has(identity)))
  )
}

function uniqueStrings(values: readonly string[]): boolean
{
  return new Set(values).size === values.length
}

function edgeEndpointKey(from: string, to: string): string
{
  return JSON.stringify([from, to])
}

// existence in the node set is not evidence: a stop authored for b.ts, or a runtime rooted
// at b.ts, would otherwise be accepted with a fabricated resolution naming a.ts. every
// resolved id must match at least one pattern the author actually wrote
function resolvedMatchesAuthoredPatterns(resolved: unknown, patterns: readonly string[]): boolean
{
  if (resolved === undefined) return true
  return (resolved as string[]).every((identity) =>
    patterns.some((pattern) => matchesRule(identity, pattern)),
  )
}

function validRuntimeReferences(value: unknown, nodeIdentities: ReadonlySet<string>): boolean
{
  const record = value as JsonObject
  return (
    validOptionalReferences(record.resolved, nodeIdentities) &&
    resolvedMatchesAuthoredPatterns(record.resolved, record.roots as string[])
  )
}

function validJourneyReferences(
  value: unknown,
  nodeIdentities: ReadonlySet<string>,
  edgeEndpointIdentities: ReadonlySet<string>,
): boolean
{
  if (!isObject(value) || !Array.isArray(value.stops))
  {
    return false
  }
  const stops = value.stops as JsonObject[]
  return stops.every((stop, index) =>
  {
    if (
      !validOptionalReferences(stop.resolved, nodeIdentities) ||
      !validOptionalReferences(stop.hopVia, nodeIdentities) ||
      !resolvedMatchesAuthoredPatterns(stop.resolved, [stop.at as string])
    )
    {
      return false
    }
    if (stop.hopVia === undefined)
    {
      return true
    }
    if (index === 0)
    {
      return false
    }
    const hopVia = stop.hopVia as string[]
    const previous = stops[index - 1]!
    if (
      !matchesRule(hopVia[0]!, previous.at as string) ||
      !matchesRule(hopVia[hopVia.length - 1]!, stop.at as string)
    )
    {
      return false
    }
    return hopVia
      .slice(1)
      .every((to, hopIndex) => edgeEndpointIdentities.has(edgeEndpointKey(hopVia[hopIndex]!, to)))
  })
}

function assertRequiredShape(
  value: unknown,
  graphPath: string,
): asserts value is CartographerGraph
{
  if (!isObject(value))
  {
    throw new ContextQueryError(
      'graph-invalid',
      `${graphPath} must contain a graph object`,
      graphPath,
    )
  }
  if (!Object.hasOwn(value, 'version'))
  {
    throw new ContextQueryError(
      'graph-invalid',
      `${graphPath} is missing graph schema version`,
      graphPath,
    )
  }
  try
  {
    assertGraphVersion(value.version, graphPath)
  }
  catch (error)
  {
    throw new ContextQueryError('unsupported-version', errorDetail(error), graphPath)
  }

  const missingArrays = ['nodes', 'edges', 'groups'].filter((field) => !Array.isArray(value[field]))
  if (missingArrays.length > 0)
  {
    throw new ContextQueryError(
      'graph-invalid',
      `${graphPath} has invalid required array field(s): ${missingArrays.join(', ')}`,
      graphPath,
    )
  }
  const nodes = value.nodes as unknown[]
  const edges = value.edges as unknown[]
  const groups = value.groups as unknown[]
  if (
    !isNonEmptyString(value.repoRoot) ||
    value.mode !== 'imports' ||
    !isNonEmptyString(value.generatedAt) ||
    !isNonEmptyString(value.scope) ||
    !(value.gitRef === undefined || isNonEmptyString(value.gitRef)) ||
    !nodes.every(validNode) ||
    !edges.every(validEdge) ||
    !groups.every(validGroup) ||
    !validMetrics(value.metrics) ||
    !validMarkers(value.markers) ||
    (value.systems !== undefined &&
      (!Array.isArray(value.systems) || !value.systems.every(validSystem))) ||
    (value.rules !== undefined && (!Array.isArray(value.rules) || !value.rules.every(validRule))) ||
    (value.journeys !== undefined &&
      (!Array.isArray(value.journeys) || !value.journeys.every(validJourney))) ||
    (value.runtimes !== undefined &&
      (!Array.isArray(value.runtimes) || !value.runtimes.every(validRuntime))) ||
    (value.coChanges !== undefined &&
      (!Array.isArray(value.coChanges) || !value.coChanges.every(validCoChange)))
  )
  {
    throw new ContextQueryError(
      'graph-invalid',
      `${graphPath} does not satisfy the graph v4 contract`,
      graphPath,
    )
  }
  const nodeIds = nodes.map((node) => (node as JsonObject).id as string)
  const edgeIds = edges.map((edge) => (edge as JsonObject).id as string)
  const edgeEndpointKeys = edges.map((edge) =>
  {
    const record = edge as JsonObject
    return edgeEndpointKey(record.from as string, record.to as string)
  })
  const groupIds = groups.map((group) => (group as JsonObject).id as string)
  const systems = (value.systems as unknown[] | undefined) ?? []
  const rules = (value.rules as unknown[] | undefined) ?? []
  const journeys = (value.journeys as unknown[] | undefined) ?? []
  const runtimes = (value.runtimes as unknown[] | undefined) ?? []
  const coChanges = (value.coChanges as unknown[] | undefined) ?? []
  const systemIds = systems.map((system) => (system as JsonObject).id as string)
  const ruleIds = rules.map((rule) => (rule as JsonObject).id as string)
  const journeyIds = journeys.map((journey) => (journey as JsonObject).id as string)
  const runtimeKeys = runtimes.map((runtime) => (runtime as JsonObject).key as string)
  const nodeIdSet = new Set(nodeIds)
  const edgeEndpointKeySet = new Set(edgeEndpointKeys)
  if (
    !uniqueStrings(nodeIds) ||
    !uniqueStrings(edgeIds) ||
    !uniqueStrings(edgeEndpointKeys) ||
    !uniqueStrings(groupIds) ||
    !uniqueStrings(systemIds) ||
    !uniqueStrings(ruleIds) ||
    !uniqueStrings(journeyIds) ||
    !uniqueStrings(runtimeKeys) ||
    edges.some((edge) =>
    {
      const record = edge as JsonObject
      return !nodeIdSet.has(record.from as string) || !nodeIdSet.has(record.to as string)
    })
  )
  {
    throw new ContextQueryError(
      'graph-invalid',
      `${graphPath} has duplicate identities or dangling edge endpoints`,
      graphPath,
    )
  }

  const groupIdSet = new Set(groupIds)
  const systemIdSet = new Set(systemIds)
  const ruleIdSet = new Set(ruleIds)
  const referencesAreValid =
    nodes.every((node) =>
    {
      const record = node as JsonObject
      return (
        groupIdSet.has(record.group as string) &&
        (record.system === undefined || systemIdSet.has(record.system as string))
      )
    }) &&
    edges.every((edge) =>
    {
      const record = edge as JsonObject
      const symbols = new Set((record.symbols as string[] | undefined) ?? [])
      return (
        validOptionalReferences(record.typeSymbols, symbols) &&
        validOptionalReferences(record.violations, ruleIdSet)
      )
    }) &&
    journeys.every((journey) => validJourneyReferences(journey, nodeIdSet, edgeEndpointKeySet)) &&
    runtimes.every((runtime) => validRuntimeReferences(runtime, nodeIdSet)) &&
    coChanges.every((pair) =>
    {
      const record = pair as JsonObject
      return nodeIdSet.has(record.a as string) && nodeIdSet.has(record.b as string)
    })
  if (!referencesAreValid)
  {
    throw new ContextQueryError(
      'graph-invalid',
      `${graphPath} has invalid graph v4 cross-field references`,
      graphPath,
    )
  }
}

export function loadContextQuery(graphPath: string): ContextQueryGraph
{
  let serialized: string
  try
  {
    serialized = NodeFS.readFileSync(graphPath, 'utf-8')
  }
  catch (error)
  {
    const code = (error as NodeJS.ErrnoException).code
    throw new ContextQueryError(
      code === 'ENOENT' ? 'graph-not-found' : 'graph-read-failed',
      `could not read graph at ${graphPath}: ${errorDetail(error)}`,
      graphPath,
    )
  }

  let value: unknown
  try
  {
    value = JSON.parse(serialized)
  }
  catch (error)
  {
    throw new ContextQueryError(
      'graph-invalid',
      `could not parse graph at ${graphPath}: ${errorDetail(error)}`,
      graphPath,
    )
  }

  try
  {
    assertRequiredShape(value, graphPath)
    const graph = normalizeGraphJson(value)
    assertRequiredShape(graph, graphPath)
    return { graph, relations: createGraphRelationIndex(graph) }
  }
  catch (error)
  {
    if (error instanceof ContextQueryError)
    {
      throw error
    }
    throw new ContextQueryError(
      'graph-invalid',
      `could not normalize graph at ${graphPath}: ${errorDetail(error)}`,
      graphPath,
    )
  }
}

export function queryContextImpact(
  context: ContextQueryGraph,
  input: ImpactProfileInput,
): ImpactProfile
{
  try
  {
    return computeImpactProfile(context.relations, input)
  }
  catch (error)
  {
    if (error instanceof ImpactTargetError)
    {
      throw new ContextQueryError('target-not-found', error.message)
    }
    throw error
  }
}

export function queryContextDiff(base: ContextQueryGraph, head: ContextQueryGraph): GraphDiff
{
  return diffGraphs(base.graph, head.graph)
}
