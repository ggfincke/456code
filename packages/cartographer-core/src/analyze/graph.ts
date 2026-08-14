// packages/cartographer-core/src/analyze/graph.ts
// build the imports graph for a repo via dependency-cruiser

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { cruise, type IFlattenedRuleSet } from 'dependency-cruiser'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'
import { GRAPH_SCHEMA_VERSION } from '../contracts/types.js'
import type {
  CartographerGraph,
  CommentMarker,
  GraphEdge,
  GraphGroup,
  GraphJourney,
  GraphJourneyStop,
  GraphMetrics,
  GraphNode,
  GraphRule,
  GraphRuntime,
  GraphSystem,
} from '../contracts/types.js'
import { loadAnnotations } from './annotations.js'
import { verifyCitations } from './citations.js'
import { fileDegrees } from './degrees.js'
import { computeCoChanges } from './cochange.js'
import {
  loadConfig,
  matchesRule,
  otherSystemId,
  resolveGroup,
  resolveSystem,
  type CartographerConfig,
} from './config.js'
import { findHop, JOURNEY_HOP_MAX_DEPTH } from './journeyHops.js'
import { buildDescriptionTable } from './describe.js'
import { buildSymbolTable, exportList, type ImportInfo } from './symbols.js'

// exclude whole path segments, never substrings -> src/distribution.ts,
// src/coverageReport.ts must survive while node_modules/dist/coverage dirs drop
const EXCLUDED_SEGMENTS = ['node_modules', 'dist', 'coverage']

function escapeRegex(value: string): string
{
  let escaped = ''
  for (const char of value)
  {
    escaped += '\\^$+?.()|{}[]'.includes(char) ? `\\${char}` : char
  }
  return escaped
}

function globSegmentRegex(segment: string): string
{
  let regex = ''
  let previousWasStar = false
  for (const char of segment)
  {
    if (char === '*')
    {
      if (!previousWasStar)
      {
        regex += '[^/]*'
      }
      previousWasStar = true
    }
    else
    {
      regex += escapeRegex(char)
      previousWasStar = false
    }
  }
  return regex
}

// translate the segment-aware config glob contract to an anchored regex
function globToRegex(pattern: string): string
{
  if (!pattern.includes('*'))
  {
    return `^${escapeRegex(pattern)}(?:$|/.*$)`
  }
  const segments: string[] = []
  for (const segment of pattern.split('/'))
  {
    if (segment !== '**' || segments.at(-1) !== '**')
    {
      segments.push(segment)
    }
  }
  let regex = '^'
  for (let index = 0; index < segments.length; index += 1)
  {
    const segment = segments[index]!
    if (segment === '**')
    {
      if (segments.length === 1)
      {
        regex += '.*'
      }
      else if (index === 0)
      {
        regex += '(?:|.*/)'
      }
      else if (index === segments.length - 1)
      {
        regex += '(?:|/.*)'
      }
      else
      {
        regex += '(?:/|/.*/)'
      }
      continue
    }
    regex += globSegmentRegex(segment)
    if (index < segments.length - 1 && segments[index + 1] !== '**')
    {
      regex += '/'
    }
  }
  return `${regex}$`
}

// both ends are repo-relative path globs compiled against cruise's resolved
// module paths, i.e. against graph nodes; external packages are not nodes
// (EXCLUDE_PATTERN drops them pre-validation), so such an end matches nothing
function compileRuleSet(rules: readonly GraphRule[]): IFlattenedRuleSet
{
  return {
    forbidden: rules.map((rule) =>
    {
      const allowVia = rule.allowVia?.map(globToRegex)
      return {
        name: rule.id,
        severity: rule.severity,
        from: {
          path: globToRegex(rule.from),
          ...(rule.verdict === 'allow-only' && allowVia
            ? { pathNot: allowVia.length === 1 ? allowVia[0]! : allowVia }
            : {}),
        },
        to: { path: globToRegex(rule.to) },
      }
    }),
  }
}

