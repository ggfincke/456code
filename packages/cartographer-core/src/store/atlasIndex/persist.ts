// packages/cartographer-core/src/store/atlasIndex/persist.ts
// atlas index persistence, graph-content validation & caching

import * as NodeFS from 'node:fs'
import { parseAtlasIndex } from '../../contracts/atlasIndexCodec.js'
import { assertGraphVersion, ATLAS_INDEX_SCHEMA_VERSION } from '../../contracts/types.js'
import type {
  AtlasIndex,
  AtlasIndexSummary,
  CartographerGraph,
  SourceGraphDigest,
} from '../../contracts/types.js'
import { ensureOutDir, writeFileAtomic } from '../artifactFs.js'
import { atlasIndexPath, graphJsonPath } from '../paths.js'
import { buildAtlasIndex } from './build.js'
import { ATLAS_INDEX_TOP_FILE_LIMIT } from './constants.js'
import { graphContentDigest } from './digest.js'

export function saveAtlasIndex(index: AtlasIndex, root: string, outDir?: string): string
{
  ensureOutDir(root, outDir)
  const path = atlasIndexPath(root, outDir)
  writeFileAtomic(path, `${JSON.stringify(index)}\n`)
  return path
}

export function atlasIndexSummary(index: AtlasIndex): AtlasIndexSummary
{
  const { files, ...summary } = index
  return {
    ...summary,
    topFiles: files.slice(0, ATLAS_INDEX_TOP_FILE_LIMIT),
  } as AtlasIndexSummary
}

function assertAtlasIndexVersion(value: unknown, path: string): void
{
  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'number' &&
    value.version !== ATLAS_INDEX_SCHEMA_VERSION
  )
  {
    throw new Error(
      `${path} uses unsupported atlas index schema version ${value.version}; ` +
        `expected version ${ATLAS_INDEX_SCHEMA_VERSION}`,
    )
  }
}

// parsed/validated index cached per root/outDir & artifact generation ->
// summary/query requests stop reparsing/revalidating the whole file (F22)
interface CachedIndex
{
  indexStamp: string
  graphStamp: string
  sourceGraphDigest: SourceGraphDigest
  index: AtlasIndex
}

const INDEX_CACHE_MAX_ENTRIES = 8
const INDEX_STABILITY_ATTEMPTS = 8
const indexCache = new Map<string, CachedIndex>()

export interface EnsureAtlasIndexOptions
{
  readonly immutableArtifacts?: boolean
}

export class AtlasIndexUnavailableError extends Error
{
  readonly _tag = 'AtlasIndexUnavailableError'
  readonly path: string

  constructor(path: string)
  {
    super(`prepared atlas index is missing, stale, or corrupt at ${path}`)
    this.name = 'AtlasIndexUnavailableError'
    this.path = path
  }
}

interface ArtifactStamps
{
  index: string | undefined
  graph: string | undefined
}

// atomic rename gives every publication a fresh (ino, mtime, size) identity
function fileStamp(path: string): string | undefined
{
  try
  {
    const stat = NodeFS.statSync(path, { bigint: true })
    return `${stat.ino}-${stat.mtimeNs}-${stat.size}`
  }
  catch
  {
    return undefined
  }
}

function artifactStamps(path: string, graphPath: string): ArtifactStamps
{
  return {
    index: fileStamp(path),
    graph: fileStamp(graphPath),
  }
}

function sameStamps(a: ArtifactStamps, b: ArtifactStamps): boolean
{
  return a.index === b.index && a.graph === b.graph
}

function cacheIndex(
  cacheKey: string,
  index: AtlasIndex,
  stamps: ArtifactStamps,
  sourceGraphDigest: SourceGraphDigest,
): AtlasIndex
{
  if (!stamps.index || !stamps.graph || index.sourceGraphDigest !== sourceGraphDigest)
  {
    return index
  }
  indexCache.set(cacheKey, {
    indexStamp: stamps.index,
    graphStamp: stamps.graph,
    sourceGraphDigest,
    index,
  })
  while (indexCache.size > INDEX_CACHE_MAX_ENTRIES)
  {
    const oldest = indexCache.keys().next().value
    if (oldest === undefined)
    {
      break
    }
    indexCache.delete(oldest)
  }
  return index
}

