// apps/server/src/cartographer/architecturePathResolver.ts
// maps standing-atlas files and unit edges onto plan-card scope chips

import {
  ARCHITECTURE_BLAST_PATH_LIMIT,
  ARCHITECTURE_PROJECTION_FILE_LIMIT,
} from '@t3tools/contracts'
import {
  queryAtlasFiles,
  type AtlasIndex,
  type AtlasIndexFile,
  type AtlasIndexLevel,
  type AtlasIndexUnit,
} from '@t3tools/cartographer-core/server'

const ARCHITECTURE_PATH_SCOPE_UNIT_LIMIT = 200

interface ArchitecturePathScopeChip
{
  readonly role: 'touched' | 'context'
  readonly level: 'systems' | 'blocks'
  readonly id: string
  readonly key: string
  readonly label: string
}

type ChipLevel = ArchitecturePathScopeChip['level']

function catalogFiles(index: AtlasIndex): AtlasIndexFile[]
{
  const files: AtlasIndexFile[] = []
  let cursor: string | undefined
  do
  {
    const page = queryAtlasFiles(index, {
      limit: ARCHITECTURE_PROJECTION_FILE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    })
    files.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return files
}

function filesForPath(catalog: ReadonlyArray<AtlasIndexFile>, path: string): AtlasIndexFile[]
{
  const exact = catalog.filter((file) => file.id === path)
  if (exact.length > 0) return exact
  const prefix = `${path}/`
  return catalog.filter((file) => file.id.startsWith(prefix))
}

function unitById(
  index: AtlasIndex,
  level: AtlasIndexLevel,
  id: string,
): AtlasIndexUnit | undefined
{
  return index.units[level].find((unit) => unit.id === id)
}

function chipKey(level: ChipLevel, id: string): string
{
  return `${level}:${id}`
}

function addUnitChip(
  chips: Map<string, ArchitecturePathScopeChip>,
  index: AtlasIndex,
  role: ArchitecturePathScopeChip['role'],
  level: ChipLevel,
  id: string,
): void
{
  const key = chipKey(level, id)
  if (chips.has(key)) return
  const unit = unitById(index, level, id)
  if (unit === undefined) return
  chips.set(key, {
    role,
    level,
    id: unit.id,
    key: unit.key,
    label: unit.label,
  })
}

function neighborIds(index: AtlasIndex, level: ChipLevel, unitId: string): string[]
{
  const ids: string[] = []
  for (const edge of index.edges[level])
  {
    if (edge.from === unitId) ids.push(edge.to)
    else if (edge.to === unitId) ids.push(edge.from)
  }
  return ids
}

function compareChips(left: ArchitecturePathScopeChip, right: ArchitecturePathScopeChip): number
{
  const roleOrder = (left.role === 'touched' ? 0 : 1) - (right.role === 'touched' ? 0 : 1)
  if (roleOrder !== 0) return roleOrder
  const levelOrder = (left.level === 'systems' ? 0 : 1) - (right.level === 'systems' ? 0 : 1)
  if (levelOrder !== 0) return levelOrder
  return left.label.localeCompare(right.label)
}

// exact file ids or directory prefixes against the standing atlas catalog;
// touched systems/blocks plus one-hop undirected neighbors
export function resolveArchitecturePathScope(
  index: AtlasIndex,
  paths: ReadonlyArray<string>,
): ArchitecturePathScopeChip[]
{
  const catalog = catalogFiles(index)
  const matched = new Map<string, AtlasIndexFile>()
  for (const path of paths.slice(0, ARCHITECTURE_BLAST_PATH_LIMIT))
  {
    for (const file of filesForPath(catalog, path))
    {
      matched.set(file.id, file)
    }
  }

  const touched = new Map<string, ArchitecturePathScopeChip>()
  for (const file of matched.values())
  {
    if (file.system !== undefined)
    {
      addUnitChip(touched, index, 'touched', 'systems', file.system)
    }
    if (file.block !== undefined)
    {
      addUnitChip(touched, index, 'touched', 'blocks', file.block)
    }
  }

  const context = new Map<string, ArchitecturePathScopeChip>()
  for (const chip of touched.values())
  {
    for (const neighborId of neighborIds(index, chip.level, chip.id))
    {
      const key = chipKey(chip.level, neighborId)
      if (touched.has(key)) continue
      addUnitChip(context, index, 'context', chip.level, neighborId)
    }
  }

  return [...touched.values(), ...context.values()]
    .toSorted(compareChips)
    .slice(0, ARCHITECTURE_PATH_SCOPE_UNIT_LIMIT)
}
