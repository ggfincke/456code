// packages/cartographer-core/src/store/atlasIndex/query.ts
// atlas index cursor codec & bounded unit/file paging

import { decodeCursorEnvelope, encodeCursorEnvelope, hashSignature } from '../cursorCodec.js'
import type {
  AtlasIndex,
  AtlasIndexFile,
  AtlasIndexFileQuery,
  AtlasIndexLevel,
  AtlasIndexPage,
  AtlasIndexQuery,
  AtlasIndexStructureDirectory,
  AtlasIndexStructureEdge,
  AtlasIndexStructureFileQuery,
  AtlasIndexStructureQuery,
  AtlasIndexUnit,
  AtlasIndexV6,
} from '../../contracts/types.js'
import { ATLAS_INDEX_QUERY_LIMIT, ATLAS_INDEX_QUERY_LIMIT_MAX } from './constants.js'

interface CursorPayload
{
  version: 1
  signature: string
  offset: number
}

function queryLimit(limit: number | undefined): number
{
  const value = limit ?? ATLAS_INDEX_QUERY_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > ATLAS_INDEX_QUERY_LIMIT_MAX)
  {
    throw new Error(`limit must be an integer from 1 to ${ATLAS_INDEX_QUERY_LIMIT_MAX}`)
  }
  return value
}

function decodeCursor(cursor: string | undefined, signature: string): number
{
  if (!cursor)
  {
    return 0
  }
  const value = decodeCursorEnvelope<CursorPayload>(cursor)
  if (
    !value ||
    value.version !== 1 ||
    value.signature !== signature ||
    !Number.isSafeInteger(value.offset) ||
    value.offset! < 0
  )
  {
    throw new Error('cursor is invalid for this query')
  }
  return value.offset!
}

function encodeCursor(signature: string, offset: number): string
{
  const payload: CursorPayload = { version: 1, signature, offset }
  return encodeCursorEnvelope(payload)
}

function page<T>(
  items: T[],
  signature: string,
  cursor: string | undefined,
  limit: number | undefined,
): AtlasIndexPage<T>
{
  const size = queryLimit(limit)
  const offset = decodeCursor(cursor, signature)
  if (offset > items.length)
  {
    throw new Error('cursor offset exceeds the query result')
  }
  const visible = items.slice(offset, offset + size)
  const next = offset + visible.length
  return {
    items: visible,
    total: items.length,
    ...(next < items.length ? { nextCursor: encodeCursor(signature, next) } : {}),
  }
}

function resolveParent(
  index: AtlasIndex,
  level: AtlasIndexLevel,
  parent: string | undefined,
): string | undefined
{
  if (!parent)
  {
    return undefined
  }
  if (level === 'systems')
  {
    throw new Error('systems queries do not accept a parent')
  }
  const parentLevel: AtlasIndexLevel = level === 'blocks' ? 'systems' : 'blocks'
  const units = index.units[parentLevel]
  const idMatches = units.filter((unit) => unit.id === parent)
  const matches = idMatches.length > 0 ? idMatches : units.filter((unit) => unit.key === parent)
  if (matches.length !== 1)
  {
    throw new Error(matches.length > 1 ? 'parent is ambiguous' : 'parent was not found')
  }
  return matches[0]!.id
}

export function queryAtlasIndex(
  index: AtlasIndex,
  query: AtlasIndexQuery,
): AtlasIndexPage<AtlasIndexUnit>
{
  const parent = resolveParent(index, query.level, query.parent)
  const items = index.units[query.level].filter(
    (unit) => parent === undefined || unit.parent === parent,
  )
  const signature = hashSignature([
    index.repo.root,
    index.sourceGeneratedAt,
    index.sourceGraphDigest,
    'units',
    query.level,
    parent ?? '',
  ])
  return page(items, signature, query.cursor, query.limit)
}

function validateFileParent(
  index: AtlasIndex,
  parent: AtlasIndexFileQuery['parent'],
): NonNullable<AtlasIndexFileQuery['parent']> | undefined
{
  if (!parent)
  {
    return undefined
  }
  const match = index.units[parent.level].find((unit) => unit.id === parent.id)
  if (!match)
  {
    throw new Error('file parent was not found')
  }
  return parent
}

