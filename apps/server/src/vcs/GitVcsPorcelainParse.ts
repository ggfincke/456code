// apps/server/src/vcs/GitVcsPorcelainParse.ts
// parse git porcelain, numstat, remotes, and branch list helpers

import * as PlatformError from 'effect/PlatformError'

import { GitCommandError, type VcsRef } from '@t3tools/contracts'

import { parseRemoteRefWithRemoteNames } from './gitRefParse.ts'
import type * as GitVcsDriver from './GitVcsDriver.ts'

export const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100

export function parseBranchAb(value: string): { ahead: number; behind: number }
{
  const match = value.match(/^\+(\d+)\s+-(\d+)$/)
  if (!match) return { ahead: 0, behind: 0 }
  return {
    ahead: Number(match[1] ?? '0'),
    behind: Number(match[2] ?? '0'),
  }
}

export function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }>
{
  const entries: Array<{ path: string; insertions: number; deletions: number }> = []
  for (const line of stdout.split(/\r?\n/g))
  {
    if (line.trim().length === 0) continue
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t')
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? '').trim() : pathParts.join('\t').trim()
    if (rawPath.length === 0) continue
    const added = Number.parseInt(addedRaw ?? '0', 10)
    const deleted = Number.parseInt(deletedRaw ?? '0', 10)
    const braceRename = /^(.*)\{[^{}]* => ([^{}]*)\}(.*)$/u.exec(rawPath)
    const expandedBraceRename = braceRename
      ? `${braceRename[1] ?? ''}${braceRename[2] ?? ''}${braceRename[3] ?? ''}`
      : null
    const renameArrowIndex = rawPath.indexOf(' => ')
    const normalizedPath =
      expandedBraceRename ??
      (renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + ' => '.length).trim() : rawPath)
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    })
  }
  return entries
}

export function parsePorcelainPath(line: string): string | null
{
  if (line.startsWith('? ') || line.startsWith('! '))
  {
    const simple = line.slice(2).trim()
    return simple.length > 0 ? simple : null
  }

  if (!(line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')))
  {
    return null
  }

  const tabIndex = line.indexOf('\t')
  if (tabIndex >= 0)
  {
    const fromTab = line.slice(tabIndex + 1)
    const [filePath] = fromTab.split('\t')
    return filePath?.trim().length ? filePath.trim() : null
  }

  const parts = line.trim().split(/\s+/g)
  const filePath = parts.at(-1) ?? ''
  return filePath.length > 0 ? filePath : null
}

export function filterBranchesForListQuery(
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef>
{
  if (!query)
  {
    return refs
  }

  const normalizedQuery = query.toLowerCase()
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery))
}

export function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>
  cursor?: number | undefined
  limit?: number | undefined
}): {
  refs: ReadonlyArray<VcsRef>
  nextCursor: number | null
  totalCount: number
}
{
  const cursor = input.cursor ?? 0
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT
  const totalCount = input.refs.length
  const refs = input.refs.slice(cursor, cursor + limit)
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null

  return {
    refs,
    nextCursor,
    totalCount,
  }
}

export function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string>
{
  const worktreePaths = new Map<string, string>()
  let currentPath: string | null = null
  let currentBranch: string | null = null
  let currentPrunable = false

  const flush = () =>
  {
    if (currentPath !== null && currentBranch !== null && !currentPrunable)
    {
      worktreePaths.set(currentBranch, currentPath)
    }
    currentPath = null
    currentBranch = null
    currentPrunable = false
  }

  for (const field of stdout.split('\0'))
  {
    if (field === '')
    {
      flush()
    }
    else if (field.startsWith('worktree '))
    {
      currentPath = field.slice('worktree '.length)
    }
    else if (field.startsWith('branch refs/heads/'))
    {
      currentBranch = field.slice('branch refs/heads/'.length)
    }
    else if (field === 'prunable' || field.startsWith('prunable '))
    {
      currentPrunable = true
    }
  }
  flush()

  return worktreePaths
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[]
{
  const parts = input.split('\0')
  if (parts.length === 0) return []

  if (truncated && parts[parts.length - 1]?.length)
  {
    parts.pop()
  }

  return parts.filter((value) => value.length > 0)
}

export function splitNullSeparatedGitStdoutPaths(
  result: Pick<GitVcsDriver.ExecuteGitResult, 'stdout' | 'stdoutTruncated'>,
): string[]
{
  return splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)
}

