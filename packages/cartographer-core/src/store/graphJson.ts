// packages/cartographer-core/src/store/graphJson.ts
// validate & deterministically order additive graph rule & journey fields

import type {
  CartographerGraph,
  GraphEdge,
  GraphJourney,
  GraphJourneyStop,
  GraphRule,
  GraphRuntime,
} from '../contracts/types.js'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function parseEnforcedBy(value: unknown): GraphRule['enforcedBy'] | null
{
  const raw = asObject(value)
  if (!raw || typeof raw.mechanism !== 'string')
  {
    return null
  }
  if (raw.file !== undefined && typeof raw.file !== 'string')
  {
    return null
  }
  if (raw.line !== undefined && (typeof raw.line !== 'number' || !Number.isFinite(raw.line)))
  {
    return null
  }
  if (raw.rule !== undefined && typeof raw.rule !== 'string')
  {
    return null
  }
  // build-time citation stamps ride along; unknown values drop, not fail
  const status =
    raw.status === 'verified' ||
    raw.status === 'citation-missing' ||
    raw.status === 'citation-not-found'
      ? raw.status
      : undefined
  return {
    mechanism: raw.mechanism,
    ...(typeof raw.file === 'string' ? { file: raw.file } : {}),
    ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
    ...(typeof raw.rule === 'string' ? { rule: raw.rule } : {}),
    ...(status ? { status } : {}),
    ...(typeof raw.fileHash === 'string' ? { fileHash: raw.fileHash } : {}),
  }
}

function parseGraphRule(value: unknown): GraphRule | undefined
{
  const raw = asObject(value)
  if (
    !raw ||
    typeof raw.id !== 'string' ||
    typeof raw.from !== 'string' ||
    typeof raw.to !== 'string' ||
    (raw.verdict !== 'forbid' && raw.verdict !== 'allow-only') ||
    (raw.severity !== 'error' && raw.severity !== 'warn' && raw.severity !== 'info')
  )
  {
    return undefined
  }
  const allowVia =
    typeof raw.allowVia === 'string'
      ? [raw.allowVia]
      : Array.isArray(raw.allowVia) && raw.allowVia.every((entry) => typeof entry === 'string')
        ? raw.allowVia
        : undefined
  if (
    (raw.verdict === 'allow-only' && (!allowVia || allowVia.length === 0)) ||
    (raw.verdict === 'forbid' && raw.allowVia !== undefined)
  )
  {
    return undefined
  }
  if (raw.why !== undefined && typeof raw.why !== 'string')
  {
    return undefined
  }
  if (raw.generated !== undefined && typeof raw.generated !== 'boolean')
  {
    return undefined
  }
  const enforcedBy = raw.enforcedBy === undefined ? undefined : parseEnforcedBy(raw.enforcedBy)
  if (enforcedBy === null)
  {
    return undefined
  }
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    verdict: raw.verdict,
    ...(allowVia ? { allowVia } : {}),
    severity: raw.severity,
    ...(typeof raw.why === 'string' ? { why: raw.why } : {}),
    ...(enforcedBy ? { enforcedBy } : {}),
    ...(typeof raw.generated === 'boolean' ? { generated: raw.generated } : {}),
  }
}

function stringList(value: unknown): string[] | null
{
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
  {
    return null
  }
  return value as string[]
}

function resolvedTotal(value: unknown, resolved: string[] | undefined): number | undefined | null
{
  if (value === undefined)
  {
    return undefined
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (resolved !== undefined && (value as number) < resolved.length)
  )
  {
    return null
  }
  return value as number
}

