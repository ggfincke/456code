// apps/server/src/git/GitManagerPullRequest.ts
// pull-request identity and URL matching helpers

import * as DateTime from 'effect/DateTime'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'

import { type ChangeRequest, type GitCommandError } from '@t3tools/contracts'
import { sanitizeBranchFragment } from '@t3tools/shared/git'

export function isNotGitRepositoryError(error: GitCommandError): boolean
{
  return error.message.toLowerCase().includes('not a git repository')
}

export interface OpenPrInfo
{
  number: number
  title: string
  url: string
  baseRefName: string
  headRefName: string
}

export interface PullRequestInfo extends OpenPrInfo, PullRequestHeadRemoteInfo
{
  state: 'open' | 'closed' | 'merged'
  updatedAt: Option.Option<DateTime.Utc>
}

export const pullRequestUpdatedAtDescOrder: Order.Order<PullRequestInfo> = Order.mapInput(
  Order.flip(Option.makeOrder(DateTime.Order)),
  (pullRequest) => pullRequest.updatedAt,
)

export interface ResolvedPullRequest
{
  number: number
  title: string
  url: string
  baseBranch: string
  headBranch: string
  state: 'open' | 'closed' | 'merged'
}

export interface PullRequestHeadRemoteInfo
{
  isCrossRepository?: boolean | undefined
  headRepositoryNameWithOwner?: string | null | undefined
  headRepositoryOwnerLogin?: string | null | undefined
}

export interface BranchHeadContext
{
  localBranch: string
  headBranch: string
  headSelectors: ReadonlyArray<string>
  preferredHeadSelector: string
  remoteName: string | null
  headRemoteUrlKey: string | null
  headRepositoryNameWithOwner: string | null
  headRepositoryOwnerLogin: string | null
  isCrossRepository: boolean
}

export function parseRepositoryNameFromPullRequestUrl(url: string): string | null
{
  const trimmed = url.trim()
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/\d+(?:\/.*)?$/i.exec(trimmed)
  const repositoryName = match?.[1]?.trim() ?? ''
  return repositoryName.length > 0 ? repositoryName : null
}

export function resolveHeadRepositoryNameWithOwner(
  pullRequest: PullRequestHeadRemoteInfo & { readonly url: string },
): string | null
{
  const explicitRepository = normalizeOptionalString(pullRequest.headRepositoryNameWithOwner)
  if (explicitRepository)
  {
    return explicitRepository
  }

  if (!pullRequest.isCrossRepository)
  {
    return null
  }

  const ownerLogin = normalizeOptionalString(pullRequest.headRepositoryOwnerLogin)
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pullRequest.url)
  if (!ownerLogin || !repositoryName)
  {
    return null
  }

  return `${ownerLogin}/${repositoryName}`
}

export function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string
{
  if (!pullRequest.isCrossRepository)
  {
    return pullRequest.headBranch
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim()
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : 'head'
  return `456code/pr-${pullRequest.number}/${suffix}`
}

export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null
{
  const trimmed = url?.trim() ?? ''
  if (trimmed.length === 0)
  {
    return null
  }

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    )
  const repositoryNameWithOwner = match?.[1]?.trim() ?? ''
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null
}

export function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null
{
  const trimmed = nameWithOwner?.trim() ?? ''
  if (trimmed.length === 0)
  {
    return null
  }
  const [ownerLogin] = trimmed.split('/')
  const normalizedOwnerLogin = ownerLogin?.trim() ?? ''
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null
}

export function normalizeOptionalString(value: string | null | undefined): string | null
{
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeOptionalRepositoryNameWithOwner(
  value: string | null | undefined,
): string | null
{
  const normalized = normalizeOptionalString(value)
  return normalized ? normalized.toLowerCase() : null
}

export function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null
{
  const normalized = normalizeOptionalString(value)
  return normalized ? normalized.toLowerCase() : null
}

export interface PullRequestHeadIdentity
{
  readonly repositoryNameWithOwner: string | null
  readonly ownerLogin: string | null
}

export function resolveExpectedHeadIdentity(
  headContext: Pick<BranchHeadContext, 'headRepositoryNameWithOwner' | 'headRepositoryOwnerLogin'>,
): PullRequestHeadIdentity
{
  const repositoryNameWithOwner = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  )
  return {
    repositoryNameWithOwner,
    ownerLogin:
      normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
      parseRepositoryOwnerLogin(repositoryNameWithOwner),
  }
}

