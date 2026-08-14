// packages/cartographer-core/src/contracts/atlasIndexCodec.ts
// runtime codecs for atlas index dto families

import { ATLAS_INDEX_SCHEMA_VERSION } from './types.js'
import type {
  AtlasIndex,
  AtlasIndexCounts,
  AtlasIndexEdge,
  AtlasIndexEdgeCount,
  AtlasIndexFile,
  AtlasIndexLevel,
  AtlasIndexPage,
  AtlasIndexScopeSummary,
  AtlasIndexSummary,
  AtlasIndexUnit,
  SourceGraphDigest,
} from './types.js'

const INDEX_LEVELS: AtlasIndexLevel[] = ['systems', 'blocks', 'dirs']

type AtlasIndexBase = Omit<AtlasIndex, 'files'>

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number
{
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isFiniteNumber(value: unknown): value is number
{
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalString(value: unknown): value is string | undefined
{
  return value === undefined || typeof value === 'string'
}

export function isSourceGraphDigest(value: unknown): value is SourceGraphDigest
{
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function isRepo(value: unknown): value is AtlasIndex['repo']
{
  return (
    isRecord(value) &&
    typeof value.root === 'string' &&
    typeof value.name === 'string' &&
    typeof value.scope === 'string' &&
    value.mode === 'imports' &&
    isOptionalString(value.gitRef)
  )
}

function isCounts(value: unknown): value is AtlasIndexCounts
{
  return (
    isRecord(value) &&
    isCount(value.files) &&
    isCount(value.imports) &&
    isCount(value.systems) &&
    isCount(value.blocks) &&
    isCount(value.dirs) &&
    isCount(value.indexedSystems) &&
    isCount(value.indexedBlocks) &&
    isCount(value.indexedDirs)
  )
}

function isUnit(value: unknown, expectedLevel: AtlasIndexLevel): value is AtlasIndexUnit
{
  if (!isRecord(value) || !isRecord(value.position))
  {
    return false
  }
  return (
    typeof value.id === 'string' &&
    typeof value.key === 'string' &&
    value.id === `${expectedLevel}:${value.key}` &&
    value.level === expectedLevel &&
    typeof value.label === 'string' &&
    isOptionalString(value.description) &&
    isOptionalString(value.parent) &&
    (value.source === undefined ||
      value.source === 'authored' ||
      value.source === 'fallback' ||
      value.source === 'inferred') &&
    isCount(value.fileCount) &&
    isCount(value.inbound) &&
    isCount(value.outbound) &&
    isCount(value.visibilityRank) &&
    isCount(value.order) &&
    isFiniteNumber(value.position.x) &&
    isFiniteNumber(value.position.y)
  )
}

function isEdge(value: unknown): value is AtlasIndexEdge
{
  return (
    isRecord(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    isCount(value.weight)
  )
}

function isEdgeCount(value: unknown, indexed: number): value is AtlasIndexEdgeCount
{
  return (
    isExactCount(value) &&
    value.indexed === indexed &&
    value.total === value.indexed + value.omitted
  )
}

function isExactCount(value: unknown): value is AtlasIndexEdgeCount
{
  return (
    isRecord(value) &&
    isCount(value.total) &&
    isCount(value.indexed) &&
    isCount(value.omitted) &&
    value.total === value.indexed + value.omitted
  )
}

function isScope(value: unknown): value is AtlasIndexScopeSummary
{
  return (
    isRecord(value) &&
    typeof value.parent === 'string' &&
    (value.childLevel === 'blocks' || value.childLevel === 'dirs') &&
    isExactCount(value.children) &&
    isExactCount(value.edges)
  )
}

function isHealth(value: unknown): value is AtlasIndex['health']
{
  return (
    isRecord(value) &&
    isCount(value.cycles) &&
    isCount(value.orphans) &&
    isCount(value.violatingImports) &&
    isCount(value.violatedRules) &&
    isCount(value.ruleTotal) &&
    value.violatedRules <= value.ruleTotal
  )
}

function isFile(value: unknown): value is AtlasIndexFile
{
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    isOptionalString(value.description) &&
    isOptionalString(value.system) &&
    isOptionalString(value.block) &&
    isOptionalString(value.dir) &&
    isCount(value.fanIn) &&
    isCount(value.fanOut) &&
    isCount(value.visibilityRank)
  )
}

function isFileArray(value: unknown): value is AtlasIndexFile[]
{
  return Array.isArray(value) && value.every(isFile)
}

function isBaseIndex(value: unknown): value is AtlasIndexBase
{
  if (
    !isRecord(value) ||
    value.version !== ATLAS_INDEX_SCHEMA_VERSION ||
    typeof value.sourceGeneratedAt !== 'string' ||
    !isSourceGraphDigest(value.sourceGraphDigest) ||
    !isRepo(value.repo) ||
    !isCounts(value.counts) ||
    (value.systemSource !== 'authored' && value.systemSource !== 'inferred') ||
    !isRecord(value.units) ||
    !isRecord(value.edges) ||
    !isRecord(value.edgeCounts) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every(isScope) ||
    !isHealth(value.health)
  )
  {
    return false
  }
  for (const level of INDEX_LEVELS)
  {
    const units = value.units[level]
    const edges = value.edges[level]
    if (
      !Array.isArray(units) ||
      !units.every((unit) => isUnit(unit, level)) ||
      !Array.isArray(edges) ||
      !edges.every(isEdge) ||
      !isEdgeCount(value.edgeCounts[level], edges.length)
    )
    {
      return false
    }
  }
  return true
}

function hasUniqueValues(values: string[]): boolean
{
  return new Set(values).size === values.length
}

function hasUniqueEdges(edges: AtlasIndexEdge[]): boolean
{
  const pairs = edges.map((edge) => JSON.stringify([edge.from, edge.to]))
  return hasUniqueValues(pairs)
}

function hasValidHierarchy(index: AtlasIndexBase): boolean
{
  const ids = {
    systems: new Set(index.units.systems.map((unit) => unit.id)),
    blocks: new Set(index.units.blocks.map((unit) => unit.id)),
    dirs: new Set(index.units.dirs.map((unit) => unit.id)),
  }
  const allIds = INDEX_LEVELS.flatMap((level) => index.units[level].map((unit) => unit.id))
  const scopeParents = index.scopes.map((scope) => scope.parent)
  if (
    !hasUniqueValues(allIds) ||
    !hasUniqueValues(scopeParents) ||
    INDEX_LEVELS.some(
      (level) =>
        !hasUniqueValues(index.units[level].map((unit) => unit.key)) ||
        !hasUniqueEdges(index.edges[level]),
    )
  )
  {
    return false
  }
  return (
    index.counts.indexedSystems === index.units.systems.length &&
    index.counts.indexedBlocks === index.units.blocks.length &&
    index.counts.indexedDirs === index.units.dirs.length &&
    index.counts.systems >= index.counts.indexedSystems &&
    index.counts.blocks >= index.counts.indexedBlocks &&
    index.counts.dirs >= index.counts.indexedDirs &&
    index.units.systems.every((unit) => unit.parent === undefined) &&
    index.units.blocks.every((unit) => unit.parent !== undefined && ids.systems.has(unit.parent)) &&
    index.units.dirs.every((unit) => unit.parent !== undefined && ids.blocks.has(unit.parent)) &&
    INDEX_LEVELS.every((level) =>
      index.edges[level].every((edge) => ids[level].has(edge.from) && ids[level].has(edge.to)),
    ) &&
    index.scopes.every((scope) =>
    {
      const parentLevel = scope.childLevel === 'blocks' ? 'systems' : 'blocks'
      const childIds = new Set(
        index.units[scope.childLevel]
          .filter((unit) => unit.parent === scope.parent)
          .map((unit) => unit.id),
      )
      const indexedEdges = index.edges[scope.childLevel].filter(
        (edge) => childIds.has(edge.from) && childIds.has(edge.to),
      ).length
      return (
        ids[parentLevel].has(scope.parent) &&
        scope.children.indexed === childIds.size &&
        scope.edges.indexed === indexedEdges
      )
    })
  )
}

function hasValidFiles(
  files: AtlasIndexFile[],
  index: AtlasIndexBase,
  requireExactCount: boolean,
): boolean
{
  const ids = {
    systems: new Set(index.units.systems.map((unit) => unit.id)),
    blocks: new Set(index.units.blocks.map((unit) => unit.id)),
    dirs: new Set(index.units.dirs.map((unit) => unit.id)),
  }
  return (
    hasUniqueValues(files.map((file) => file.id)) &&
    (requireExactCount
      ? files.length === index.counts.files
      : files.length <= index.counts.files) &&
    files.every(
      (file) =>
        (file.system === undefined || ids.systems.has(file.system)) &&
        (file.block === undefined || ids.blocks.has(file.block)) &&
        (file.dir === undefined || ids.dirs.has(file.dir)),
    )
  )
}

export function parseAtlasIndex(value: unknown): AtlasIndex
{
  const files = isRecord(value) ? value.files : undefined
  if (
    !isBaseIndex(value) ||
    !hasValidHierarchy(value) ||
    !isFileArray(files) ||
    !hasValidFiles(files, value, true)
  )
  {
    throw new Error('atlas index has an invalid schema')
  }
  return value as AtlasIndex
}

export function parseAtlasIndexSummary(value: unknown): AtlasIndexSummary
{
  const topFiles = isRecord(value) ? value.topFiles : undefined
  if (
    !isBaseIndex(value) ||
    !hasValidHierarchy(value) ||
    !isFileArray(topFiles) ||
    !hasValidFiles(topFiles, value, false)
  )
  {
    throw new Error('atlas index summary has an invalid schema')
  }
  return value as AtlasIndexSummary
}

export function parseAtlasIndexFilePage(value: unknown): AtlasIndexPage<AtlasIndexFile>
{
  const items = isRecord(value) ? value.items : undefined
  if (
    !isRecord(value) ||
    !isFileArray(items) ||
    !isCount(value.total) ||
    items.length > value.total ||
    !hasUniqueValues(items.map((item) => item.id)) ||
    (value.nextCursor !== undefined &&
      (typeof value.nextCursor !== 'string' || value.nextCursor.length === 0))
  )
  {
    throw new Error('atlas index file page has an invalid schema')
  }
  return value as unknown as AtlasIndexPage<AtlasIndexFile>
}