// config patterns are durable architecture claims; surface drift as additive
// warnings instead of letting a typo silently erase a group, system, or rule
function configStalenessMarkers(
  config: CartographerConfig,
  fileIds: readonly string[],
): CommentMarker[]
{
  const markers: CommentMarker[] = []
  const warn = (
    kind: 'group' | 'system' | 'rule',
    identity: string,
    field: string,
    pattern: string,
  ): void =>
  {
    if (!fileIds.some((fileId) => matchesRule(fileId, pattern)))
    {
      markers.push({
        kind: 'warning',
        text: `${kind} "${identity}" ${field} pattern "${pattern}" matches no files`,
      })
    }
  }
  for (const group of config.groups)
  {
    warn('group', group.name, 'match', group.match)
  }
  for (const system of config.systems)
  {
    warn('system', system.name, 'match', system.match)
  }
  for (const rule of config.rules ?? [])
  {
    warn('rule', rule.id, 'from', rule.from)
    warn('rule', rule.id, 'to', rule.to)
    for (const pattern of rule.allowVia ?? [])
    {
      warn('rule', rule.id, 'allowVia', pattern)
    }
  }
  return markers
}

function systemSlug(name: string): string
{
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function generateRankRules(config: CartographerConfig): GraphRule[]
{
  const ranked = config.systems.filter(
    (system): system is typeof system & { rank: number } => system.rank !== undefined,
  )
  const severity = config.layering === 'advisory' ? 'info' : 'error'
  const rules: GraphRule[] = []
  // distinct names can slug identically -> suffix repeats to keep ids unique
  const usedIds = new Map<string, number>()
  const uniqueId = (id: string): string =>
  {
    const seen = usedIds.get(id) ?? 0
    usedIds.set(id, seen + 1)
    return seen === 0 ? id : `${id}-${seen + 1}`
  }
  for (const deep of ranked)
  {
    for (const up of ranked)
    {
      if (deep.rank <= up.rank)
      {
        continue
      }
      rules.push({
        id: uniqueId(`rank:${systemSlug(deep.name)}->${systemSlug(up.name)}`),
        from: deep.match,
        to: up.match,
        verdict: 'forbid',
        severity,
        generated: true,
        why:
          `${up.name} (rank ${up.rank}) sits above ${deep.name} ` +
          `(rank ${deep.rank}) in the authored layering; dependencies must flow downward`,
      })
    }
  }
  return rules
}

interface CruisedDependency
{
  module: string
  resolved: string
  coreModule: boolean
  couldNotResolve: boolean
  dynamic: boolean
  valid: boolean
  rules?: CruisedRuleSummary[]
}

interface CruisedRuleSummary
{
  name: string
}

interface CruisedModule
{
  source: string
  dependencies: CruisedDependency[]
}

interface CruisedViolation
{
  rule: CruisedRuleSummary
  from: string
  to: string
}

interface CruisedResult
{
  modules: CruisedModule[]
  summary: { violations: CruisedViolation[] }
}

function edgeViolationKey(from: string, to: string): string
{
  return `${from}\u0000${to}`
}

function collectCruiseViolations(
  cruised: CruisedResult,
  ruleIds: ReadonlySet<string>,
): Map<string, Set<string>>
{
  const byEdge = new Map<string, Set<string>>()
  const add = (from: string, to: string, ruleId: string): void =>
  {
    if (!ruleIds.has(ruleId))
    {
      return
    }
    const key = edgeViolationKey(from, to)
    const ids = byEdge.get(key) ?? new Set<string>()
    ids.add(ruleId)
    byEdge.set(key, ids)
  }
  for (const module of cruised.modules)
  {
    for (const dependency of module.dependencies)
    {
      if (!dependency.valid)
      {
        for (const rule of dependency.rules ?? [])
        {
          add(module.source, dependency.resolved, rule.name)
        }
      }
    }
  }
  for (const violation of cruised.summary.violations)
  {
    add(violation.from, violation.to, violation.rule.name)
  }
  return byEdge
}

function foldedViolationIds(
  violations: ReadonlySet<string>,
  authoredRuleIds: ReadonlySet<string>,
  generatedRuleIds: ReadonlySet<string>,
): string[] | undefined
{
  const ids = [...violations].sort()
  const hasAuthored = ids.some((id) => authoredRuleIds.has(id))
  const hasGenerated = ids.some((id) => generatedRuleIds.has(id))
  const deduplicated =
    hasAuthored && hasGenerated ? ids.filter((id) => !generatedRuleIds.has(id)) : ids
  return deduplicated.length > 0 ? deduplicated : undefined
}

export interface BuildGraphOptions
{
  root: string
  scope?: string
  tsconfig?: string
  staticTree?: {
    gitRef: string
  }
}

export const DEFAULT_SCOPE = 'src'
const STATIC_TREE_GENERATED_AT = '1970-01-01T00:00:00.000Z'

// cruise() needs cwd pinned to the repo root; serialize the chdir window so
// concurrent buildGraph calls (MCP tools) can't race process-global cwd
let cwdLock: Promise<unknown> = Promise.resolve()

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T>
{
  const run = cwdLock.then(async () =>
  {
    const previousCwd = process.cwd()
    process.chdir(dir)
    try
    {
      return await fn()
    }
    finally
    {
      process.chdir(previousCwd)
    }
  })
  cwdLock = run.catch(() => undefined)
  return run
}

// ! solution-style configs (references only, no inputs) make extractTSConfig throw
// alias resolution still works w/o the parsed config -> degrade to compile defaults
function parseTsConfig(path: string, quiet = false): unknown
{
  try
  {
    return extractTSConfig(path)
  }
  catch (err)
  {
    if (!quiet)
    {
      console.error(
        `tsconfig "${path}" not usable for compilation ` +
          `(${err instanceof Error ? err.message.split('\n')[0] : err}) -> aliases still resolve`,
      )
    }
    return undefined
  }
}

interface ParsedTsConfigOptions
{
  paths?: Record<string, unknown>
  baseUrl?: string
}

interface SelectedTsConfig
{
  path: string
  parsed: unknown
}

// dirs never holding a project tsconfig; dot dirs are skipped separately
const DISCOVERY_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage'])
const DISCOVERY_MAX_DEPTH = 6

function parsedOptions(parsed: unknown): ParsedTsConfigOptions | undefined
{
  return (parsed as { options?: ParsedTsConfigOptions } | undefined)?.options
}

function hasPathAliases(parsed: unknown): boolean
{
  const paths = parsedOptions(parsed)?.paths
  return !!paths && Object.keys(paths).length > 0
}

// dep-cruiser injects baseUrl "./" when the parsed config lacks one & the plugin
// resolves that against process.cwd() -> aliases in subdirectory configs mis-anchor
// a truthy in-memory baseUrl makes the plugin anchor to dirname(configFile) instead
function synthesizeBaseUrl(path: string, parsed: unknown): unknown
{
  const options = parsedOptions(parsed)
  // in-memory only: the on-disk file stays w/o baseUrl so addMatchAll stays false
  // & bare-specifier resolution is not loosened
  if (options?.paths && !options.baseUrl)
  {
    options.baseUrl = NodePath.dirname(path)
  }
  return parsed
}

// single source of truth for the tsconfig-discovery contract (CLI/MCP help)
export const TSCONFIG_DISCOVERY_DESC =
  'tsconfig for path-alias resolution, relative to root. Default: discover ' +
  'tsconfig*.json under root and prefer the root-most paths-bearing config, ' +
  'else fall back to tsconfig.app.json then tsconfig.json.'

// walk root for tsconfig*.json candidates; skip output dirs & bound depth
function discoverTsConfigs(root: string): string[]
{
  const found: string[] = []
  const walk = (dir: string, depth: number): void =>
  {
    let entries
    try
    {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true })
    }
    catch
    {
      return
    }
    for (const entry of entries)
    {
      if (entry.isDirectory())
      {
        if (
          depth >= DISCOVERY_MAX_DEPTH ||
          entry.name.startsWith('.') ||
          DISCOVERY_SKIP_DIRS.has(entry.name)
        )
        {
          continue
        }
        walk(NodePath.join(dir, entry.name), depth + 1)
      }
      else if (
        entry.isFile() &&
        entry.name.startsWith('tsconfig') &&
        entry.name.endsWith('.json')
      )
      {
        found.push(NodePath.join(dir, entry.name))
      }
    }
  }
  walk(root, 0)
  return found
}