export function queryAtlasFiles(
  index: AtlasIndex,
  query: AtlasIndexFileQuery,
): AtlasIndexPage<AtlasIndexFile>
{
  const parent = validateFileParent(index, query.parent)
  const search = query.search?.trim().toLowerCase()
  if (search && search.length > 200)
  {
    throw new Error('search must not exceed 200 characters')
  }
  const signature = hashSignature([
    index.repo.root,
    index.sourceGeneratedAt,
    index.sourceGraphDigest,
    'files',
    parent?.level ?? '',
    parent?.id ?? '',
    search ?? '',
  ])
  const size = queryLimit(query.limit)
  const offset = decodeCursor(query.cursor, signature)
  const items: AtlasIndexFile[] = []
  let total = 0
  for (const record of index.files)
  {
    const belongs =
      !parent ||
      (parent.level === 'systems' && record.system === parent.id) ||
      (parent.level === 'blocks' && record.block === parent.id) ||
      (parent.level === 'dirs' && record.dir === parent.id)
    if (!belongs)
    {
      continue
    }
    const matches =
      !search ||
      record.id.toLowerCase().includes(search) ||
      record.label.toLowerCase().includes(search) ||
      (record.description ?? '').toLowerCase().includes(search)
    if (matches)
    {
      if (total >= offset && items.length < size)
      {
        items.push(record)
      }
      total += 1
    }
  }
  if (offset > total)
  {
    throw new Error('cursor offset exceeds the query result')
  }
  const next = offset + items.length
  return {
    items,
    total,
    ...(next < total ? { nextCursor: encodeCursor(signature, next) } : {}),
  }
}

function structureParent(index: AtlasIndexV6, parentId: string): AtlasIndexStructureDirectory
{
  const parent = index.structure.directories.find((directory) => directory.id === parentId)
  if (parent === undefined) throw new Error('structure parent was not found')
  return parent
}

export function queryAtlasStructureDirectories(
  index: AtlasIndexV6,
  query: AtlasIndexStructureQuery,
): AtlasIndexPage<AtlasIndexStructureDirectory>
{
  const parent = structureParent(index, query.parentId)
  const children = new Set(parent.childDirectoryIds)
  const items = index.structure.directories.filter((directory) => children.has(directory.id))
  const signature = hashSignature([
    index.repo.root,
    index.sourceGeneratedAt,
    index.sourceGraphDigest,
    'structure-directories',
    parent.id,
  ])
  return page(items, signature, query.cursor, query.limit)
}

export function queryAtlasStructureFiles(
  index: AtlasIndexV6,
  query: AtlasIndexStructureFileQuery,
): AtlasIndexPage<AtlasIndexFile>
{
  const parent = structureParent(index, query.parentId)
  const search = query.search?.trim().toLowerCase()
  if (search && search.length > 200)
  {
    throw new Error('search must not exceed 200 characters')
  }
  const directIds = new Set(parent.directFileIds)
  const items = index.files.filter(
    (file) =>
      directIds.has(file.id) &&
      (!search ||
        file.id.toLowerCase().includes(search) ||
        file.label.toLowerCase().includes(search) ||
        (file.description ?? '').toLowerCase().includes(search)),
  )
  const signature = hashSignature([
    index.repo.root,
    index.sourceGeneratedAt,
    index.sourceGraphDigest,
    'structure-files',
    parent.id,
    search ?? '',
  ])
  return page(items, signature, query.cursor, query.limit)
}

export function queryAtlasStructureEdges(
  index: AtlasIndexV6,
  query: AtlasIndexStructureQuery,
): AtlasIndexPage<AtlasIndexStructureEdge>
{
  const parent = structureParent(index, query.parentId)
  const items = index.structure.edges.filter((edge) => edge.parent === parent.id)
  const signature = hashSignature([
    index.repo.root,
    index.sourceGeneratedAt,
    index.sourceGraphDigest,
    'structure-edges',
    parent.id,
  ])
  return page(items, signature, query.cursor, query.limit)
}
