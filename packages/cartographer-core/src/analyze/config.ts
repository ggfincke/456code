// packages/cartographer-core/src/analyze/config.ts
// optional .cartographer.json -> grouping, systems & dependency rules

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { matchesRule } from './glob.js'

// the matcher lives in the fs-free glob module; re-exported here so existing
// config consumers (& the web bridge) keep one import point each
export { matchesRule } from './glob.js'

export interface GroupRule
{
  // glob (* & **) or plain path prefix
  match: string
  name: string
  description?: string
}

export interface SystemRule extends GroupRule
{
  rank?: number
}

export type LayeringMode = 'strict' | 'advisory'

export interface RuleEnforcement
{
  mechanism: string
  file?: string
  line?: number
  rule?: string
}

export interface AuthoredGraphRule
{
  id: string
  from: string
  to: string
  verdict: 'forbid' | 'allow-only'
  allowVia?: string[]
  why?: string
  enforcedBy?: RuleEnforcement
}

export interface AuthoredJourneyStop
{
  // glob (* & **) or plain path prefix, matched like a group/system rule
  at: string
  title: string
  timing: 'immediate' | 'transaction' | 'deferred'
  why?: string
}

export interface AuthoredJourney
{
  id: string
  title: string
  why?: string
  // at least two stops -> a journey is a path, not a point
  stops: AuthoredJourneyStop[]
}

export interface AuthoredRuntime
{
  // open key (kebab-case), not a closed enum — target repos name their own
  // processes (browser / worker / cli / mcp / lambda / ...)
  key: string
  label: string
  // globs naming the files a process starts executing at; roots cannot be
  // inferred (a worker entry hangs off `new Worker(new URL(...))`, a browser
  // entry off index.html), so they are authored
  roots: string[]
}

export interface CartographerConfig
{
  groups: GroupRule[]
  systems: SystemRule[]
  rules?: AuthoredGraphRule[]
  journeys?: AuthoredJourney[]
  runtimes?: AuthoredRuntime[]
  groupDepth: number
  layering?: LayeringMode
  exclude?: string[]
}

export interface ResolvedGroup
{
  id: string
  label: string
  description?: string
}

export type ResolvedSystem = ResolvedGroup

export const CONFIG_FILE = '.cartographer.json'
const DEFAULT_GROUP_DEPTH = 2
const ROOT_GROUP = '(root)'

export function loadConfig(root: string): CartographerConfig
{
  const path = NodePath.join(root, CONFIG_FILE)
  if (!NodeFS.existsSync(path))
  {
    return {
      groups: [],
      systems: [],
      rules: [],
      journeys: [],
      runtimes: [],
      groupDepth: DEFAULT_GROUP_DEPTH,
      exclude: [],
      layering: 'strict',
    }
  }
  let parsed: unknown
  try
  {
    parsed = JSON.parse(NodeFS.readFileSync(path, 'utf-8'))
  }
  catch (err)
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    })
  }
  const raw = parsed as {
    groups?: unknown
    systems?: unknown
    rules?: unknown
    journeys?: unknown
    runtimes?: unknown
    groupDepth?: unknown
    layering?: unknown
    exclude?: unknown
  }
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((rule, index) => parseRule(rule, index, 'groups'))
    : []
  if (Array.isArray(raw.systems) && raw.systems.length > MAX_SYSTEM_ENTRIES)
  {
    throw new Error(`invalid ${CONFIG_FILE}: "systems" exceeds ${MAX_SYSTEM_ENTRIES} entries`)
  }
  const systems = Array.isArray(raw.systems)
    ? raw.systems.map((rule, index) => parseRule(rule, index, 'systems'))
    : []
  const rules = parseDependencyRules(raw.rules)
  const journeys = parseJourneys(raw.journeys)
  const runtimes = parseRuntimes(raw.runtimes)
  if (raw.layering !== undefined && raw.layering !== 'strict' && raw.layering !== 'advisory')
  {
    throw new Error(`invalid ${CONFIG_FILE}: "layering" must be "strict" or "advisory"`)
  }
  const layering = raw.layering ?? 'strict'
  const groupDepth =
    typeof raw.groupDepth === 'number' && Number.isInteger(raw.groupDepth) && raw.groupDepth >= 1
      ? raw.groupDepth
      : DEFAULT_GROUP_DEPTH
  const exclude = parseExcludeSegments(raw.exclude)
  return { groups, systems, rules, journeys, runtimes, groupDepth, layering, exclude }
}