// root-most first: fewer path segments, then lexicographic
function byRootMost(a: string, b: string): number
{
  const depthA = a.split(NodePath.sep).length
  const depthB = b.split(NodePath.sep).length
  return depthA === depthB ? a.localeCompare(b) : depthA - depthB
}

// pick the tsconfig driving alias resolution: explicit flag wins, then the
// discovered paths-bearing config (repos often keep aliases in a subdirectory
// config), then root-most filename precedence
function resolveTsConfig(root: string, explicit?: string): SelectedTsConfig | undefined
{
  if (explicit)
  {
    const path = NodePath.resolve(root, explicit)
    if (!NodeFS.existsSync(path))
    {
      throw new Error(`tsconfig "${explicit}" not found under ${root}`)
    }
    return { path, parsed: synthesizeBaseUrl(path, parseTsConfig(path)) }
  }

  const parsedByPath = new Map<string, unknown>()
  for (const candidate of discoverTsConfigs(root))
  {
    parsedByPath.set(candidate, parseTsConfig(candidate, true))
  }
  const withAliases = [...parsedByPath.keys()]
    .filter((path) => hasPathAliases(parsedByPath.get(path)))
    .sort(byRootMost)
  if (withAliases.length > 0)
  {
    if (withAliases.length > 1)
    {
      // resolving conflicting aliases across configs in one pass is out of scope
      console.error(
        `note: multiple tsconfigs declare path aliases (` +
          `${withAliases.map((path) => NodePath.relative(root, path)).join(', ')}) -> ` +
          `using the root-most one; pass --tsconfig to pick another`,
      )
    }
    const path = withAliases[0]!
    return { path, parsed: synthesizeBaseUrl(path, parsedByPath.get(path)) }
  }

  // no paths-bearing config -> prior single-config behavior
  // solution-style roots (vite) keep options in tsconfig.app.json, not tsconfig.json
  for (const candidate of ['tsconfig.app.json', 'tsconfig.json'])
  {
    const path = NodePath.resolve(root, candidate)
    if (NodeFS.existsSync(path))
    {
      // re-parse loudly when the quiet discovery parse yielded nothing
      const parsed = parsedByPath.get(path) ?? parseTsConfig(path)
      return { path, parsed: synthesizeBaseUrl(path, parsed) }
    }
  }
  return undefined
}

