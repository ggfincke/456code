// scripts/smoke-dogfood-architecture.ts
// build and verify the repository's dogfood architecture graph

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'

interface DogfoodConfig
{
  groupDepth: number
  groups: Array<{ name: string }>
  systems: Array<{ name: string; rank?: number }>
  rules: Array<{ id: string; verdict: string; allowVia?: unknown }>
  runtimes: Array<{ key: string; roots: string[] }>
  journeys: Array<{ id: string; stops: Array<{ at: string }> }>
}

interface DogfoodGraph
{
  scope: string
  nodes: Array<{ id: string; headerPathStale?: true }>
  groups: Array<{ id: string; label: string; fileCount: number }>
  systems?: Array<{ id: string; fileCount: number; rank?: number }>
  rules?: Array<{ id: string }>
  markers?: Array<{ kind: string; text: string }>
  journeys?: Array<{
    id: string
    stops: Array<{ at: string; resolved?: string[]; resolvedTotal?: number; stale?: true }>
  }>
  runtimes?: Array<{
    key: string
    resolved?: string[]
    resolvedTotal?: number
    stale?: true
  }>
}

const expectedGroups = [
  'Desktop Client',
  'Mobile Client',
  'Server Runtime',
  'Web Client',
  'Cartographer Core',
  'Client Runtime',
  'Contracts',
  'Provider Adapters',
  'Platform Integrations',
  'Shared Runtime',
  'Repository Tooling',
  'Test Suites',
] as const

const expectedSystemRanks = new Map<string, number>([
  ['Client Surfaces', 0],
  ['Test Suites', 0],
  ['Repository Tooling', 0],
  ['Server Runtime', 1],
  ['Client Runtime', 1],
  ['Platform Adapters', 2],
  ['Cartographer Core', 2],
  ['Shared Runtime', 3],
  ['Contracts', 4],
])

const expectedRuleIds = [
  'packages-never-import-apps',
  'clients-never-import-server-source',
  'contracts-stay-schema-only',
  'client-runtime-subpath-allow-only',
  'contracts-entrypoints-allow-only',
  'cartographer-core-stays-standalone',
] as const

const expectedRuntimeKeys = [
  'web-browser',
  'server',
  'cartographer-cli',
  'cartographer-mcp',
] as const

const repoRoot = NodeURL.fileURLToPath(new URL('..', import.meta.url))
const cliPath = NodePath.join(repoRoot, 'packages/cartographer-core/dist/cli/index.js')
const configPath = NodePath.join(repoRoot, '.cartographer.json')

function readJson<T>(filePath: string): T
{
  return JSON.parse(NodeFS.readFileSync(filePath, 'utf8')) as T
}

function sortedUnique(values: readonly string[]): string[]
{
  return [...new Set(values)].sort()
}

function runBuild(outputDir: string): void
{
  NodeAssert.ok(NodeFS.existsSync(cliPath), `missing built Cartographer CLI: ${cliPath}`)
  const result = NodeChildProcess.spawnSync(
    NodeProcess.execPath,
    [cliPath, 'build', '.', '--scope', '.', '--out', outputDir, '--no-history'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    },
  )
  if (result.error)
  {
    throw result.error
  }
  NodeAssert.equal(
    result.status,
    0,
    `dogfood atlas build failed${result.signal ? ` on ${result.signal}` : ''}:\n` +
      `${result.stderr}${result.stdout}`,
  )
}

function verifyConfig(config: DogfoodConfig): void
{
  NodeAssert.equal(config.groupDepth, 2, 'dogfood groupDepth must stay at 2')
  NodeAssert.deepEqual(
    sortedUnique(config.groups.map((group) => group.name)),
    sortedUnique(expectedGroups),
    'dogfood config must define the 12 logical groups',
  )
  NodeAssert.deepEqual(
    sortedUnique(config.systems.map((system) => system.name)),
    sortedUnique([...expectedSystemRanks.keys()]),
    'dogfood config must define the nine ranked systems',
  )
  for (const system of config.systems)
  {
    NodeAssert.equal(
      system.rank,
      expectedSystemRanks.get(system.name),
      `dogfood system ${system.name} has the wrong rank`,
    )
  }
  NodeAssert.deepEqual(
    config.rules.map((rule) => rule.id).sort(),
    [...expectedRuleIds].sort(),
    'dogfood config must define the six curated rules',
  )
  for (const rule of config.rules.filter((candidate) => candidate.verdict === 'allow-only'))
  {
    NodeAssert.ok(Array.isArray(rule.allowVia), `${rule.id} must use an allowVia array`)
  }
  NodeAssert.deepEqual(
    config.runtimes.map((runtime) => runtime.key).sort(),
    [...expectedRuntimeKeys].sort(),
    'dogfood config must define the four runtime lenses',
  )
  NodeAssert.equal(config.journeys.length, 1, 'dogfood config must define one journey')
  NodeAssert.equal(config.journeys[0]?.id, 'agent-turn', 'dogfood journey must be agent-turn')
  NodeAssert.equal(config.journeys[0]?.stops.length, 10, 'agent-turn must have ten stops')
}

