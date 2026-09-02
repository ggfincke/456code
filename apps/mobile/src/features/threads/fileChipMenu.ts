// apps/mobile/src/features/threads/fileChipMenu.ts
// build file-chip actions from safe workspace paths

import { resolveMarkdownLinkPresentation } from '@t3tools/mobile-markdown-text/links'
import type { MarkdownFileContextMenu } from '@t3tools/mobile-markdown-text/types'

import {
  isAbsolutePath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from '../files/filePath'

export type FileChipAction = 'copy-full-path' | 'copy-relative-path' | 'open-file'

export interface FileChipTarget
{
  readonly fullPath?: string
  readonly relativePath?: string
}

export function resolveFileChipTarget(
  href: string,
  workspaceRoot: string | null | undefined,
): FileChipTarget | null
{
  const presentation = resolveMarkdownLinkPresentation(href)
  if (presentation.kind !== 'file') return null
  const relativePath = resolveWorkspaceRelativeFilePath(workspaceRoot, presentation.path)
  const fullPath = isAbsolutePath(presentation.path)
    ? presentation.path
    : workspaceRoot && relativePath
      ? resolveWorkspaceFilePath(workspaceRoot, relativePath)
      : undefined
  if (!fullPath && !relativePath) return null
  return {
    ...(fullPath ? { fullPath } : {}),
    ...(relativePath ? { relativePath } : {}),
  }
}

export function fileChipMenu(target: FileChipTarget): MarkdownFileContextMenu
{
  return {
    title: target.fullPath ?? target.relativePath ?? '',
    actions: [
      ...(target.fullPath ? [{ id: 'copy-full-path', title: 'Copy full path' }] : []),
      ...(target.relativePath ? [{ id: 'copy-relative-path', title: 'Copy relative path' }] : []),
      { id: 'open-file', title: 'Open in file viewer' },
    ],
  }
}