export async function buildGraph(opts: BuildGraphOptions): Promise<CartographerGraph>
{
  const root = NodePath.resolve(opts.root)
  const scope = opts.scope ?? DEFAULT_SCOPE
  if (!NodeFS.existsSync(NodePath.resolve(root, scope)))
  {
    throw new Error(`scope "${scope}" not found under ${root} -> pass a different --scope`)
  }
  const tsConfig = resolveTsConfig(root, opts.tsconfig)
  const config = loadConfig(root)
  const excludedSegments = [...EXCLUDED_SEGMENTS, ...(config.exclude ?? [])]
  const escapedSegments = excludedSegments.map((segment) =>
    segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  const excludePattern = `(^|/)(?:${escapedSegments.join('|')})(?:/|$)`
  const excludeRegex = new RegExp(excludePattern)
  const isExcluded = (source: string): boolean => excludeRegex.test(source)
  const authoredRules = config.rules ?? []
  // citations are verified before the generated rules merge & the sort so id
  // sets & ordering stay identical to the unverified build
  const authoredGraphRules: GraphRule[] = verifyCitations(
    root,
    authoredRules.map((rule) => ({
      ...rule,
      severity: 'error',
    })),
  )
  const generatedRules = generateRankRules(config)
  const graphRules = [...authoredGraphRules, ...generatedRules].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const authoredRuleIds = new Set(authoredRules.map((rule) => rule.id))
  const generatedRuleIds = new Set(generatedRules.map((rule) => rule.id))

  const cruised = await withCwd(root, async () =>
  {
    // tsConfig feeds tsconfig-paths resolution so alias imports (@/, ~/) become edges
    const result = await cruise(
      [scope],
      {
        validate: true,
        ruleSet: compileRuleSet(graphRules),
        doNotFollow: { path: 'node_modules' },
        exclude: { path: excludePattern },
        tsPreCompilationDeps: true,
        outputType: 'json',
        ...(tsConfig ? { tsConfig: { fileName: tsConfig.path } } : {}),
      },
      undefined,
      tsConfig ? { tsConfig: tsConfig.parsed } : undefined,
    )
    const raw = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
    return JSON.parse(raw) as CruisedResult
  })
  const modules = cruised.modules

  // drop builtins & unresolved externals cruise reports as modules (path, shiki/core, ...)
  const repoModules = modules.filter(
    (m) => !isExcluded(m.source) && NodeFS.existsSync(NodePath.resolve(root, m.source)),
  )
  const moduleIds = repoModules.map((m) => m.source)
  const nodeIds = new Set(moduleIds)
  const markers = configStalenessMarkers(config, moduleIds)
  const edgeViolations = collectCruiseViolations(
    cruised,
    new Set(graphRules.map((rule) => rule.id)),
  )

  const fallbackSystemId = otherSystemId(config)
  const symbolTable = buildSymbolTable(root, repoModules)
  const descriptions = buildDescriptionTable(root, moduleIds, loadAnnotations(root))
  const nodes: GraphNode[] = repoModules.map((m) =>
  {
    const symbols = symbolTable.get(m.source)
    const described = descriptions.get(m.source)
    const system = resolveSystem(m.source, config)
    return {
      id: m.source,
      kind: 'file' as const,
      label: m.source.split('/').pop() ?? m.source,
      group: resolveGroup(m.source, config).id,
      ...(system ? { system: system.id } : fallbackSystemId ? { system: fallbackSystemId } : {}),
      ...(symbols ? { exports: exportList(symbols) } : {}),
      ...(symbols?.fileMarkers.length ? { markers: symbols.fileMarkers } : {}),
      ...(described ? { description: described.description } : {}),
      ...(described ? { descriptionSource: described.source } : {}),
      ...(described?.stale ? { descriptionStale: true as const } : {}),
      ...(described?.headerPathStale ? { headerPathStale: true as const } : {}),
    }
  })

  const edges: GraphEdge[] = []
  for (const m of repoModules)
  {
    const moduleSymbols = symbolTable.get(m.source)
    // cruise splits runtime & type-only declarations of one specifier into
    // separate deps -> fold all pulls into ONE edge per (from,to)
    const pullByTarget = new Map<string, EdgePull>()
    const targetOrder: string[] = []
    for (const dep of m.dependencies)
    {
      if (dep.coreModule || dep.couldNotResolve)
      {
        continue
      }
      if (!nodeIds.has(dep.resolved))
      {
        continue
      }
      // dynamic imports & namespace/star pulls stay symbol-less (unknown)
      const pulled = dep.dynamic
        ? undefined
        : (moduleSymbols?.importsBySpecifier.get(dep.module) ?? undefined)
      const violations =
        edgeViolations.get(edgeViolationKey(m.source, dep.resolved)) ?? new Set<string>()
      const acc = pullByTarget.get(dep.resolved)
      if (acc)
      {
        mergeEdgePull(acc, dep.dynamic, pulled, violations)
      }
      else
      {
        pullByTarget.set(dep.resolved, initEdgePull(dep.dynamic, pulled, violations))
        targetOrder.push(dep.resolved)
      }
    }
    for (const target of targetOrder)
    {
      const pull = pullByTarget.get(target)!
      // named import names are known when `names` is a concrete set
      const symbols = pull.names !== null ? [...pull.names].sort() : undefined
      const typeSymbols = pull.typeOnly.size > 0 ? [...pull.typeOnly].sort() : undefined
      const violations = foldedViolationIds(pull.violations, authoredRuleIds, generatedRuleIds)
      edges.push({
        id: `e${edges.length}`,
        from: m.source,
        to: target,
        kind: 'imports',
        ...(pull.dynamic ? { dynamic: true } : {}),
        ...(symbols ? { symbols } : {}),
        ...(pull.wholeTypeOnly ? { typeOnly: true } : {}),
        ...(typeSymbols ? { typeSymbols } : {}),
        ...(violations ? { violations } : {}),
      })
    }
  }

  const coChanges = opts.staticTree ? [] : computeCoChanges(root, moduleIds, scope)
  const systems = collectSystems(nodes, config, fallbackSystemId)
  const journeys = resolveJourneys(config, nodes, edges)
  const runtimes = resolveRuntimes(config, nodes)
  const metrics = computeMetrics(nodes, edges)
  // a high orphan share usually means path aliases didn't resolve
  // -> the graph silently under-reports edges
  if (nodes.length >= 40 && metrics.orphans / nodes.length > 0.25)
  {
    console.error(
      `note: ${metrics.orphans}/${nodes.length} files have no resolved imports -> ` +
        `path aliases may not have resolved; pass --tsconfig to point at the ` +
        `config declaring them (esp. when multiple tsconfigs define aliases)`,
    )
  }
  const graph: CartographerGraph = {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: opts.staticTree ? '.' : root,
    mode: 'imports',
    generatedAt: opts.staticTree ? STATIC_TREE_GENERATED_AT : new Date().toISOString(),
    ...(opts.staticTree ? { gitRef: opts.staticTree.gitRef } : gitRef(root)),
    scope,
    nodes,
    edges,
    groups: collectGroups(nodes, config),
    ...(markers.length > 0 ? { markers } : {}),
    ...(systems.length > 0 ? { systems } : {}),
    ...(graphRules.length > 0 ? { rules: graphRules } : {}),
    ...(journeys.length > 0 ? { journeys } : {}),
    ...(runtimes.length > 0 ? { runtimes } : {}),
    ...(coChanges.length > 0 ? { coChanges } : {}),
    metrics,
  }
  return opts.staticTree ? orderStaticTreeGraph(graph) : graph
}

// static artifacts must not depend on cruise traversal, temp paths, or time
function orderStaticTreeGraph(graph: CartographerGraph): CartographerGraph
{
  const nodes = [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))
  const edges = [...graph.edges]
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
    .map((edge, index) => ({ ...edge, id: `e${index}` }))
  return { ...graph, nodes, edges }
}

