// tests/apps/server/sourceControl/providerNeutralMapTestHelpers.ts
// shared assertions for provider-neutral change-request mapping tests
import { assert } from '@effect/vitest'
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderKind,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'

export interface ChangeRequestSummaryFixture
{
  readonly number: number
  readonly title: string
  readonly url: string
  readonly baseRefName: string
  readonly headRefName: string
  readonly state: ChangeRequestState
  readonly updatedAt?: ChangeRequest['updatedAt']
  readonly isCrossRepository?: boolean
  readonly headRepositoryNameWithOwner?: string | null
  readonly headRepositoryOwnerLogin?: string | null
}

export function expectedProviderNeutralChangeRequest(
  provider: SourceControlProviderKind,
  summary: ChangeRequestSummaryFixture,
  overrides?: Partial<ChangeRequest>,
): ChangeRequest
{
  return {
    provider,
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.isCrossRepository === undefined
      ? {}
      : { isCrossRepository: summary.isCrossRepository }),
    ...(summary.headRepositoryNameWithOwner === undefined
      ? {}
      : { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }),
    ...(summary.headRepositoryOwnerLogin === undefined
      ? {}
      : { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }),
    ...overrides,
  }
}

export function assertProviderNeutralChangeRequest(
  actual: ChangeRequest,
  provider: SourceControlProviderKind,
  summary: ChangeRequestSummaryFixture,
  overrides?: Partial<ChangeRequest>,
): void
{
  assert.deepStrictEqual(actual, expectedProviderNeutralChangeRequest(provider, summary, overrides))
}

export const standardCrossRepositorySummary = (
  provider: 'github' | 'gitlab' | 'bitbucket',
): ChangeRequestSummaryFixture =>
{
  const labels = {
    github: {
      title: 'Add GitHub provider',
      url: 'https://github.com/pingdotgg/t3code/pull/42',
    },
    gitlab: {
      title: 'Add GitLab provider',
      url: 'https://gitlab.com/pingdotgg/t3code/-/merge_requests/42',
    },
    bitbucket: {
      title: 'Add Bitbucket provider',
      url: 'https://bitbucket.org/pingdotgg/t3code/pull-requests/42',
    },
  } as const

  return {
    number: 42,
    title: labels[provider].title,
    url: labels[provider].url,
    baseRefName: 'main',
    headRefName: 'feature/source-control',
    state: 'open',
    isCrossRepository: true,
    headRepositoryNameWithOwner: 'fork/t3code',
    headRepositoryOwnerLogin: 'fork',
  }
}

export const standardListChangeRequestsInput = {
  cwd: '/repo',
  headSelector: 'feature/provider',
  state: 'all' as const,
  limit: 10,
}

export function assertForwardsListChangeRequestsInput(listInput: unknown): void
{
  assert.deepStrictEqual(listInput, standardListChangeRequestsInput)
}

export const standardOwnerRefCreateInput = {
  cwd: '/repo',
  baseRefName: 'main',
  headSelector: 'owner:feature/provider',
  bodyFile: '/tmp/body.md',
} as const

export function expectedCreateInputWithParsedOwnerRef(title: string): {
  readonly cwd: string
  readonly baseBranch: string
  readonly headSelector: string
  readonly source: { readonly owner: string; readonly refName: string }
  readonly title: string
  readonly bodyFile: string
}
{
  return {
    cwd: standardOwnerRefCreateInput.cwd,
    baseBranch: standardOwnerRefCreateInput.baseRefName,
    headSelector: standardOwnerRefCreateInput.headSelector,
    source: {
      owner: 'owner',
      refName: 'feature/provider',
    },
    title,
    bodyFile: standardOwnerRefCreateInput.bodyFile,
  }
}