// additive walker exclusions: whole path segments only, mirroring the built-in
// node_modules/dist/coverage drops -> no globs, no separators, bounded count
const MAX_EXCLUDE_SEGMENTS = 32
function parseExcludeSegments(raw: unknown): string[]
{
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_EXCLUDE_SEGMENTS)
  {
    throw new Error(
      `invalid ${CONFIG_FILE}: "exclude" must be an array of at most ${MAX_EXCLUDE_SEGMENTS} segments`,
    )
  }
  return raw.map((segment) =>
  {
    if (
      typeof segment !== 'string' ||
      segment.length === 0 ||
      segment.length > MAX_NAME_LENGTH ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment === '.' ||
      segment === '..' ||
      /[\x00-\x1f]/.test(segment)
    )
    {
      throw new Error(`invalid ${CONFIG_FILE}: "exclude" entries must be plain path segments`)
    }
    return segment
  })
}

// authored names/patterns feed generated docs & composite identities ->
// reject empties, control chars, & unbounded lengths (F36); structural
// collision-safety for valid arbitrary names is F18's separate concern
const MAX_NAME_LENGTH = 200
const MAX_PATTERN_LENGTH = 1024
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_RULE_ID_LENGTH = 64
export const MAX_RULES = 200
// ranked systems fan out into O(n^2) generated rank rules -> cap the authored
// entries so the compiled rule set stays bounded; distinct from the display cap
// `MAX_SYSTEMS` in ./systemHierarchy.ts, which bounds what one canvas shows
export const MAX_SYSTEM_ENTRIES = 16
export const MAX_JOURNEYS = 50
export const MAX_JOURNEY_STOPS = 32
// one tint slot per runtime -> the palette size is the cap
export const MAX_RUNTIMES = 6
export const MAX_RUNTIME_ROOTS = 8
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// C0/C1 control characters incl. NUL, excluding ordinary whitespace handling
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

function parseRule(rule: unknown, index: number, field: 'groups' | 'systems'): SystemRule
{
  const r = rule as Record<string, unknown>
  if (typeof r?.match !== 'string' || typeof r?.name !== 'string')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${field}[${index}] needs string "match" & "name"`)
  }
  const where = `${field}[${index}]`
  if (r.name.trim() === '')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "name" must not be empty`)
  }
  if (CONTROL_CHARS.test(r.name))
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "name" has control characters`)
  }
  if (r.name.length > MAX_NAME_LENGTH)
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "name" exceeds ${MAX_NAME_LENGTH} chars`)
  }
  if (r.match.trim() === '' || CONTROL_CHARS.test(r.match))
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "match" is empty or has control characters`)
  }
  if (r.match.length > MAX_PATTERN_LENGTH)
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "match" exceeds ${MAX_PATTERN_LENGTH} chars`)
  }
  if (
    typeof r.description === 'string' &&
    (CONTROL_CHARS.test(r.description) || r.description.length > MAX_DESCRIPTION_LENGTH)
  )
  {
    throw new Error(
      `invalid ${CONFIG_FILE}: ${where} "description" has control characters or is too long`,
    )
  }
  if (
    field === 'systems' &&
    r.rank !== undefined &&
    (typeof r.rank !== 'number' || !Number.isInteger(r.rank) || r.rank < 0)
  )
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "rank" must be a non-negative integer`)
  }
  return {
    match: r.match,
    name: r.name,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(field === 'systems' && typeof r.rank === 'number' ? { rank: r.rank } : {}),
  }
}

function assertRuleString(value: string, where: string, field: string, maxLength: number): void
{
  if (value.trim() === '' || CONTROL_CHARS.test(value))
  {
    throw new Error(
      `invalid ${CONFIG_FILE}: ${where} "${field}" is empty or has control characters`,
    )
  }
  if (value.length > maxLength)
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "${field}" exceeds ${maxLength} chars`)
  }
}