// merged pull evidence for one (from,to) pair across all its declarations
interface EdgePull
{
  dynamic: boolean
  // union of pulled names; null -> unknown (namespace/dynamic/no symbol data)
  names: Set<string> | null
  typeOnly: Set<string>
  wholeTypeOnly: boolean
  violations: Set<string>
}

function initEdgePull(
  dynamic: boolean,
  pulled: ImportInfo | undefined,
  violations: ReadonlySet<string>,
): EdgePull
{
  const names = !pulled || pulled.names === null ? null : new Set(pulled.names)
  return {
    dynamic,
    names,
    typeOnly: names === null ? new Set() : new Set(pulled?.typeOnly ?? []),
    wholeTypeOnly: pulled?.wholeTypeOnly ?? false,
    violations: new Set(violations),
  }
}

// fold one dep's pull into the pair accumulator; runtime evidence wins
function mergeEdgePull(
  acc: EdgePull,
  dynamic: boolean,
  pulled: ImportInfo | undefined,
  violations: ReadonlySet<string>,
): void
{
  acc.dynamic = acc.dynamic && dynamic
  for (const violation of violations)
  {
    acc.violations.add(violation)
  }
  if (!pulled)
  {
    // unknown pull (dynamic/no symbol data) -> names unknowable, not type-only
    acc.names = null
    acc.typeOnly.clear()
    acc.wholeTypeOnly = false
    return
  }
  // names already pulled at runtime keep runtime status
  const runtimeBefore = new Set<string>()
  for (const name of acc.names ?? [])
  {
    if (!acc.typeOnly.has(name))
    {
      runtimeBefore.add(name)
    }
  }
  if (pulled.names === null)
  {
    acc.names = null
  }
  else if (acc.names !== null)
  {
    for (const name of pulled.names)
    {
      acc.names.add(name)
    }
  }
  for (const name of pulled.typeOnly)
  {
    if (!runtimeBefore.has(name))
    {
      acc.typeOnly.add(name)
    }
  }
  if (pulled.names !== null)
  {
    // a runtime pull of a name clears its type-only mark
    for (const name of pulled.names)
    {
      if (!pulled.typeOnly.has(name))
      {
        acc.typeOnly.delete(name)
      }
    }
  }
  if (acc.names === null)
  {
    acc.typeOnly.clear()
  }
  acc.wholeTypeOnly = acc.wholeTypeOnly && pulled.wholeTypeOnly
}