export function resolvePullRequestHeadIdentity(pr: PullRequestInfo): PullRequestHeadIdentity
{
  const repositoryNameWithOwner = normalizeOptionalRepositoryNameWithOwner(
    resolveHeadRepositoryNameWithOwner(pr),
  )
  return {
    repositoryNameWithOwner,
    ownerLogin:
      normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
      parseRepositoryOwnerLogin(repositoryNameWithOwner),
  }
}

export function matchesBranchHeadContext(
  pr: PullRequestInfo,
  headContext: Pick<
    BranchHeadContext,
    'headBranch' | 'headRepositoryNameWithOwner' | 'headRepositoryOwnerLogin' | 'isCrossRepository'
  >,
): boolean
{
  if (pr.headRefName !== headContext.headBranch)
  {
    return false
  }

  const expectedHead = resolveExpectedHeadIdentity(headContext)
  const pullRequestHead = resolvePullRequestHeadIdentity(pr)

  if (expectedHead.repositoryNameWithOwner)
  {
    if (pullRequestHead.repositoryNameWithOwner)
    {
      if (expectedHead.repositoryNameWithOwner !== pullRequestHead.repositoryNameWithOwner)
      {
        return false
      }
    }
    if (expectedHead.ownerLogin && pullRequestHead.ownerLogin)
    {
      if (expectedHead.ownerLogin !== pullRequestHead.ownerLogin)
      {
        return false
      }
    }
  }

  if (expectedHead.ownerLogin && pullRequestHead.ownerLogin)
  {
    if (expectedHead.ownerLogin !== pullRequestHead.ownerLogin)
    {
      return false
    }
  }

  if (headContext.isCrossRepository)
  {
    if (pr.isCrossRepository === false)
    {
      return false
    }
    if (
      (expectedHead.repositoryNameWithOwner || expectedHead.ownerLogin) &&
      !pullRequestHead.repositoryNameWithOwner &&
      !pullRequestHead.ownerLogin
    )
    {
      return false
    }
    return true
  }

  if (pr.isCrossRepository === true)
  {
    if (
      (!expectedHead.repositoryNameWithOwner && !expectedHead.ownerLogin) ||
      (!pullRequestHead.repositoryNameWithOwner && !pullRequestHead.ownerLogin)
    )
    {
      return false
    }
  }

  return true
}

export function toPullRequestInfo(summary: ChangeRequest): PullRequestInfo
{
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? 'open',
    updatedAt: summary.updatedAt,
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  }
}

export function appendUnique(values: string[], next: string | null | undefined): void
{
  const trimmed = next?.trim() ?? ''
  if (trimmed.length === 0 || values.includes(trimmed))
  {
    return
  }
  values.push(trimmed)
}

export function toStatusPr(pr: PullRequestInfo): {
  number: number
  title: string
  url: string
  baseRef: string
  headRef: string
  state: 'open' | 'closed' | 'merged'
}
{
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    state: pr.state,
  }
}

export function normalizePullRequestReference(reference: string): string
{
  const trimmed = reference.trim()
  const hashNumber = /^#(\d+)$/.exec(trimmed)
  return hashNumber?.[1] ?? trimmed
}

export function toResolvedPullRequest(pr: {
  number: number
  title: string
  url: string
  baseRefName: string
  headRefName: string
  state?: 'open' | 'closed' | 'merged'
}): ResolvedPullRequest
{
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state ?? 'open',
  }
}

export function shouldPreferSshRemote(url: string | null): boolean
{
  if (!url) return false
  const trimmed = url.trim()
  return trimmed.startsWith('git@') || trimmed.startsWith('ssh://')
}

export function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean | undefined
  headRepositoryNameWithOwner?: string | null | undefined
  headRepositoryOwnerLogin?: string | null | undefined
}): PullRequestHeadRemoteInfo
{
  return {
    ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    ...(pr.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner }
      : {}),
    ...(pr.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: pr.headRepositoryOwnerLogin }
      : {}),
  }
}