function parseEnforcement(value: unknown, where: string): RuleEnforcement | undefined
{
  if (value === undefined)
  {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "enforcedBy" must be an object`)
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.mechanism !== 'string')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "enforcedBy.mechanism" must be a string`)
  }
  assertRuleString(raw.mechanism, where, 'enforcedBy.mechanism', MAX_NAME_LENGTH)
  if (raw.file !== undefined && typeof raw.file !== 'string')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "enforcedBy.file" must be a string`)
  }
  if (typeof raw.file === 'string')
  {
    assertRuleString(raw.file, where, 'enforcedBy.file', MAX_PATTERN_LENGTH)
  }
  if (
    raw.line !== undefined &&
    (typeof raw.line !== 'number' || !Number.isInteger(raw.line) || raw.line < 1)
  )
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "enforcedBy.line" must be a positive integer`)
  }
  if (raw.rule !== undefined && typeof raw.rule !== 'string')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "enforcedBy.rule" must be a string`)
  }
  if (typeof raw.rule === 'string')
  {
    assertRuleString(raw.rule, where, 'enforcedBy.rule', MAX_NAME_LENGTH)
  }
  return {
    mechanism: raw.mechanism,
    ...(typeof raw.file === 'string' ? { file: raw.file } : {}),
    ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
    ...(typeof raw.rule === 'string' ? { rule: raw.rule } : {}),
  }
}

function parseDependencyRule(rule: unknown, index: number): AuthoredGraphRule
{
  const raw = rule as Record<string, unknown>
  const where = `rules[${index}]`
  if (
    typeof raw?.id !== 'string' ||
    typeof raw?.from !== 'string' ||
    typeof raw?.to !== 'string' ||
    (raw?.verdict !== 'forbid' && raw?.verdict !== 'allow-only')
  )
  {
    throw new Error(
      `invalid ${CONFIG_FILE}: ${where} needs string "id", "from" & "to", plus verdict "forbid" or "allow-only"`,
    )
  }
  assertRuleString(raw.id, where, 'id', MAX_RULE_ID_LENGTH)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id))
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "id" must be kebab-case`)
  }
  assertRuleString(raw.from, where, 'from', MAX_PATTERN_LENGTH)
  assertRuleString(raw.to, where, 'to', MAX_PATTERN_LENGTH)
  const allowVia =
    typeof raw.allowVia === 'string'
      ? [raw.allowVia]
      : Array.isArray(raw.allowVia) && raw.allowVia.every((entry) => typeof entry === 'string')
        ? raw.allowVia
        : undefined
  if (raw.verdict === 'allow-only' && (!allowVia || allowVia.length === 0))
  {
    throw new Error(
      `invalid ${CONFIG_FILE}: ${where} "allowVia" needs a string or non-empty string array for "allow-only"`,
    )
  }
  if (raw.verdict === 'forbid' && raw.allowVia !== undefined)
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "allowVia" is only valid for "allow-only"`)
  }
  if (allowVia)
  {
    for (const [allowIndex, pattern] of allowVia.entries())
    {
      assertRuleString(pattern, where, `allowVia[${allowIndex}]`, MAX_PATTERN_LENGTH)
    }
  }
  if (
    typeof raw.why === 'string' &&
    (CONTROL_CHARS.test(raw.why) || raw.why.length > MAX_DESCRIPTION_LENGTH)
  )
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "why" has control characters or is too long`)
  }
  const enforcedBy = parseEnforcement(raw.enforcedBy, where)
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    verdict: raw.verdict,
    ...(allowVia ? { allowVia } : {}),
    ...(typeof raw.why === 'string' ? { why: raw.why } : {}),
    ...(enforcedBy ? { enforcedBy } : {}),
  }
}