// a broad stop glob can name half the repo -> keep the recorded witness set
// bounded & deterministic (sorted file ids, first N); serialization only, the
// hop search & staleness still see every match
const MAX_JOURNEY_RESOLVED = 100

// authored lifecycle narratives re-verified against this build: every stop's
// `at` resolves through the one hardened matcher, & every hop between
// consecutive resolved stops is a real static-import path or nothing
function resolveJourneys(
  config: CartographerConfig,
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphJourney[]
{
  const authored = config.journeys ?? []
  if (authored.length === 0)
  {
    return []
  }
  const fileIds = nodes.map((node) => node.id).sort()
  const adjacency = new Map<string, string[]>()
  for (const edge of edges)
  {
    const outgoing = adjacency.get(edge.from)
    if (outgoing)
    {
      outgoing.push(edge.to)
    }
    else
    {
      adjacency.set(edge.from, [edge.to])
    }
  }

  return authored.map((journey) =>
  {
    const stops: GraphJourneyStop[] = []
    // every file the previous stop matched; undefined -> stale, so no hop
    let previous: string[] | undefined
    for (const stop of journey.stops)
    {
      // an absent hopDistance is published as "no static path" -> search the
      // full match set, never the display-capped slice, or the witness cap
      // would manufacture that claim
      const matched = fileIds.filter((id) => matchesRule(id, stop.at))
      const hopSearch =
        previous && matched.length > 0
          ? findHop(adjacency, previous, new Set(matched), JOURNEY_HOP_MAX_DEPTH)
          : undefined
      const hop = hopSearch?.hop
      stops.push({
        at: stop.at,
        title: stop.title,
        timing: stop.timing,
        ...(stop.why ? { why: stop.why } : {}),
        ...(matched.length > 0
          ? {
              resolved: matched.slice(0, MAX_JOURNEY_RESOLVED),
              resolvedTotal: matched.length,
            }
          : { stale: true as const }),
        ...(hop ? { hopDistance: hop.distance, hopVia: hop.via } : {}),
        ...(hopSearch?.depthExceeded ? { hopDepthExceeded: true as const } : {}),
      })
      previous = matched.length > 0 ? matched : undefined
    }
    return {
      id: journey.id,
      title: journey.title,
      ...(journey.why ? { why: journey.why } : {}),
      stops,
    }
  })
}

// a root glob can name a whole directory -> keep the witness set bounded &
// deterministic, exactly like the journey stop resolution above
const MAX_RUNTIME_RESOLVED = 100

// authored process entry points re-verified against this build: every root
// resolves through the one hardened matcher, & a runtime whose roots match
// nothing announces its own rot rather than silently reaching zero files
function resolveRuntimes(config: CartographerConfig, nodes: GraphNode[]): GraphRuntime[]
{
  const authored = config.runtimes ?? []
  if (authored.length === 0)
  {
    return []
  }
  const fileIds = nodes.map((node) => node.id).sort()
  return authored.map((runtime) =>
  {
    const matched = fileIds.filter((id) => runtime.roots.some((root) => matchesRule(id, root)))
    const resolved = matched.slice(0, MAX_RUNTIME_RESOLVED)
    return {
      key: runtime.key,
      label: runtime.label,
      roots: runtime.roots,
      ...(resolved.length > 0
        ? { resolved, resolvedTotal: matched.length }
        : { stale: true as const }),
    }
  })
}

// authored systems in rule order; duplicate names collapse to one summary
function collectSystems(
  nodes: GraphNode[],
  config: CartographerConfig,
  fallbackSystemId: string | undefined,
): GraphSystem[]
{
  const fileCounts = new Map<string, number>()
  for (const node of nodes)
  {
    if (node.system !== undefined)
    {
      fileCounts.set(node.system, (fileCounts.get(node.system) ?? 0) + 1)
    }
  }

  const systems: GraphSystem[] = []
  const seen = new Set<string>()
  for (const rule of config.systems)
  {
    const fileCount = fileCounts.get(rule.name)
    if (!fileCount || seen.has(rule.name))
    {
      continue
    }
    seen.add(rule.name)
    systems.push({
      id: rule.name,
      label: rule.name,
      ...(rule.description ? { description: rule.description } : {}),
      fileCount,
      source: 'authored',
      ...(rule.rank !== undefined ? { rank: rule.rank } : {}),
    })
  }
  const fallbackCount = fallbackSystemId ? (fileCounts.get(fallbackSystemId) ?? 0) : 0
  if (fallbackSystemId && fallbackCount > 0)
  {
    systems.push({
      id: fallbackSystemId,
      label: otherSystemLabel(config),
      description: 'Files outside the authored system rules.',
      fileCount: fallbackCount,
      source: 'fallback',
    })
  }
  return systems
}

function otherSystemLabel(config: CartographerConfig): string
{
  const used = new Set(config.systems.map((rule) => rule.name))
  if (!used.has('Other'))
  {
    return 'Other'
  }
  let label = 'Unmatched'
  let suffix = 2
  while (used.has(label))
  {
    label = `Unmatched ${suffix}`
    suffix += 1
  }
  return label
}

// config-defined groups in rule order, heuristic groups alphabetical after
function collectGroups(nodes: GraphNode[], config: CartographerConfig): GraphGroup[]
{
  const fileCounts = new Map<string, number>()
  for (const node of nodes)
  {
    fileCounts.set(node.group, (fileCounts.get(node.group) ?? 0) + 1)
  }

  const groups: GraphGroup[] = []
  const seen = new Set<string>()
  for (const rule of config.groups)
  {
    const fileCount = fileCounts.get(rule.name)
    if (!fileCount || seen.has(rule.name))
    {
      continue
    }
    seen.add(rule.name)
    groups.push({
      id: rule.name,
      label: rule.name,
      ...(rule.description ? { description: rule.description } : {}),
      fileCount,
    })
  }
  const heuristic = [...fileCounts.keys()]
    .filter((id) => !seen.has(id))
    .sort((a, b) => a.localeCompare(b))
  for (const id of heuristic)
  {
    groups.push({ id, label: id, fileCount: fileCounts.get(id) ?? 0 })
  }
  return groups
}

function gitRef(root: string): { gitRef?: string }
{
  try
  {
    const ref = NodeChildProcess.execSync('git rev-parse --short HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return ref ? { gitRef: ref } : {}
  }
  catch
  {
    return {}
  }
}

function computeMetrics(nodes: GraphNode[], edges: GraphEdge[]): GraphMetrics
{
  const { fanIn, fanOut } = fileDegrees(
    edges,
    nodes.map((node) => node.id),
  )
  let maxFanIn = 0
  let maxFanOut = 0
  for (const count of fanIn.values())
  {
    maxFanIn = Math.max(maxFanIn, count)
  }
  for (const count of fanOut.values())
  {
    maxFanOut = Math.max(maxFanOut, count)
  }

  let orphans = 0
  for (const node of nodes)
  {
    if ((fanIn.get(node.id) ?? 0) === 0 && (fanOut.get(node.id) ?? 0) === 0)
    {
      orphans += 1
    }
  }

  return {
    cycles: countCycles(nodes, edges),
    orphans,
    maxFanIn,
    maxFanOut,
  }
}

// kosaraju SCC count -> components w/ more than one node, plus self-loops
function countCycles(nodes: GraphNode[], edges: GraphEdge[]): number
{
  const forward = new Map<string, string[]>()
  const reverse = new Map<string, string[]>()
  for (const node of nodes)
  {
    forward.set(node.id, [])
    reverse.set(node.id, [])
  }
  let selfLoops = 0
  for (const edge of edges)
  {
    if (edge.from === edge.to)
    {
      selfLoops += 1
      continue
    }
    forward.get(edge.from)?.push(edge.to)
    reverse.get(edge.to)?.push(edge.from)
  }

  const visited = new Set<string>()
  const order: string[] = []
  for (const node of nodes)
  {
    if (visited.has(node.id))
    {
      continue
    }
    // iterative post-order DFS
    const stack: Array<{ id: string; index: number }> = [{ id: node.id, index: 0 }]
    visited.add(node.id)
    while (stack.length > 0)
    {
      const frame = stack[stack.length - 1]!
      const neighbors = forward.get(frame.id) ?? []
      if (frame.index < neighbors.length)
      {
        const next = neighbors[frame.index]!
        frame.index += 1
        if (!visited.has(next))
        {
          visited.add(next)
          stack.push({ id: next, index: 0 })
        }
      }
      else
      {
        order.push(frame.id)
        stack.pop()
      }
    }
  }

  const assigned = new Set<string>()
  let cyclicComponents = 0
  for (let i = order.length - 1; i >= 0; i -= 1)
  {
    const rootId = order[i]!
    if (assigned.has(rootId))
    {
      continue
    }
    let size = 0
    const stack = [rootId]
    assigned.add(rootId)
    while (stack.length > 0)
    {
      const id = stack.pop() as string
      size += 1
      for (const prev of reverse.get(id) ?? [])
      {
        if (!assigned.has(prev))
        {
          assigned.add(prev)
          stack.push(prev)
        }
      }
    }
    if (size > 1)
    {
      cyclicComponents += 1
    }
  }

  return cyclicComponents + selfLoops
}
