// apps/web/src/lib/workspaceBasenameLookup.ts
// resolve bare markdown filenames through the workspace search index

import { resolvePathLinkTarget } from './terminal-links'

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25

let latestLookupSequence = 0

export function claimWorkspaceBasenameLookup(): () => boolean
{
  latestLookupSequence += 1
  const claimed = latestLookupSequence
  return () => claimed === latestLookupSequence
}

export interface WorkspaceEntryCandidate
{
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface WorkspaceFileActionSource
{
  readonly filePath: string
  readonly targetPath: string
  readonly workspaceRelativePath: string | null
}

export type WorkspaceFileActionTarget = WorkspaceFileActionSource

export type WorkspaceFilePrimaryAction =
  | { readonly kind: 'editor'; readonly targetPath: string }
  | { readonly kind: 'panel'; readonly workspaceRelativePath: string }
  | { readonly kind: 'browser'; readonly filePath: string }

function basenameOfPath(path: string): string
{
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean
{
  const trimmed = relativePath.trim()
  return trimmed.length > 0 && !trimmed.includes('/') && !trimmed.includes('\\')
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null
{
  const target = basename.trim()
  if (!target) return null

  const files = entries.filter((entry) => entry.kind === 'file')
  const exact = files.find((entry) => basenameOfPath(entry.path) === target)
  if (exact) return exact.path

  const folded = target.toLowerCase()
  const foldedMatches = files.filter((entry) => basenameOfPath(entry.path).toLowerCase() === folded)
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null
}

export async function resolveWorkspaceFileActionTarget(input: {
  readonly source: WorkspaceFileActionSource
  readonly cwd: string | undefined
  readonly searchEntries: (basename: string) => Promise<ReadonlyArray<WorkspaceEntryCandidate>>
}): Promise<WorkspaceFileActionTarget | null>
{
  const isLatestLookup = claimWorkspaceBasenameLookup()
  const { source } = input
  if (
    !input.cwd ||
    !source.workspaceRelativePath ||
    !needsWorkspaceBasenameLookup(source.workspaceRelativePath)
  )
  {
    return source
  }

  const entries = await input.searchEntries(source.workspaceRelativePath)
  if (!isLatestLookup()) return null

  const match = pickWorkspaceBasenameMatch(source.workspaceRelativePath, entries)
  if (!match || match === source.workspaceRelativePath) return source

  const filePath = resolvePathLinkTarget(match, input.cwd)
  const positionSuffix = source.targetPath.startsWith(source.filePath)
    ? source.targetPath.slice(source.filePath.length)
    : ''
  return {
    filePath,
    targetPath: `${filePath}${positionSuffix}`,
    workspaceRelativePath: match,
  }
}

export async function resolveWorkspaceFilePrimaryAction(input: {
  readonly resolveTarget: () => Promise<WorkspaceFileActionTarget | null>
  readonly hasThreadContext: boolean
  readonly canOpenInBrowser: (filePath: string) => boolean
}): Promise<WorkspaceFilePrimaryAction | null>
{
  const target = await input.resolveTarget()
  if (!target) return null
  if (!input.hasThreadContext || !target.workspaceRelativePath)
  {
    return { kind: 'editor', targetPath: target.targetPath }
  }
  if (input.canOpenInBrowser(target.filePath))
  {
    return { kind: 'browser', filePath: target.filePath }
  }
  return { kind: 'panel', workspaceRelativePath: target.workspaceRelativePath }
}
