// packages/shared/src/toolMutationTargets.ts
// collect file paths a tool activity payload claims to have mutated

// leaf keys probed in this exact order. the order is load-bearing: every caller
// caps the result, so reordering silently changes which paths survive the cap
const LEAF_PATH_KEYS = [
  'path',
  'filePath',
  'relativePath',
  'filename',
  'newPath',
  'oldPath',
] as const

// snake_case leaf keys are opt-in because the web work log has never probed
// them and its assertions pin the exact array it produces. the server divergence
// classifier does need them: a live claude edit arrives as
// { itemType: 'file_change', data: { toolName: 'Edit', input: { file_path } } }
// and would otherwise yield no mutation evidence at all
const SNAKE_CASE_LEAF_PATH_KEYS = ['file_path', 'new_path', 'old_path'] as const

// containers the walk descends into, in this order
const NESTED_KEYS = [
  'item',
  'result',
  'input',
  'data',
  'changes',
  'files',
  'edits',
  'patch',
  'patches',
  'operations',
] as const

const DEFAULT_MAX_PATHS = 12
const DEFAULT_MAX_DEPTH = 4

export interface ToolMutationTargetOptions
{
  readonly maxPaths?: number | undefined
  readonly maxDepth?: number | undefined
  readonly includeSnakeCaseKeys?: boolean | undefined
}

// permissive on purpose: arrays are objects here, and the walk dispatches on
// them before it ever reaches this
function asRecord(value: unknown): Record<string, unknown> | null
{
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asTrimmedString(value: unknown): string | null
{
  if (typeof value !== 'string')
  {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function pushPath(target: string[], seen: Set<string>, value: unknown)
{
  const normalized = asTrimmedString(value)
  if (!normalized || seen.has(normalized))
  {
    return
  }
  seen.add(normalized)
  target.push(normalized)
}

interface WalkLimits
{
  readonly maxPaths: number
  readonly maxDepth: number
  readonly leafKeys: ReadonlyArray<string>
}

// bounded on both axes because provider payloads are unvalidated and can nest
// arbitrarily deep; an unbounded walk here would run on every activity row
function walk(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
  limits: WalkLimits,
)
{
  if (depth > limits.maxDepth || target.length >= limits.maxPaths)
  {
    return
  }
  if (Array.isArray(value))
  {
    for (const entry of value)
    {
      walk(entry, target, seen, depth + 1, limits)
      if (target.length >= limits.maxPaths)
      {
        return
      }
    }
    return
  }

  const record = asRecord(value)
  if (!record)
  {
    return
  }

  for (const leafKey of limits.leafKeys)
  {
    pushPath(target, seen, record[leafKey])
  }

  for (const nestedKey of NESTED_KEYS)
  {
    if (!(nestedKey in record))
    {
      continue
    }
    walk(record[nestedKey], target, seen, depth + 1, limits)
    if (target.length >= limits.maxPaths)
    {
      return
    }
  }
}

export function collectToolMutationTargets(
  value: unknown,
  options?: ToolMutationTargetOptions | undefined,
): ReadonlyArray<string>
{
  const target: string[] = []
  walk(value, target, new Set<string>(), 0, {
    maxPaths: options?.maxPaths ?? DEFAULT_MAX_PATHS,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    leafKeys: options?.includeSnakeCaseKeys
      ? [...LEAF_PATH_KEYS, ...SNAKE_CASE_LEAF_PATH_KEYS]
      : LEAF_PATH_KEYS,
  })
  return target
}
