// tests/apps/server/sourceControl/GitLab/GitLabSourceControlProvider.test.ts
// verifies the GitLab source control provider
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { ChildProcessSpawner } from 'effect/unstable/process'

import * as GitLabCli from '../../../../../apps/server/src/sourceControl/GitLab/GitLabCli.ts'
import { parseGitLabAuthStatusHosts } from '../../../../../apps/server/src/sourceControl/GitLab/gitLabAuthStatus.ts'
import * as GitLabSourceControlProvider from '../../../../../apps/server/src/sourceControl/GitLab/GitLabSourceControlProvider.ts'
import {
  assertForwardsListChangeRequestsInput,
  assertProviderNeutralChangeRequest,
  expectedCreateInputWithParsedOwnerRef,
  standardCrossRepositorySummary,
  standardListChangeRequestsInput,
  standardOwnerRefCreateInput,
} from '../providerNeutralMapTestHelpers.ts'

function makeProvider(gitlab: Partial<GitLabCli.GitLabCli['Service']>)
{
  return GitLabSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(GitLabCli.GitLabCli)(gitlab)),
  )
}

it.effect('maps GitLab MR summaries into provider-neutral change requests', () =>
  Effect.gen(function* ()
  {
    const summary = standardCrossRepositorySummary('gitlab')
    const provider = yield* makeProvider({
      getMergeRequest: () => Effect.succeed(summary),
    })

    const changeRequest = yield* provider.getChangeRequest({
      cwd: '/repo',
      reference: '42',
    })

    assertProviderNeutralChangeRequest(changeRequest, 'gitlab', summary)
  }),
)

it.effect('adds repository context while retaining GitLab CLI causes', () =>
  Effect.gen(function* ()
  {
    const cause = new GitLabCli.GitLabCliCommandError({
      operation: 'execute',
      command: 'glab',
      cwd: '/repo',
      cause: new Error('raw upstream detail that should remain in the cause'),
    })
    const provider = yield* makeProvider({
      createRepository: () => Effect.fail(cause),
    })

    const error = yield* provider
      .createRepository({
        cwd: '/repo',
        repository: 'owner/repo',
        visibility: 'private',
      })
      .pipe(Effect.flip)

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        repository: error.repository,
        detail: error.detail,
      },
      {
        provider: 'gitlab',
        operation: 'createRepository',
        command: 'glab',
        cwd: '/repo',
        repository: 'owner/repo',
        detail: 'GitLab CLI command failed.',
      },
    )
    assert.strictEqual(error.cause, cause)
    assert.equal(error.message.includes('raw upstream detail'), false)
  }),
)

it.effect('lists GitLab MRs through provider-neutral input names', () =>
  Effect.gen(function* ()
  {
    let listInput: Parameters<GitLabCli.GitLabCli['Service']['listMergeRequests']>[0] | null = null
    const provider = yield* makeProvider({
      listMergeRequests: (input) =>
      {
        listInput = input
        return Effect.succeed([])
      },
    })

    yield* provider.listChangeRequests(standardListChangeRequestsInput)

    assertForwardsListChangeRequestsInput(listInput)
  }),
)

it.effect('creates GitLab MRs through provider-neutral input names', () =>
  Effect.gen(function* ()
  {
    let createInput: Parameters<GitLabCli.GitLabCli['Service']['createMergeRequest']>[0] | null =
      null
    const provider = yield* makeProvider({
      createMergeRequest: (input) =>
      {
        createInput = input
        return Effect.void
      },
    })

    yield* provider.createChangeRequest({
      ...standardOwnerRefCreateInput,
      title: 'Provider MR',
    })

    assert.deepStrictEqual(createInput, expectedCreateInputWithParsedOwnerRef('Provider MR'))
  }),
)

it('accepts authenticated GitLab hosts when another configured host fails', () =>
{
  const auth = GitLabSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(1),
    stdout: `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
    stderr: '',
  })

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: 'authenticated',
      account: Option.some('gitlab-user'),
      host: Option.some('self-hosted.example.test'),
    },
  )
})

it('refines unknown GitLab remotes with mixed-case provider hosts', () =>
{
  const provider = GitLabSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: '/repo',
    context: {
      provider: {
        kind: 'unknown',
        name: 'Self-Hosted.Example.Test',
        baseUrl: 'https://Self-Hosted.Example.Test',
      },
      remoteName: 'origin',
      remoteUrl: 'https://Self-Hosted.Example.Test/group/project.git',
    },
    auth: {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: `self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
      stderr: '',
    },
  })

  assert.deepStrictEqual(provider, {
    kind: 'gitlab',
    name: 'GitLab Self-Hosted',
    baseUrl: 'https://Self-Hosted.Example.Test',
  })
})

it('parses authenticated GitLab auth status hosts with ports and single-label names', () =>
{
  assert.deepStrictEqual(
    parseGitLabAuthStatusHosts(`localhost:8080
  ✓ Logged in to localhost:8080 as local-user
selfhosted
  ✓ Logged in to selfhosted as single-label-user
`),
    [
      { host: 'localhost:8080', account: 'local-user' },
      { host: 'selfhosted', account: 'single-label-user' },
    ],
  )
})