function verifyGraph(config: DogfoodConfig, graph: DogfoodGraph): void
{
  NodeAssert.equal(graph.scope, '.', 'dogfood graph must cover the repository root')
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const staleHeaders = graph.nodes
    .filter(
      (node) => node.headerPathStale === true && node.id.startsWith('packages/cartographer-core/'),
    )
    .map((node) => node.id)
  NodeAssert.deepEqual(staleHeaders, [], 'Cartographer Core contains stale path headers')

  const zeroMatchWarnings = (graph.markers ?? [])
    .filter((marker) => marker.kind === 'warning' && marker.text.includes('matches no files'))
    .map((marker) => marker.text)
  NodeAssert.deepEqual(zeroMatchWarnings, [], 'dogfood config contains zero-match patterns')

  // heuristic prefix groups cover unmatched files (root configs, dev docs),
  // so the graph may carry extras -> assert every authored group is present
  const authoredGroups = new Set(config.groups.map((group) => group.name))
  const graphGroupIds = new Set(graph.groups.map((group) => group.label ?? group.id))
  for (const name of authoredGroups)
  {
    NodeAssert.ok(graphGroupIds.has(name), `authored group missing from graph: ${name}`)
  }
  for (const group of graph.groups)
  {
    NodeAssert.ok(group.fileCount > 0, `dogfood group ${group.id} contains no files`)
  }

  const systems = graph.systems ?? []
  // the graph appends a synthetic unranked bucket for unassigned files;
  // authored systems are the nine ranked entries
  const authoredSystems = systems.filter((candidate) => typeof candidate.rank === 'number')
  NodeAssert.equal(
    authoredSystems.length,
    expectedSystemRanks.size,
    'graph must contain nine authored systems',
  )
  for (const [name, rank] of expectedSystemRanks)
  {
    const system = systems.find((candidate) => candidate.id === name)
    NodeAssert.ok(system, `graph is missing system ${name}`)
    NodeAssert.ok(system.fileCount > 0, `dogfood system ${name} contains no files`)
    NodeAssert.equal(system.rank, rank, `graph system ${name} has the wrong rank`)
  }

  const graphRuleIds = new Set((graph.rules ?? []).map((rule) => rule.id))
  for (const ruleId of expectedRuleIds)
  {
    NodeAssert.ok(graphRuleIds.has(ruleId), `graph rules ledger is missing ${ruleId}`)
  }

  const journeys = graph.journeys ?? []
  NodeAssert.equal(journeys.length, 1, 'graph must contain one journey')
  const journey = journeys.find((candidate) => candidate.id === 'agent-turn')
  NodeAssert.ok(journey, 'graph is missing the agent-turn journey')
  NodeAssert.equal(journey.stops.length, 10, 'resolved agent-turn must have ten stops')
  for (const stop of journey.stops)
  {
    NodeAssert.notEqual(stop.stale, true, `agent-turn stop ${stop.at} is stale`)
    NodeAssert.ok((stop.resolvedTotal ?? 0) > 0, `agent-turn stop ${stop.at} resolved no files`)
    NodeAssert.ok((stop.resolved?.length ?? 0) > 0, `agent-turn stop ${stop.at} has no witnesses`)
    for (const resolved of stop.resolved ?? [])
    {
      NodeAssert.ok(
        nodeIds.has(resolved),
        `agent-turn stop ${stop.at} resolved absent node ${resolved}`,
      )
    }
  }

  const runtimes = graph.runtimes ?? []
  NodeAssert.equal(runtimes.length, expectedRuntimeKeys.length, 'graph must contain four runtimes')
  for (const runtime of config.runtimes)
  {
    const resolvedRuntime = runtimes.find((candidate) => candidate.key === runtime.key)
    NodeAssert.ok(resolvedRuntime, `graph is missing runtime ${runtime.key}`)
    NodeAssert.notEqual(resolvedRuntime.stale, true, `runtime ${runtime.key} is stale`)
    NodeAssert.ok(
      (resolvedRuntime.resolvedTotal ?? 0) > 0,
      `runtime ${runtime.key} resolved no entry points`,
    )
    for (const root of runtime.roots)
    {
      NodeAssert.ok(nodeIds.has(root), `runtime ${runtime.key} root is absent from graph: ${root}`)
    }
  }

  const excludedSegments = new Set([
    '.repos',
    '.cartographer',
    '.vite-plus',
    '.showcase',
    '.tanstack',
    '.alchemy',
    '.456code',
    'node_modules',
    'dist',
    'dist-electron',
    'build',
    'out',
    'coverage',
    'release',
    'release-mock',
    'artifacts',
    'vendor',
    'vendors',
  ])
  const excludedNodes = graph.nodes
    .map((node) => node.id)
    .filter((id) => id.split('/').some((segment) => excludedSegments.has(segment)))
  NodeAssert.deepEqual(excludedNodes, [], 'graph contains vendored or generated output nodes')
}

async function main(): Promise<void>
{
  const owner = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), '456code-dogfood-architecture-'),
  )
  try
  {
    const outputDir = NodePath.join(owner, 'atlas')
    const config = readJson<DogfoodConfig>(configPath)
    verifyConfig(config)
    runBuild(outputDir)
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(outputDir, 'graph.db')),
      false,
      'native dogfood build wrote snapshot history',
    )
    const graph = readJson<DogfoodGraph>(NodePath.join(outputDir, 'graph.json'))
    verifyGraph(config, graph)
    NodeProcess.stdout.write(
      `Dogfood architecture smoke passed (${graph.nodes.length} files, ${graph.groups.length} groups).\n`,
    )
  }
  finally
  {
    await NodeFSP.rm(owner, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
  }
}

main().catch((error: unknown) =>
{
  NodeProcess.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  NodeProcess.exit(1)
})