function parseDependencyRules(value: unknown): AuthoredGraphRule[]
{
  if (!Array.isArray(value))
  {
    return []
  }
  if (value.length > MAX_RULES)
  {
    throw new Error(`invalid ${CONFIG_FILE}: "rules" exceeds ${MAX_RULES} entries`)
  }
  const rules = value.map(parseDependencyRule)
  const seen = new Set<string>()
  for (const [index, rule] of rules.entries())
  {
    if (seen.has(rule.id))
    {
      throw new Error(`invalid ${CONFIG_FILE}: rules[${index}] duplicates id "${rule.id}"`)
    }
    seen.add(rule.id)
  }
  return rules
}

const JOURNEY_TIMINGS = ['immediate', 'transaction', 'deferred'] as const

function parseJourneyStop(stop: unknown, journeyIndex: number, index: number): AuthoredJourneyStop
{
  const raw = stop as Record<string, unknown>
  const where = `journeys[${journeyIndex}].stops[${index}]`
  if (typeof raw?.at !== 'string' || typeof raw?.title !== 'string')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} needs string "at" & "title"`)
  }
  if (
    typeof raw.timing !== 'string' ||
    !(JOURNEY_TIMINGS as readonly string[]).includes(raw.timing)
  )
  {
    throw new Error(
      `invalid ${CONFIG_FILE}: ${where} "timing" must be one of ${JOURNEY_TIMINGS.join(', ')}`,
    )
  }
  assertRuleString(raw.at, where, 'at', MAX_PATTERN_LENGTH)
  assertRuleString(raw.title, where, 'title', MAX_NAME_LENGTH)
  if (
    typeof raw.why === 'string' &&
    (CONTROL_CHARS.test(raw.why) || raw.why.length > MAX_DESCRIPTION_LENGTH)
  )
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "why" has control characters or is too long`)
  }
  return {
    at: raw.at,
    title: raw.title,
    timing: raw.timing as AuthoredJourneyStop['timing'],
    ...(typeof raw.why === 'string' ? { why: raw.why } : {}),
  }
}

function parseJourney(journey: unknown, index: number): AuthoredJourney
{
  const raw = journey as Record<string, unknown>
  const where = `journeys[${index}]`
  if (typeof raw?.id !== 'string' || typeof raw?.title !== 'string')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} needs string "id" & "title"`)
  }
  assertRuleString(raw.id, where, 'id', MAX_RULE_ID_LENGTH)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id))
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "id" must be kebab-case`)
  }
  assertRuleString(raw.title, where, 'title', MAX_NAME_LENGTH)
  if (
    typeof raw.why === 'string' &&
    (CONTROL_CHARS.test(raw.why) || raw.why.length > MAX_DESCRIPTION_LENGTH)
  )
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "why" has control characters or is too long`)
  }
  if (!Array.isArray(raw.stops) || raw.stops.length < 2)
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "stops" must be an array of 2 or more stops`)
  }
  if (raw.stops.length > MAX_JOURNEY_STOPS)
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "stops" exceeds ${MAX_JOURNEY_STOPS} entries`)
  }
  const stops = raw.stops.map((stop, stopIndex) => parseJourneyStop(stop, index, stopIndex))
  return {
    id: raw.id,
    title: raw.title,
    ...(typeof raw.why === 'string' ? { why: raw.why } : {}),
    stops,
  }
}

function parseJourneys(value: unknown): AuthoredJourney[]
{
  if (!Array.isArray(value))
  {
    return []
  }
  if (value.length > MAX_JOURNEYS)
  {
    throw new Error(`invalid ${CONFIG_FILE}: "journeys" exceeds ${MAX_JOURNEYS} entries`)
  }
  const journeys = value.map(parseJourney)
  const seen = new Set<string>()
  for (const [index, journey] of journeys.entries())
  {
    if (seen.has(journey.id))
    {
      throw new Error(`invalid ${CONFIG_FILE}: journeys[${index}] duplicates id "${journey.id}"`)
    }
    seen.add(journey.id)
  }
  return journeys
}

function parseRuntime(runtime: unknown, index: number): AuthoredRuntime
{
  const raw = runtime as Record<string, unknown>
  const where = `runtimes[${index}]`
  if (typeof raw?.key !== 'string' || typeof raw?.label !== 'string')
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} needs string "key" & "label"`)
  }
  assertRuleString(raw.key, where, 'key', MAX_RULE_ID_LENGTH)
  if (!KEBAB_CASE.test(raw.key))
  {
    throw new Error(`invalid ${CONFIG_FILE}: ${where} "key" must be kebab-case`)
  }
  assertRuleString(raw.label, where, 'label', MAX_NAME_LENGTH)
  if (!Array.isArray(raw.roots) || raw.roots.length < 1 || raw.roots.length > MAX_RUNTIME_ROOTS)
  {
    throw new Error(
      `invalid ${CONFIG_FILE}: ${where} "roots" must be an array of 1 to ${MAX_RUNTIME_ROOTS} globs`,
    )
  }
  const roots = raw.roots.map((root, rootIndex) =>
  {
    if (typeof root !== 'string')
    {
      throw new Error(`invalid ${CONFIG_FILE}: ${where}.roots[${rootIndex}] must be a string`)
    }
    assertRuleString(root, `${where}.roots[${rootIndex}]`, 'root', MAX_PATTERN_LENGTH)
    return root
  })
  return { key: raw.key, label: raw.label, roots }
}

