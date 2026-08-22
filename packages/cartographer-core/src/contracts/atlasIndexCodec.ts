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
  AtlasIndexStructureDirectory,
  AtlasIndexUnit,
  AtlasIndexV6,
  SourceGraphDigest,
} from './types.js'

const INDEX_LEVELS: AtlasIndexLevel[] = ['systems', 'blocks', 'dirs']

type AtlasIndexBase = Omit<AtlasIndexV6, 'files'>

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

function compareText(left: string, right: string): number
{
  return left < right ? -1 : left > right ? 1 : 0
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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean
{
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function isSortedUnique(values: readonly string[]): boolean
{
  return (
    hasUniqueValues([...values]) &&
    values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) < 0)
  )
}

function isRepositoryPath(value: unknown, allowRoot: boolean): value is string
{
  if (typeof value !== 'string') return false
  if (allowRoot && value === '.') return true
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

function immediateDirectoryParent(key: string): string | undefined
{
  if (key === '.') return undefined
  const slash = key.lastIndexOf('/')
  return `dirs:${slash < 0 ? '.' : key.slice(0, slash)}`
}

function directoryPrefixes(key: string): string[]
{
  if (key === '.') return ['dirs:.']
  const result = ['dirs:.']
  let prefix = ''
  for (const segment of key.split('/'))
  {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`
    result.push(`dirs:${prefix}`)
  }
  return result
}

function isStructureDirectory(value: unknown): value is AtlasIndexStructureDirectory
{
  if (!isRecord(value) || !isRecord(value.position)) return false
  return (
    hasOnlyKeys(value, [
      'id',
      'key',
      'label',
      'parentId',
      'depth',
      'childDirectoryIds',
      'directFileIds',
      'directFileCount',
      'descendantFileCount',
      'inbound',
      'outbound',
      'order',
      'position',
    ]) &&
    isRepositoryPath(value.key, true) &&
    value.id === `dirs:${value.key}` &&
    typeof value.label === 'string' &&
    isOptionalString(value.parentId) &&
    isCount(value.depth) &&
    Array.isArray(value.childDirectoryIds) &&
    value.childDirectoryIds.every((id) => typeof id === 'string') &&
    Array.isArray(value.directFileIds) &&
    value.directFileIds.every((id) => isRepositoryPath(id, false)) &&
    isCount(value.directFileCount) &&
    isCount(value.descendantFileCount) &&
    isCount(value.inbound) &&
    isCount(value.outbound) &&
    isCount(value.order) &&
    isFiniteNumber(value.position.x) &&
    isFiniteNumber(value.position.y)
  )
}

function isDominantCrosswalk(value: unknown): boolean
{
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['sourceId', 'targetIds', 'matchedFileCount', 'status']) &&
    typeof value.sourceId === 'string' &&
    Array.isArray(value.targetIds) &&
    value.targetIds.every((id) => typeof id === 'string') &&
    isCount(value.matchedFileCount) &&
    (value.status === 'matched' || value.status === 'ambiguous' || value.status === 'unmatched')
  )
}

function isV6Shape(value: AtlasIndexBase): value is Omit<AtlasIndexV6, 'files'>
{
  if (
    value.version !== ATLAS_INDEX_SCHEMA_VERSION ||
    !('structure' in value) ||
    !('crosswalks' in value)
  )
  {
    return false
  }
  const structure: unknown = value.structure
  const crosswalks: unknown = value.crosswalks
  if (
    !isRecord(structure) ||
    !hasOnlyKeys(structure, ['rootId', 'directories', 'edges', 'fileEdges', 'counts']) ||
    structure.rootId !== 'dirs:.' ||
    !Array.isArray(structure.directories) ||
    !structure.directories.every(isStructureDirectory) ||
    !Array.isArray(structure.edges) ||
    !structure.edges.every(
      (edge) =>
        isRecord(edge) &&
        hasOnlyKeys(edge, ['parent', 'from', 'to', 'weight']) &&
        typeof edge.parent === 'string' &&
        typeof edge.from === 'string' &&
        typeof edge.to === 'string' &&
        isCount(edge.weight) &&
        edge.weight > 0,
    ) ||
    !Array.isArray(structure.fileEdges) ||
    !structure.fileEdges.every(
      (edge) =>
        isRecord(edge) &&
        hasOnlyKeys(edge, ['from', 'to', 'weight']) &&
        isRepositoryPath(edge.from, false) &&
        isRepositoryPath(edge.to, false) &&
        isCount(edge.weight) &&
        edge.weight > 0,
    ) ||
    !isRecord(structure.counts) ||
    !hasOnlyKeys(structure.counts, ['directories', 'files', 'edges', 'fileEdges']) ||
    !isCount(structure.counts.directories) ||
    !isCount(structure.counts.files) ||
    !isCount(structure.counts.edges) ||
    !isCount(structure.counts.fileEdges) ||
    !isRecord(crosswalks) ||
    !hasOnlyKeys(crosswalks, [
      'files',
      'systemsToDirectories',
      'blocksToDirectories',
      'directoriesToSystems',
      'directoriesToBlocks',
    ]) ||
    !Array.isArray(crosswalks.files) ||
    !crosswalks.files.every(
      (file) =>
        isRecord(file) &&
        hasOnlyKeys(file, ['fileId', 'systemId', 'blockId', 'directoryId', 'position']) &&
        isRepositoryPath(file.fileId, false) &&
        typeof file.systemId === 'string' &&
        file.systemId.startsWith('systems:') &&
        typeof file.blockId === 'string' &&
        file.blockId.startsWith('blocks:') &&
        typeof file.directoryId === 'string' &&
        isRecord(file.position) &&
        isFiniteNumber(file.position.x) &&
        isFiniteNumber(file.position.y),
    )
  )
  {
    return false
  }
  return [
    crosswalks.systemsToDirectories,
    crosswalks.blocksToDirectories,
    crosswalks.directoriesToSystems,
    crosswalks.directoriesToBlocks,
  ].every((records) => Array.isArray(records) && records.every(isDominantCrosswalk))
}

function expectedDominantCrosswalks(
  pairs: ReadonlyArray<readonly [string, string]>,
  sourceIds: Iterable<string>,
): AtlasIndexV6['crosswalks']['systemsToDirectories']
{
  const counts = new Map<string, Map<string, number>>()
  for (const [source, target] of pairs)
  {
    const row = counts.get(source) ?? new Map<string, number>()
    row.set(target, (row.get(target) ?? 0) + 1)
    counts.set(source, row)
  }
  return [...new Set(sourceIds)].sort(compareText).map((sourceId) =>
  {
    const row = counts.get(sourceId) ?? new Map<string, number>()
    const matchedFileCount = Math.max(0, ...row.values())
    const targetIds = [...row]
      .filter(([, count]) => count === matchedFileCount && count > 0)
      .map(([id]) => id)
      .sort(compareText)
    return {
      sourceId,
      targetIds,
      matchedFileCount,
      status:
        targetIds.length === 0
          ? ('unmatched' as const)
          : targetIds.length === 1
            ? ('matched' as const)
            : ('ambiguous' as const),
    }
  })
}

function sameJson(left: unknown, right: unknown): boolean
{
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasValidCurrentIndex(
  index: Omit<AtlasIndexV6, 'files'>,
  presentedFiles: readonly AtlasIndexFile[],
  requireExactFiles: boolean,
): boolean
{
  const directories = index.structure.directories
  const directoryById = new Map(directories.map((directory) => [directory.id, directory]))
  const crosswalkFiles = index.crosswalks.files
  const presentedFileIds = new Set(presentedFiles.map((file) => file.id))
  const crosswalkFileIds = new Set(crosswalkFiles.map((file) => file.fileId))
  if (
    directories.length !== index.structure.counts.directories ||
    index.structure.counts.files !== index.counts.files ||
    index.structure.edges.length !== index.structure.counts.edges ||
    index.structure.fileEdges.length !== index.structure.counts.fileEdges ||
    crosswalkFiles.length !== index.counts.files ||
    directoryById.size !== directories.length ||
    crosswalkFileIds.size !== crosswalkFiles.length ||
    !directoryById.has('dirs:.') ||
    (requireExactFiles
      ? presentedFileIds.size !== crosswalkFileIds.size ||
        [...presentedFileIds].some((id) => !crosswalkFileIds.has(id))
      : [...presentedFileIds].some((id) => !crosswalkFileIds.has(id))) ||
    !isSortedUnique(crosswalkFiles.map((file) => file.fileId))
  )
  {
    return false
  }
  const sortedDirectories = [...directories].sort(
    (left, right) => left.depth - right.depth || compareText(left.key, right.key),
  )
  if (
    !sameJson(
      sortedDirectories.map((unit) => unit.id),
      directories.map((unit) => unit.id),
    )
  )
  {
    return false
  }
  const expectedChildren = new Map<string, string[]>()
  for (const directory of directories)
  {
    const expectedParent = immediateDirectoryParent(directory.key)
    if (
      directory.parentId !== expectedParent ||
      directory.depth !== (directory.key === '.' ? 0 : directory.key.split('/').length) ||
      (directory.parentId !== undefined && !directoryById.has(directory.parentId)) ||
      !isSortedUnique(directory.childDirectoryIds) ||
      !isSortedUnique(directory.directFileIds) ||
      directory.directFileCount !== directory.directFileIds.length ||
      directory.descendantFileCount < directory.directFileCount
    )
    {
      return false
    }
    if (directory.parentId !== undefined)
    {
      const children = expectedChildren.get(directory.parentId) ?? []
      children.push(directory.id)
      expectedChildren.set(directory.parentId, children)
    }
  }
  const directFiles = new Map<string, string[]>()
  const descendantCounts = new Map<string, number>()
  for (const file of crosswalkFiles)
  {
    if (!directoryById.has(file.directoryId)) return false
    const files = directFiles.get(file.directoryId) ?? []
    files.push(file.fileId)
    directFiles.set(file.directoryId, files)
    const key = file.directoryId.slice('dirs:'.length)
    for (const prefix of directoryPrefixes(key))
    {
      descendantCounts.set(prefix, (descendantCounts.get(prefix) ?? 0) + 1)
    }
  }
  for (const directory of directories)
  {
    const children = (expectedChildren.get(directory.id) ?? []).sort(compareText)
    const files = (directFiles.get(directory.id) ?? []).sort(compareText)
    if (
      !sameJson(directory.childDirectoryIds, children) ||
      !sameJson(directory.directFileIds, files) ||
      directory.descendantFileCount !== (descendantCounts.get(directory.id) ?? 0) ||
      directory.order !==
        (directory.parentId === undefined
          ? 0
          : childrenForParent(directories, directory.parentId).indexOf(directory.id))
    )
    {
      return false
    }
  }
  const inbound = new Map<string, number>()
  const outbound = new Map<string, number>()
  const edgeKeys = new Set<string>()
  for (const edge of index.structure.edges)
  {
    const parent = directoryById.get(edge.parent)
    if (parent === undefined) return false
    const children = new Set([...parent.childDirectoryIds, ...parent.directFileIds])
    const key = JSON.stringify([edge.parent, edge.from, edge.to])
    if (
      !children.has(edge.from) ||
      !children.has(edge.to) ||
      edge.from === edge.to ||
      edgeKeys.has(key)
    )
    {
      return false
    }
    edgeKeys.add(key)
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + edge.weight)
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + edge.weight)
  }
  if (
    directories.some(
      (directory) =>
        directory.inbound !== (inbound.get(directory.id) ?? 0) ||
        directory.outbound !== (outbound.get(directory.id) ?? 0),
    ) ||
    !sameJson(
      [...index.structure.edges].sort(
        (left, right) =>
          compareText(left.parent, right.parent) ||
          compareText(left.from, right.from) ||
          compareText(left.to, right.to),
      ),
      index.structure.edges,
    )
  )
  {
    return false
  }
  const fileEdgeKeys = new Set<string>()
  for (const edge of index.structure.fileEdges)
  {
    const key = JSON.stringify([edge.from, edge.to])
    if (
      !crosswalkFileIds.has(edge.from) ||
      !crosswalkFileIds.has(edge.to) ||
      edge.from === edge.to ||
      fileEdgeKeys.has(key)
    )
    {
      return false
    }
    fileEdgeKeys.add(key)
  }
  if (
    !sameJson(
      [...index.structure.fileEdges].sort(
        (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to),
      ),
      index.structure.fileEdges,
    )
  )
  {
    return false
  }
  const systems = crosswalkFiles.map((file): readonly [string, string] => [
    file.systemId,
    file.directoryId,
  ])
  const blocks = crosswalkFiles.map((file): readonly [string, string] => [
    file.blockId,
    file.directoryId,
  ])
  const directorySystems = crosswalkFiles.flatMap((file) =>
    directoryPrefixes(file.directoryId.slice('dirs:'.length)).map(
      (directory): readonly [string, string] => [directory, file.systemId],
    ),
  )
  const directoryBlocks = crosswalkFiles.flatMap((file) =>
    directoryPrefixes(file.directoryId.slice('dirs:'.length)).map(
      (directory): readonly [string, string] => [directory, file.blockId],
    ),
  )
  return (
    sameJson(
      index.crosswalks.systemsToDirectories,
      expectedDominantCrosswalks(
        systems,
        crosswalkFiles.map((file) => file.systemId),
      ),
    ) &&
    sameJson(
      index.crosswalks.blocksToDirectories,
      expectedDominantCrosswalks(
        blocks,
        crosswalkFiles.map((file) => file.blockId),
      ),
    ) &&
    sameJson(
      index.crosswalks.directoriesToSystems,
      expectedDominantCrosswalks(
        directorySystems,
        directories.map((directory) => directory.id),
      ),
    ) &&
    sameJson(
      index.crosswalks.directoriesToBlocks,
      expectedDominantCrosswalks(
        directoryBlocks,
        directories.map((directory) => directory.id),
      ),
    )
  )
}

function childrenForParent(
  directories: readonly AtlasIndexStructureDirectory[],
  parentId: string,
): string[]
{
  return directories
    .filter((directory) => directory.parentId === parentId)
    .map((directory) => directory.id)
    .sort(compareText)
}

export function parseAtlasIndex(value: unknown): AtlasIndex
{
  const files = isRecord(value) ? value.files : undefined
  if (
    !isBaseIndex(value) ||
    !hasValidHierarchy(value) ||
    !isFileArray(files) ||
    !hasValidFiles(files, value, true) ||
    !isV6Shape(value) ||
    !hasValidCurrentIndex(value, files, true)
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
    !hasValidFiles(topFiles, value, false) ||
    !isV6Shape(value) ||
    !hasValidCurrentIndex(value, topFiles, false)
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
