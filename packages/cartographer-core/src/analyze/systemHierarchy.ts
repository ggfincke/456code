// packages/cartographer-core/src/analyze/systemHierarchy.ts
// shared system candidate selection and file assignment

export const MIN_SYSTEMS = 2
export const MAX_SYSTEMS = 12
export const DOMINANT_SRC_SHARE = 0.5
export const MIN_SYSTEM_FILES = 2
export const MIN_SYSTEM_SHARE = 0.02
export const MAX_SYSTEM_PATH_DEPTH = 6

const INITIAL_SYSTEM_PATH_DEPTH = 2

interface SystemSummaryLike
{
  id: string
  label: string
  description?: string
  source: 'authored' | 'fallback'
}

interface SystemFileLike
{
  id: string
  group: string
  system?: string
}

export interface SystemHierarchyCandidate
{
  key: string
  label: string
  description: string
  source: 'authored' | 'fallback' | 'inferred'
}

export interface SelectedSystemHierarchy
{
  source: 'authored' | 'inferred'
  candidates: SystemHierarchyCandidate[]
  systemOfFile: Map<string, string>
}

function displayPath(key: string): string
{
  if (key === '.')
  {
    return 'Root'
  }
  const segment = key.split('/').pop() ?? key
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function otherSystemKey(used: Set<string>): string
{
  let key = 'Other'
  while (used.has(key))
  {
    key = `_${key}`
  }
  return key
}

function folderKey(id: string, depth: number): string
{
  const slash = id.lastIndexOf('/')
  if (slash <= 0)
  {
    return '.'
  }
  const dir = id.slice(0, slash)
  const segments = dir.split('/')
  return segments.length <= depth ? dir : segments.slice(0, depth).join('/')
}

function authoredHierarchy(
  files: readonly SystemFileLike[],
  summaries: readonly SystemSummaryLike[],
): SelectedSystemHierarchy | undefined
{
  const candidates: SystemHierarchyCandidate[] = []
  const seen = new Set<string>()
  for (const summary of summaries)
  {
    if (seen.has(summary.id))
    {
      continue
    }
    seen.add(summary.id)
    candidates.push({
      key: summary.id,
      label: summary.label,
      description: summary.description ?? `${summary.label} system.`,
      source: summary.source,
    })
  }

  const systemOfFile = new Map<string, string>()
  for (const file of files)
  {
    if (file.system === undefined)
    {
      continue
    }
    systemOfFile.set(file.id, file.system)
    if (!seen.has(file.system))
    {
      seen.add(file.system)
      candidates.push({
        key: file.system,
        label: file.system,
        description: `${file.system} system.`,
        source: 'authored',
      })
    }
  }

  let fallback = candidates.find((candidate) => candidate.source === 'fallback')
  if (!fallback && systemOfFile.size < files.length)
  {
    const key = otherSystemKey(seen)
    fallback = {
      key,
      label: 'Other',
      description: 'Files outside the authored system rules.',
      source: 'fallback',
    }
    candidates.push(fallback)
  }
  if (fallback)
  {
    for (const file of files)
    {
      if (!systemOfFile.has(file.id))
      {
        systemOfFile.set(file.id, fallback.key)
      }
    }
  }

  const active = new Set(systemOfFile.values())
  const selected = candidates.filter((candidate) => active.has(candidate.key))
  const authoredCount = selected.filter((candidate) => candidate.source === 'authored').length
  return authoredCount >= MIN_SYSTEMS
    ? { source: 'authored', candidates: selected, systemOfFile }
    : undefined
}

function inferredHierarchy(
  files: readonly SystemFileLike[],
  rawSystemOfFile: Map<string, string>,
): SelectedSystemHierarchy
{
  const counts = new Map<string, number>()
  for (const key of rawSystemOfFile.values())
  {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  if (ranked.length === 0)
  {
    return {
      source: 'inferred',
      candidates: [],
      systemOfFile: new Map(),
    }
  }

  const minFiles = Math.max(MIN_SYSTEM_FILES, Math.ceil(files.length * MIN_SYSTEM_SHARE))
  let kept = ranked.filter(([, count]) => count >= minFiles)
  if (kept.length === 0)
  {
    kept = ranked.slice(0, 1)
  }
  const initialKept = new Set(kept.map(([key]) => key))
  let hasTail = ranked.some(([key]) => !initialKept.has(key))
  if (kept.length > MAX_SYSTEMS || (kept.length === MAX_SYSTEMS && hasTail))
  {
    kept = kept.slice(0, MAX_SYSTEMS - 1)
    hasTail = true
  }

  const keptKeys = new Set(kept.map(([key]) => key))
  const otherKey = hasTail ? otherSystemKey(new Set(counts.keys())) : undefined
  const baseLabelCounts = new Map<string, number>()
  for (const [key] of kept)
  {
    const label = displayPath(key)
    baseLabelCounts.set(label, (baseLabelCounts.get(label) ?? 0) + 1)
  }
  const candidates: SystemHierarchyCandidate[] = kept.map(([key]) => ({
    key,
    label: (baseLabelCounts.get(displayPath(key)) ?? 0) > 1 ? key : displayPath(key),
    description: key === '.' ? 'Files at the repository root.' : `${key}/ subtree`,
    source: 'inferred',
  }))
  if (otherKey)
  {
    candidates.push({
      key: otherKey,
      label: 'Other',
      description: 'Smaller path systems folded together.',
      source: 'inferred',
    })
  }

  const systemOfFile = new Map<string, string>()
  for (const [file, raw] of rawSystemOfFile)
  {
    systemOfFile.set(file, keptKeys.has(raw) ? raw : (otherKey ?? raw))
  }
  return { source: 'inferred', candidates, systemOfFile }
}

// one selected hierarchy feeds both the persisted index & detailed model
export function selectSystemHierarchy(
  files: readonly SystemFileLike[],
  summaries: readonly SystemSummaryLike[],
): SelectedSystemHierarchy
{
  const authored = authoredHierarchy(files, summaries)
  if (authored)
  {
    return authored
  }

  const rootCounts = new Map<string, number>()
  for (const file of files)
  {
    const root = file.id.includes('/') ? file.id.split('/')[0]! : '.'
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1)
  }
  const expandSrc = (rootCounts.get('src') ?? 0) >= files.length * DOMINANT_SRC_SHARE
  const initial = new Map<string, string>()
  for (const file of files)
  {
    const root = file.id.includes('/') ? file.id.split('/')[0]! : '.'
    initial.set(
      file.id,
      expandSrc && root === 'src' ? folderKey(file.id, INITIAL_SYSTEM_PATH_DEPTH) : root,
    )
  }
  const first = inferredHierarchy(files, initial)
  if (first.candidates.length >= MIN_SYSTEMS)
  {
    return first
  }

  for (let depth = INITIAL_SYSTEM_PATH_DEPTH; depth <= MAX_SYSTEM_PATH_DEPTH; depth += 1)
  {
    const deeper = new Map(
      files.map((file): [string, string] => [file.id, folderKey(file.id, depth)]),
    )
    const selected = inferredHierarchy(files, deeper)
    if (selected.candidates.length >= MIN_SYSTEMS)
    {
      return selected
    }
  }

  const byBlock = new Map(files.map((file): [string, string] => [file.id, file.group]))
  const blocks = inferredHierarchy(files, byBlock)
  return blocks.candidates.length >= MIN_SYSTEMS ? blocks : first
}
