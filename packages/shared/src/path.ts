// packages/shared/src/path.ts
// normalize cross-platform project paths

export function isWindowsDrivePath(value: string): boolean
{
  return /^[a-zA-Z]:([/\\]|$)/.test(value)
}

export function isUncPath(value: string): boolean
{
  return value.startsWith('\\\\')
}

export function isWindowsAbsolutePath(value: string): boolean
{
  return isUncPath(value) || isWindowsDrivePath(value)
}

export function isExplicitRelativePath(value: string): boolean
{
  return (
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\')
  )
}

function isRootPath(value: string): boolean
{
  return value === '/' || value === '\\' || /^[a-zA-Z]:[/\\]?$/.test(value)
}

function trimTrailingPathSeparators(value: string): string
{
  if (value.length === 0 || isRootPath(value))
  {
    return value
  }
  const trimmed = value.startsWith('/') ? value.replace(/\/+$/g, '') : value.replace(/[\\/]+$/g, '')
  if (trimmed.length === 0)
  {
    return value
  }
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
}

export function expandTildePath(value: string, homeDirectory?: string | null): string
{
  const trimmed = value.trim()
  const home = homeDirectory?.trim()
  if (!home || (trimmed !== '~' && !trimmed.startsWith('~/') && !trimmed.startsWith('~\\')))
  {
    return trimmed
  }
  const normalizedHome = trimTrailingPathSeparators(home)
  if (trimmed === '~')
  {
    return normalizedHome
  }
  const separator = isWindowsAbsolutePath(normalizedHome) ? '\\' : '/'
  const suffix = trimmed.slice(2).replaceAll(/[\\/]+/g, separator)
  return suffix.length === 0 ? normalizedHome : `${normalizedHome}${separator}${suffix}`
}

export function normalizeProjectPathForDispatch(
  value: string,
  homeDirectory?: string | null,
): string
{
  return trimTrailingPathSeparators(expandTildePath(value, homeDirectory))
}

export function normalizeProjectPathForComparison(
  value: string,
  homeDirectory?: string | null,
): string
{
  const normalized = normalizeProjectPathForDispatch(value, homeDirectory)
  if (isWindowsDrivePath(normalized) || isUncPath(normalized))
  {
    return normalized.replaceAll('/', '\\').toLowerCase()
  }
  return normalized
}
