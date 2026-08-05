// packages/shared/src/filePreview.ts
// classifies preview files and resolves safe mdx targets

export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = ['.htm', '.html', '.pdf'] as const

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
] as const

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean
{
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension))
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean
{
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS)
}

export function isWorkspaceImagePreviewPath(path: string): boolean
{
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS)
}

export function isWorkspacePreviewEntryPath(path: string): boolean
{
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path)
}

export type MdxTargetRejection =
  | 'absolute_path'
  | 'ambiguous_percent_encoding'
  | 'backslash'
  | 'control_character'
  | 'empty'
  | 'external_not_allowed'
  | 'fragment_not_allowed'
  | 'malformed_percent_encoding'
  | 'query_not_allowed'
  | 'unsupported_protocol'
  | 'workspace_escape'

export type MdxWorkspaceTarget = {
  readonly kind: 'workspace'
  readonly path: string
  readonly fragment: string | null
}

export type MdxExternalTarget = {
  readonly kind: 'external'
  readonly href: string
}

export type MdxFragmentTarget = {
  readonly kind: 'fragment'
  readonly fragment: string
}

export type MdxRejectedTarget = {
  readonly kind: 'rejected'
  readonly reason: MdxTargetRejection
}

export type MdxTargetResolution = MdxWorkspaceTarget | MdxExternalTarget | MdxRejectedTarget

export type MdxWorkspacePathResolution = MdxWorkspaceTarget | MdxRejectedTarget

const BACKSLASH_PATTERN = /\\/u
const EXTERNAL_SCHEME_PATTERN = /^([a-z][a-z\d+.-]*):/iu
const WINDOWS_DRIVE_PATTERN = /^[a-z]:/iu
const AMBIGUOUS_PERCENT_ENCODING_PATTERN = /%(?:0[\da-f]|1[\da-f]|23|25|2f|3f|5c|7f)/iu
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

function rejected(reason: MdxTargetRejection): MdxRejectedTarget
{
  return { kind: 'rejected', reason }
}

function hasControlCharacter(value: string): boolean
{
  for (const character of value)
  {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f))
    {
      return true
    }
  }
  return false
}

function validateMdxTargetText(target: string): MdxRejectedTarget | null
{
  if (hasControlCharacter(target))
  {
    return rejected('control_character')
  }
  if (BACKSLASH_PATTERN.test(target))
  {
    return rejected('backslash')
  }

  let encoded = target
  while (encoded.includes('%'))
  {
    if (AMBIGUOUS_PERCENT_ENCODING_PATTERN.test(encoded))
    {
      return rejected('ambiguous_percent_encoding')
    }

    let decoded: string
    try
    {
      decoded = decodeURIComponent(encoded)
    }
    catch
    {
      return rejected('malformed_percent_encoding')
    }
    if (decoded === encoded)
    {
      break
    }
    encoded = decoded
  }

  return null
}

function normalizeWorkspaceSegments(
  baseSegments: ReadonlyArray<string>,
  relativePath: string,
  fragment: string | null,
): MdxWorkspacePathResolution
{
  if (relativePath.length === 0)
  {
    return rejected('empty')
  }
  if (relativePath.startsWith('/') || WINDOWS_DRIVE_PATTERN.test(relativePath))
  {
    return rejected('absolute_path')
  }
  if (relativePath.includes('?'))
  {
    return rejected('query_not_allowed')
  }
  if (EXTERNAL_SCHEME_PATTERN.test(relativePath))
  {
    return rejected('unsupported_protocol')
  }

  const decodedPath = decodeURIComponent(relativePath)
  if (hasControlCharacter(decodedPath))
  {
    return rejected('control_character')
  }
  if (BACKSLASH_PATTERN.test(decodedPath))
  {
    return rejected('backslash')
  }
  if (decodedPath.startsWith('/') || WINDOWS_DRIVE_PATTERN.test(decodedPath))
  {
    return rejected('absolute_path')
  }
  if (decodedPath.includes('?'))
  {
    return rejected('query_not_allowed')
  }
  if (EXTERNAL_SCHEME_PATTERN.test(decodedPath))
  {
    return rejected('unsupported_protocol')
  }

  const segments = [...baseSegments]
  for (const segment of decodedPath.split('/'))
  {
    if (segment.length === 0 || segment === '.')
    {
      continue
    }
    if (segment === '..')
    {
      if (segments.length === 0)
      {
        return rejected('workspace_escape')
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  if (segments.length === 0)
  {
    return rejected('empty')
  }

  return {
    kind: 'workspace',
    path: segments.join('/'),
    fragment,
  }
}

function normalizeWorkspacePath(target: string): MdxWorkspacePathResolution
{
  const invalidText = validateMdxTargetText(target)
  if (invalidText)
  {
    return invalidText
  }
  if (target.includes('#'))
  {
    return rejected('fragment_not_allowed')
  }
  return normalizeWorkspaceSegments([], target, null)
}

function resolveExternalAnchor(target: string): MdxExternalTarget | MdxRejectedTarget | null
{
  const scheme = EXTERNAL_SCHEME_PATTERN.exec(target)
  if (!scheme)
  {
    return null
  }

  const protocol = `${scheme[1]?.toLowerCase()}:`
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(protocol))
  {
    return rejected('unsupported_protocol')
  }

  try
  {
    const url = new URL(target)
    if (url.protocol !== protocol)
    {
      return rejected('unsupported_protocol')
    }
    return { kind: 'external', href: url.href }
  }
  catch
  {
    return rejected('unsupported_protocol')
  }
}

function resolveMdxWorkspaceTarget(
  documentPath: string,
  target: string,
): MdxWorkspacePathResolution | MdxFragmentTarget
{
  if (target.startsWith('#'))
  {
    return { kind: 'fragment', fragment: target.slice(1) }
  }

  const document = normalizeWorkspacePath(documentPath)
  if (document.kind === 'rejected')
  {
    return document
  }

  const fragmentIndex = target.indexOf('#')
  const relativePath = fragmentIndex === -1 ? target : target.slice(0, fragmentIndex)
  const fragment = fragmentIndex === -1 ? null : target.slice(fragmentIndex + 1)
  const documentSegments = document.path.split('/')
  documentSegments.pop()
  return normalizeWorkspaceSegments(documentSegments, relativePath, fragment)
}

export function normalizeMdxWorkspacePath(path: string): MdxWorkspacePathResolution
{
  return normalizeWorkspacePath(path)
}

export function resolveMdxAnchorTarget(documentPath: string, target: string): MdxTargetResolution
{
  const invalidText = validateMdxTargetText(target)
  if (invalidText)
  {
    return invalidText
  }

  const external = resolveExternalAnchor(target)
  if (external)
  {
    return external
  }
  if (target.includes('#'))
  {
    return rejected('fragment_not_allowed')
  }

  const resolved = resolveMdxWorkspaceTarget(documentPath, target)
  return resolved.kind === 'fragment' ? rejected('fragment_not_allowed') : resolved
}

export function resolveMdxImageTarget(
  documentPath: string,
  target: string,
): MdxWorkspacePathResolution
{
  const invalidText = validateMdxTargetText(target)
  if (invalidText)
  {
    return invalidText
  }
  if (EXTERNAL_SCHEME_PATTERN.test(target))
  {
    return rejected('external_not_allowed')
  }

  const resolved = resolveMdxWorkspaceTarget(documentPath, target)
  if (resolved.kind === 'fragment')
  {
    return rejected('fragment_not_allowed')
  }
  return resolved
}