function parseRuntimes(value: unknown): AuthoredRuntime[]
{
  if (!Array.isArray(value))
  {
    return []
  }
  if (value.length > MAX_RUNTIMES)
  {
    throw new Error(`invalid ${CONFIG_FILE}: "runtimes" exceeds ${MAX_RUNTIMES} entries`)
  }
  const runtimes = value.map(parseRuntime)
  const seen = new Set<string>()
  for (const [index, runtime] of runtimes.entries())
  {
    if (seen.has(runtime.key))
    {
      throw new Error(`invalid ${CONFIG_FILE}: runtimes[${index}] duplicates key "${runtime.key}"`)
    }
    seen.add(runtime.key)
  }
  return runtimes
}

// fallback system bucket id when authored systems exist; kept unique
// against the authored rule names
export function otherSystemId(config: CartographerConfig): string | undefined
{
  if (config.systems.length === 0)
  {
    return undefined
  }
  const used = new Set(config.systems.map((rule) => rule.name))
  let id = 'Other'
  while (used.has(id))
  {
    id = `_${id}`
  }
  return id
}

function resolveAuthoredRule(
  fileId: string,
  rules: readonly GroupRule[],
): ResolvedGroup | undefined
{
  const rule = rules.find((candidate) => matchesRule(fileId, candidate.match))
  if (!rule)
  {
    return undefined
  }
  return {
    id: rule.name,
    label: rule.name,
    ...(rule.description ? { description: rule.description } : {}),
  }
}

// first matching authored system wins; unmatched files remain unassigned
export function resolveSystem(
  fileId: string,
  config: CartographerConfig,
): ResolvedSystem | undefined
{
  return resolveAuthoredRule(fileId, config.systems)
}

// first matching rule wins; heuristic prefix group otherwise
export function resolveGroup(fileId: string, config: CartographerConfig): ResolvedGroup
{
  const authored = resolveAuthoredRule(fileId, config.groups)
  if (authored)
  {
    return authored
  }
  const prefix = heuristicGroup(fileId, config.groupDepth)
  return { id: prefix, label: prefix }
}

function heuristicGroup(fileId: string, depth: number): string
{
  const dir = NodePath.dirname(fileId)
  if (dir === '.')
  {
    return ROOT_GROUP
  }
  return dir.split('/').slice(0, depth).join('/')
}