export function sanitizeRemoteName(value: string): string
{
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized.length > 0 ? sanitized : 'fork'
}

export function parseRemoteFetchUrls(stdout: string): Map<string, string>
{
  const remotes = new Map<string, string>()
  for (const line of stdout.split('\n'))
  {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed)
    if (!match) continue
    const [, remoteName = '', remoteUrl = '', direction = ''] = match
    if (direction !== 'fetch' || remoteName.length === 0 || remoteUrl.length === 0)
    {
      continue
    }
    remotes.set(remoteName, remoteUrl)
  }
  return remotes
}

export function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null
{
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames)
  if (!parsed)
  {
    return null
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  }
}

export function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null
{
  const separatorIndex = upstreamRef.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1)
  {
    return null
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim()
  const branchName = upstreamRef.slice(separatorIndex + 1).trim()
  if (remoteName.length === 0 || branchName.length === 0)
  {
    return null
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
  }
}

export function parseTrackingBranchByUpstreamRef(
  stdout: string,
  upstreamRef: string,
): string | null
{
  for (const line of stdout.split('\n'))
  {
    const trimmedLine = line.trim()
    if (trimmedLine.length === 0)
    {
      continue
    }
    const [branchNameRaw, upstreamBranchRaw = ''] = trimmedLine.split('\t')
    const branchName = branchNameRaw?.trim() ?? ''
    const candidateUpstreamRef = upstreamBranchRaw.trim()
    if (branchName.length === 0 || candidateUpstreamRef.length === 0)
    {
      continue
    }
    if (candidateUpstreamRef === upstreamRef)
    {
      return branchName
    }
  }

  return null
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null
{
  const separatorIndex = branchName.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1)
  {
    return null
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim()
  return localBranch.length > 0 ? localBranch : null
}

export function gitCommandContext(
  input: Pick<GitVcsDriver.ExecuteGitInput, 'operation' | 'cwd' | 'args'>,
)
{
  return {
    operation: input.operation,
    command: 'git',
    cwd: input.cwd,
    argumentCount: input.args.length,
  } as const
}

export function parseDefaultBranchFromRemoteHeadRef(
  value: string,
  remoteName: string,
): string | null
{
  const trimmed = value.trim()
  const prefix = `refs/remotes/${remoteName}/`
  if (!trimmed.startsWith(prefix))
  {
    return null
  }
  const refName = trimmed.slice(prefix.length).trim()
  return refName.length > 0 ? refName : null
}

export function isMissingGitCwdError(error: GitCommandError): boolean
{
  if (!(error.cause instanceof PlatformError.PlatformError))
  {
    return false
  }

  const reason = error.cause.reason
  if (reason._tag === 'NotFound')
  {
    return reason.pathOrDescriptor === error.cwd
  }

  return (
    reason._tag === 'BadResource' &&
    reason.pathOrDescriptor === error.cwd &&
    typeof reason.cause === 'object' &&
    reason.cause !== null &&
    'code' in reason.cause &&
    reason.cause.code === 'ENOTDIR'
  )
}

export function isNonRepositoryGitStderr(stderr: string): boolean
{
  return stderr.toLowerCase().includes('not a git repository')
}

export function isUnbornHeadStderr(stderr: string): boolean
{
  return (
    stderr.toLowerCase().includes('unknown revision') &&
    stderr.toLowerCase().includes('path not in the working tree')
  )
}