interface GraphArtifact
{
  readonly graph: CartographerGraph
  readonly sourceGraphDigest: SourceGraphDigest
}

function readGraphArtifact(path: string): GraphArtifact
{
  const bytes = NodeFS.readFileSync(path)
  const graph = JSON.parse(bytes.toString('utf-8')) as CartographerGraph
  assertGraphVersion(graph.version, path)
  return {
    graph,
    sourceGraphDigest: graphContentDigest(bytes),
  }
}

export function ensureAtlasIndex(
  root: string,
  outDir?: string,
  options: EnsureAtlasIndexOptions = {},
): AtlasIndex
{
  const path = atlasIndexPath(root, outDir)
  const graphPath = graphJsonPath(root, outDir)
  if (!NodeFS.existsSync(graphPath))
  {
    throw new Error(`no graph at ${graphPath} -> run \`cartographer build\` first`)
  }
  const cacheKey = path
  for (let attempt = 0; attempt < INDEX_STABILITY_ATTEMPTS; attempt += 1)
  {
    const before = artifactStamps(path, graphPath)
    if (!before.graph)
    {
      if (!NodeFS.existsSync(graphPath))
      {
        throw new Error(`no graph at ${graphPath} -> run \`cartographer build\` first`)
      }
      continue
    }

    const cached = indexCache.get(cacheKey)
    if (
      cached &&
      before.index &&
      cached.indexStamp === before.index &&
      cached.graphStamp === before.graph &&
      cached.sourceGraphDigest === cached.index.sourceGraphDigest
    )
    {
      // LRU touch
      indexCache.delete(cacheKey)
      indexCache.set(cacheKey, cached)
      return cached.index
    }

    let graphArtifact: GraphArtifact
    try
    {
      graphArtifact = readGraphArtifact(graphPath)
    }
    catch (error)
    {
      if (fileStamp(graphPath) !== before.graph)
      {
        continue
      }
      throw error
    }
    const graphAfterRead = fileStamp(graphPath)
    if (!graphAfterRead || graphAfterRead !== before.graph)
    {
      continue
    }

    let stored: AtlasIndex | undefined
    if (before.index)
    {
      try
      {
        const value: unknown = JSON.parse(NodeFS.readFileSync(path, 'utf-8'))
        assertAtlasIndexVersion(value, path)
        const decoded = parseAtlasIndex(value)
        if (
          decoded.sourceGeneratedAt === graphArtifact.graph.generatedAt &&
          decoded.sourceGraphDigest === graphArtifact.sourceGraphDigest
        )
        {
          stored = decoded
        }
      }
      catch
      {
        // corrupt, partial, or version-stale index -> rebuild from graph.json
      }
      const after = artifactStamps(path, graphPath)
      if (!sameStamps(before, after))
      {
        continue
      }
      if (stored)
      {
        return cacheIndex(cacheKey, stored, after, graphArtifact.sourceGraphDigest)
      }
    }

    if (options.immutableArtifacts)
    {
      throw new AtlasIndexUnavailableError(path)
    }

    const index = buildAtlasIndex(graphArtifact.graph, graphArtifact.sourceGraphDigest, root)
    if (fileStamp(graphPath) !== graphAfterRead)
    {
      continue
    }
    saveAtlasIndex(index, root, outDir)
    const published = artifactStamps(path, graphPath)
    if (!published.index || published.graph !== graphAfterRead)
    {
      continue
    }
    // loop once more so cache value & index stamp come from the same read
  }
  throw new Error(`atlas artifacts at ${graphPath} changed repeatedly -> retry the request`)
}

// release parsed artifacts associated with one artifact output directory
export function disposeAtlasIndexCache(root: string, outDir?: string): void
{
  indexCache.delete(atlasIndexPath(root, outDir))
}
