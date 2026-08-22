// packages/cartographer-core/src/cli/commands/analyzeTrees.ts
// analyze two immutable trees into deterministic external artifacts

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { buildGraph, buildVerifiedImpactProjection, diffGraphs } from '../../analyze/index.js'
import { writeFileAtomic } from '../../store/artifactFs.js'
import { graphContentDigest } from '../../store/atlasIndex.js'
import { normalizeGraphJson } from '../../store/graphJson.js'
import type { CartographerGraph } from '../../contracts/types.js'
import type { CliValues } from '../lib/args.js'

const BASE_GRAPH_FILE = 'base.graph.json'
const PROPOSED_GRAPH_FILE = 'proposed.graph.json'
const IMPACT_FILE = 'impact.json'
const IMPACT_PROJECTION_FILE = 'impact-projection.json'
const STAGING_PREFIX = '.cartographer-analyze-trees-'
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ANALYZER_VERSION =
  /^(?:sha256:[0-9a-f]{64}|@t3tools\/cartographer-core@[^\s:]+:dist-sha256:[0-9a-f]{64})$/

export interface AnalysisReadyManifest
{
  type: 'cartographer.analysis-ready'
  version: 2
  analyzerVersion: string
  baseGraph: typeof BASE_GRAPH_FILE
  proposedGraph: typeof PROPOSED_GRAPH_FILE
  impact: typeof IMPACT_FILE
  impactProjection: typeof IMPACT_PROJECTION_FILE
}

interface AnalyzeTreesOptions
{
  maxOutputBytes?: number
}