function parseGraphJourneyStop(value: unknown): GraphJourneyStop | undefined
{
  const raw = asObject(value)
  if (
    !raw ||
    typeof raw.at !== 'string' ||
    typeof raw.title !== 'string' ||
    (raw.timing !== 'immediate' && raw.timing !== 'transaction' && raw.timing !== 'deferred')
  )
  {
    return undefined
  }
  if (raw.why !== undefined && typeof raw.why !== 'string')
  {
    return undefined
  }
  const resolved = raw.resolved === undefined ? undefined : stringList(raw.resolved)
  if (resolved === null)
  {
    return undefined
  }
  const total = resolvedTotal(raw.resolvedTotal, resolved)
  if (total === null)
  {
    return undefined
  }
  if (raw.stale !== undefined && raw.stale !== true)
  {
    return undefined
  }
  if (
    raw.hopDistance !== undefined &&
    (typeof raw.hopDistance !== 'number' || !Number.isFinite(raw.hopDistance))
  )
  {
    return undefined
  }
  const hopVia = raw.hopVia === undefined ? undefined : stringList(raw.hopVia)
  if (hopVia === null)
  {
    return undefined
  }
  if (
    (raw.hopDepthExceeded !== undefined && raw.hopDepthExceeded !== true) ||
    (raw.hopDepthExceeded === true && raw.hopDistance !== undefined)
  )
  {
    return undefined
  }
  return {
    at: raw.at,
    title: raw.title,
    timing: raw.timing,
    ...(typeof raw.why === 'string' ? { why: raw.why } : {}),
    ...(resolved ? { resolved } : {}),
    ...(total !== undefined ? { resolvedTotal: total } : {}),
    ...(raw.stale === true ? { stale: true as const } : {}),
    ...(typeof raw.hopDistance === 'number' ? { hopDistance: raw.hopDistance } : {}),
    ...(hopVia ? { hopVia } : {}),
    ...(raw.hopDepthExceeded === true ? { hopDepthExceeded: true as const } : {}),
  }
}

// a stop is positional -> one invalid stop invalidates the whole narrative
function parseGraphJourney(value: unknown): GraphJourney | undefined
{
  const raw = asObject(value)
  if (
    !raw ||
    typeof raw.id !== 'string' ||
    typeof raw.title !== 'string' ||
    !Array.isArray(raw.stops)
  )
  {
    return undefined
  }
  if (raw.why !== undefined && typeof raw.why !== 'string')
  {
    return undefined
  }
  const stops = raw.stops.map(parseGraphJourneyStop)
  if (stops.length < 2 || stops.some((stop) => stop === undefined))
  {
    return undefined
  }
  return {
    id: raw.id,
    title: raw.title,
    ...(typeof raw.why === 'string' ? { why: raw.why } : {}),
    stops: stops as GraphJourneyStop[],
  }
}

function parseGraphRuntime(value: unknown): GraphRuntime | undefined
{
  const raw = asObject(value)
  if (!raw || typeof raw.key !== 'string' || typeof raw.label !== 'string')
  {
    return undefined
  }
  const roots = stringList(raw.roots)
  const resolved = raw.resolved === undefined ? undefined : stringList(raw.resolved)
  if (!roots || roots.length === 0 || resolved === null)
  {
    return undefined
  }
  const total = resolvedTotal(raw.resolvedTotal, resolved)
  if (
    total === null ||
    (raw.stale !== undefined && raw.stale !== true) ||
    (raw.stale === true && (resolved !== undefined || total !== undefined))
  )
  {
    return undefined
  }
  return {
    key: raw.key,
    label: raw.label,
    roots,
    ...(resolved ? { resolved } : {}),
    ...(total !== undefined ? { resolvedTotal: total } : {}),
    ...(raw.stale === true ? { stale: true as const } : {}),
  }
}

function normalizeViolations(edge: GraphEdge): GraphEdge
{
  const raw = (edge as unknown as JsonObject).violations
  const normalized = { ...edge }
  delete normalized.violations
  if (Array.isArray(raw))
  {
    normalized.violations = raw.filter((value): value is string => typeof value === 'string').sort()
  }
  return normalized
}

export function normalizeGraphJson(graph: CartographerGraph): CartographerGraph
{
  const rawRules = (graph as unknown as JsonObject).rules
  const rawJourneys = (graph as unknown as JsonObject).journeys
  const rawRuntimes = (graph as unknown as JsonObject).runtimes
  const normalized: CartographerGraph = {
    ...graph,
    edges: graph.edges.map(normalizeViolations),
  }
  delete normalized.rules
  delete normalized.journeys
  delete normalized.runtimes
  if (Array.isArray(rawRules))
  {
    normalized.rules = rawRules
      .map(parseGraphRule)
      .filter((rule): rule is GraphRule => rule !== undefined)
      .sort((left, right) =>
      {
        if (left.id < right.id)
        {
          return -1
        }
        return left.id > right.id ? 1 : 0
      })
  }
  if (Array.isArray(rawJourneys))
  {
    normalized.journeys = rawJourneys
      .map(parseGraphJourney)
      .filter((journey): journey is GraphJourney => journey !== undefined)
      .sort((left, right) =>
      {
        if (left.id < right.id)
        {
          return -1
        }
        return left.id > right.id ? 1 : 0
      })
  }
  if (Array.isArray(rawRuntimes))
  {
    normalized.runtimes = rawRuntimes
      .map(parseGraphRuntime)
      .filter((runtime): runtime is GraphRuntime => runtime !== undefined)
  }
  return normalized
}
