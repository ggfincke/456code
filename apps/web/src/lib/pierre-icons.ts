// apps/web/src/lib/pierre-icons.ts
// provide web pierre icons

import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  type FileTreeIcons,
} from '@pierre/trees'
import {
  PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME,
  PIERRE_CUSTOM_FILE_ICON_SPRITE,
} from '@t3tools/shared/pierreFileIcons'

export interface PierreIconResolution
{
  name: string
  token?: string
}

const PIERRE_ICON_SPRITE_ID = '456code-pierre-file-icon-sprite'

export const PIERRE_ICONS = {
  set: 'complete',
  colored: true,
  spriteSheet: PIERRE_CUSTOM_FILE_ICON_SPRITE,
  byFileName: PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME,
} satisfies FileTreeIcons

const completeIconResolver = createFileTreeIconResolver(PIERRE_ICONS)

const LANGUAGE_EXTENSION_ALIASES: Record<string, string> = {
  bash: 'sh',
  csharp: 'cs',
  dockerfile: 'dockerfile',
  javascript: 'js',
  jsx: 'jsx',
  markdown: 'md',
  mdx: 'mdx',
  plaintext: 'txt',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  shell: 'sh',
  shellscript: 'sh',
  swift: 'swift',
  typescript: 'ts',
  tsx: 'tsx',
  yaml: 'yml',
}

export function basenameOfPath(pathValue: string): string
{
  const slashIndex = pathValue.lastIndexOf('/')
  return slashIndex === -1 ? pathValue : pathValue.slice(slashIndex + 1)
}

export function inferEntryKindFromPath(pathValue: string): 'file' | 'directory'
{
  const base = basenameOfPath(pathValue)
  if (base.startsWith('.') && !base.slice(1).includes('.')) return 'directory'
  return base.includes('.') ? 'file' : 'directory'
}

export function syntheticFileNameForLanguageId(languageId: string): string
{
  const normalized = languageId.toLowerCase()
  return `file.${LANGUAGE_EXTENSION_ALIASES[normalized] ?? normalized}`
}

export function resolvePierreIconForEntry(
  pathValue: string,
  kind: 'file' | 'directory',
): PierreIconResolution | null
{
  if (kind === 'directory') return null
  return completeIconResolver.resolveIcon('file-tree-icon-file', pathValue)
}

export function hasSpecificPierreIconForFileName(fileName: string): boolean
{
  return resolvePierreIconForEntry(fileName, 'file')?.token !== 'default'
}

export function ensurePierreIconSprite(): void
{
  if (typeof document === 'undefined' || document.getElementById(PIERRE_ICON_SPRITE_ID)) return
  const container = document.createElement('div')
  container.id = PIERRE_ICON_SPRITE_ID
  container.setAttribute('aria-hidden', 'true')
  container.style.position = 'absolute'
  container.style.width = '0'
  container.style.height = '0'
  container.style.overflow = 'hidden'
  container.style.pointerEvents = 'none'
  container.innerHTML = `${getBuiltInSpriteSheet('complete')}${PIERRE_CUSTOM_FILE_ICON_SPRITE}`
  document.body.prepend(container)
}