function canonicalDirectory(value: string, label: string): string
{
  const path = NodePath.resolve(value)
  let stat
  try
  {
    stat = NodeFS.lstatSync(path)
  }
  catch
  {
    throw new Error(`${label} is not an existing directory: ${path}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
  {
    throw new Error(`${label} must be a real directory, not a file or symlink`)
  }
  return NodeFS.realpathSync(path)
}

function isWithin(parent: string, candidate: string): boolean
{
  const path = NodePath.relative(parent, candidate)
  return (
    path === '' ||
    (!NodePath.isAbsolute(path) && path !== '..' && !path.startsWith(`..${NodePath.sep}`))
  )
}

function validateRoots(baseRoot: string, proposedRoot: string): void
{
  if (isWithin(baseRoot, proposedRoot) || isWithin(proposedRoot, baseRoot))
  {
    throw new Error('base and proposed roots must be separate directories')
  }
}

function stageStaticTree(sourceRoot: string, stagedRoot: string, label: string): void
{
  NodeFS.mkdirSync(stagedRoot)
  const pending = [{ source: sourceRoot, staged: stagedRoot }]
  while (pending.length > 0)
  {
    const directory = pending.pop()!
    const entries = NodeFS.readdirSync(directory.source, {
      withFileTypes: true,
    }).sort((left, right) =>
    {
      if (left.name === right.name)
      {
        return 0
      }
      return left.name < right.name ? -1 : 1
    })
    for (const entry of entries)
    {
      const sourcePath = NodePath.join(directory.source, entry.name)
      const stagedPath = NodePath.join(directory.staged, entry.name)
      const stat = NodeFS.lstatSync(sourcePath)
      if (stat.isSymbolicLink())
      {
        continue
      }
      if (stat.isDirectory())
      {
        NodeFS.mkdirSync(stagedPath)
        pending.push({ source: sourcePath, staged: stagedPath })
      }
      else if (stat.isFile())
      {
        NodeFS.copyFileSync(sourcePath, stagedPath)
      }
      else
      {
        throw new Error(
          `${label} contains an unsupported filesystem entry: ${NodePath.relative(sourceRoot, sourcePath)}`,
        )
      }
    }
  }
}

function validateOutput(outputRoot: string, baseRoot: string, proposedRoot: string): void
{
  if (isWithin(baseRoot, outputRoot) || isWithin(proposedRoot, outputRoot))
  {
    throw new Error('analysis output must be outside both analyzed roots')
  }
}

function requiredValue(
  value: string | undefined,
  flag: string,
  pattern: RegExp,
  expected: string,
): string
{
  if (!value || !pattern.test(value))
  {
    throw new Error(`invalid ${flag} -> expected ${expected}`)
  }
  return value
}

function requiredNonNegativeInt(value: string | undefined, flag: string): number
{
  if (!value || !/^(?:0|[1-9]\d*)$/u.test(value))
  {
    throw new Error(`invalid ${flag} -> expected a non-negative integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
  {
    throw new Error(`invalid ${flag} -> value is outside the safe integer range`)
  }
  return parsed
}

function serializeJson(value: unknown): string
{
  return `${JSON.stringify(value, null, 2)}\n`
}

async function analyzeTree(root: string, gitRef: string): Promise<CartographerGraph>
{
  return normalizeGraphJson(
    await buildGraph({
      root,
      scope: '.',
      staticTree: { gitRef },
    }),
  )
}

export async function runAnalyzeTrees(
  baseRootArg: string,
  proposedRootArg: string,
  values: CliValues,
  options: AnalyzeTreesOptions = {},
): Promise<AnalysisReadyManifest>
{
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_OUTPUT_BYTES
  )
  {
    throw new Error(
      `analysis output limit must be an integer from 1 through ${MAX_OUTPUT_BYTES} bytes`,
    )
  }
  const baseRoot = canonicalDirectory(baseRootArg, 'base root')
  const proposedRoot = canonicalDirectory(proposedRootArg, 'proposed root')
  validateRoots(baseRoot, proposedRoot)
  if (!values.out)
  {
    throw new Error('analyze-trees requires --out <external-dir>')
  }
  const outputRoot = canonicalDirectory(values.out, 'analysis output')
  validateOutput(outputRoot, baseRoot, proposedRoot)
  const baseRef = requiredValue(
    values['base-ref'],
    '--base-ref',
    GIT_OBJECT_ID,
    'a full lowercase Git object ID',
  )
  const proposedRef = requiredValue(
    values['proposed-ref'],
    '--proposed-ref',
    GIT_OBJECT_ID,
    'a full lowercase Git object ID',
  )
  const analyzerVersion = requiredValue(
    values['analyzer-version'],
    '--analyzer-version',
    ANALYZER_VERSION,
    'a supported Cartographer analyzer fingerprint',
  )
  const implementationChangedFileCount = requiredNonNegativeInt(
    values['implementation-changed-file-count'],
    '--implementation-changed-file-count',
  )

  const stagedRoot = NodeFS.mkdtempSync(NodePath.join(outputRoot, STAGING_PREFIX))
  let baseGraph: CartographerGraph
  let proposedGraph: CartographerGraph
  try
  {
    const stagedBaseRoot = NodePath.join(stagedRoot, 'base')
    const stagedProposedRoot = NodePath.join(stagedRoot, 'proposed')
    stageStaticTree(baseRoot, stagedBaseRoot, 'base root')
    stageStaticTree(proposedRoot, stagedProposedRoot, 'proposed root')
    baseGraph = await analyzeTree(stagedBaseRoot, baseRef)
    proposedGraph = await analyzeTree(stagedProposedRoot, proposedRef)
  }
  finally
  {
    NodeFS.rmSync(stagedRoot, { recursive: true, force: true })
  }
  const baseGraphContent = serializeJson(baseGraph)
  const proposedGraphContent = serializeJson(proposedGraph)
  const baseGraphDigest = graphContentDigest(baseGraphContent)
  const proposedGraphDigest = graphContentDigest(proposedGraphContent)
  const impact = diffGraphs(baseGraph, proposedGraph)
  const impactContent = serializeJson(impact)
  const impactProjection = buildVerifiedImpactProjection({
    base: baseGraph,
    head: proposedGraph,
    diff: impact,
    baseGraphDigest,
    headGraphDigest: proposedGraphDigest,
    rawImpactDigest: graphContentDigest(impactContent),
    analyzerFingerprint: analyzerVersion,
    implementationChangedFileCount,
  })
  const artifacts = [
    {
      path: NodePath.join(outputRoot, BASE_GRAPH_FILE),
      content: baseGraphContent,
    },
    {
      path: NodePath.join(outputRoot, PROPOSED_GRAPH_FILE),
      content: proposedGraphContent,
    },
    {
      path: NodePath.join(outputRoot, IMPACT_FILE),
      content: impactContent,
    },
    {
      path: NodePath.join(outputRoot, IMPACT_PROJECTION_FILE),
      content: serializeJson(impactProjection),
    },
  ]
  const outputBytes = artifacts.reduce(
    (total, artifact) => total + Buffer.byteLength(artifact.content, 'utf-8'),
    0,
  )
  if (outputBytes > maxOutputBytes)
  {
    throw new Error(`analysis artifacts exceed the ${maxOutputBytes}-byte output limit`)
  }
  for (const artifact of artifacts)
  {
    writeFileAtomic(artifact.path, artifact.content)
  }

  const manifest: AnalysisReadyManifest = {
    type: 'cartographer.analysis-ready',
    version: 2,
    analyzerVersion,
    baseGraph: BASE_GRAPH_FILE,
    proposedGraph: PROPOSED_GRAPH_FILE,
    impact: IMPACT_FILE,
    impactProjection: IMPACT_PROJECTION_FILE,
  }
  process.stdout.write(`${JSON.stringify(manifest)}\n`)
  return manifest
}
