// packages/client-runtime/src/mediaSource.ts
// resolve authored media into direct or authenticated environment sources

import type { AssetResource, ThreadId } from '@t3tools/contracts'

import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
  type MarkdownImageSource,
} from './markdownImages.ts'

const MEDIA_MIME_TYPES = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
])

export type MediaSourceResource = Extract<AssetResource, { readonly _tag: 'workspace-file' }>

export type ResolvedMediaSource = {
  readonly kind: 'image' | 'video'
  readonly mimeType: string
  readonly name: string
  readonly srcFragment: string
} & (
  | { readonly access: 'direct'; readonly uri: string }
  | { readonly access: 'environment'; readonly resource: MediaSourceResource }
  | { readonly access: 'unavailable' }
)

export interface ResolveMediaSourceInput
{
  readonly threadId: ThreadId | undefined
  readonly workspaceRoot?: string | null | undefined
  readonly resolvedFilePath?: string | undefined
  readonly imageEmbed?: boolean | undefined
}

function classify(source: string, input: ResolveMediaSourceInput): MarkdownImageSource
{
  return input.resolvedFilePath === undefined
    ? classifyMarkdownImageSource(source, input.workspaceRoot)
    : { _tag: 'WorkspaceFile', path: input.resolvedFilePath }
}

function sourcePath(source: MarkdownImageSource): string
{
  const value =
    source._tag === 'Direct' ? source.uri : source._tag === 'WorkspaceFile' ? source.path : ''
  const searchIndex = value.indexOf('?')
  const hashIndex = value.indexOf('#')
  const end = [searchIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), value.length)
  return value.slice(0, end)
}

function fileBasename(path: string): string
{
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

export function resolveMediaSource(
  source: string,
  input: ResolveMediaSourceInput,
): ResolvedMediaSource | null
{
  const classified = classify(source, input)
  if (classified._tag === 'Blocked') return null
  const path = sourcePath(classified)
  const name = fileBasename(path) || 'image'
  const extensionIndex = name.lastIndexOf('.')
  const mimeType =
    extensionIndex >= 0
      ? (MEDIA_MIME_TYPES.get(name.slice(extensionIndex).toLowerCase()) ?? null)
      : null
  const resolvedMimeType = mimeType ?? (input.imageEmbed ? 'image/*' : null)
  if (resolvedMimeType === null) return null
  const common = {
    kind: resolvedMimeType.startsWith('video/') ? ('video' as const) : ('image' as const),
    mimeType: resolvedMimeType,
    name,
    srcFragment: markdownImageSourceFragment(source),
  }

  if (classified._tag === 'Direct')
  {
    return { ...common, access: 'direct', uri: classified.uri }
  }
  if (input.threadId === undefined) return { ...common, access: 'unavailable' }
  return {
    ...common,
    access: 'environment',
    resource: { _tag: 'workspace-file', threadId: input.threadId, path },
  }
}
