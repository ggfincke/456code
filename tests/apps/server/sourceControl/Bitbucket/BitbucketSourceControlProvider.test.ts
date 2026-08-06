// tests/apps/server/sourceControl/Bitbucket/BitbucketSourceControlProvider.test.ts
// verifies the Bitbucket source control provider
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import * as BitbucketApi from '../../../../../apps/server/src/sourceControl/Bitbucket/BitbucketApi.ts'
import * as BitbucketSourceControlProvider from '../../../../../apps/server/src/sourceControl/Bitbucket/BitbucketSourceControlProvider.ts'
import {
  assertForwardsListChangeRequestsInput,
  assertProviderNeutralChangeRequest,
  expectedCreateInputWithParsedOwnerRef,
  standardCrossRepositorySummary,
  standardListChangeRequestsInput,
  standardOwnerRefCreateInput,
} from '../providerNeutralMapTestHelpers.ts'

function makeProvider(bitbucket: Partial<BitbucketApi.BitbucketApi['Service']>)
{
  return BitbucketSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(BitbucketApi.BitbucketApi)(bitbucket)),
  )
}

it.effect('maps Bitbucket PR summaries into provider-neutral change requests', () =>
  Effect.gen(function* ()
  {
    const summary = {
      ...standardCrossRepositorySummary('bitbucket'),
      updatedAt: Option.none(),
    }
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.succeed(summary),
    })

    const changeRequest = yield* provider.getChangeRequest({
      cwd: '/repo',
      reference: '42',
    })

    assertProviderNeutralChangeRequest(changeRequest, 'bitbucket', summary)
  }),
)

it.effect('adds repository context while retaining Bitbucket API causes', () =>
  Effect.gen(function* ()
  {
    const upstreamCause = new Error('raw upstream failure')
    const cause = new BitbucketApi.BitbucketRequestError({
      operation: 'getRepository',
      cause: upstreamCause,
    })
    const provider = yield* makeProvider({
      getRepositoryCloneUrls: () => Effect.fail(cause),
    })

    const error = yield* provider
      .getRepositoryCloneUrls({ cwd: '/repo', repository: 'owner/repo' })
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
        provider: 'bitbucket',
        operation: 'getRepositoryCloneUrls',
        command: undefined,
        cwd: '/repo',
        repository: 'owner/repo',
        detail: 'Failed to get repository clone URLs.',
      },
    )
    assert.strictEqual(error.cause, cause)
    assert.equal(error.message.includes(upstreamCause.message), false)
  }),
)

it.effect('lists Bitbucket PRs through provider-neutral input names', () =>
  Effect.gen(function* ()
  {
    let listInput: Parameters<BitbucketApi.BitbucketApi['Service']['listPullRequests']>[0] | null =
      null
    const provider = yield* makeProvider({
      listPullRequests: (input) =>
      {
        listInput = input
        return Effect.succeed([])
      },
    })

    yield* provider.listChangeRequests(standardListChangeRequestsInput)

    assertForwardsListChangeRequestsInput(listInput)
  }),
)

it.effect('creates Bitbucket PRs through provider-neutral input names', () =>
  Effect.gen(function* ()
  {
    let createInput:
      Parameters<BitbucketApi.BitbucketApi['Service']['createPullRequest']>[0] | null = null
    const provider = yield* makeProvider({
      createPullRequest: (input) =>
      {
        createInput = input
        return Effect.void
      },
    })

    yield* provider.createChangeRequest({
      ...standardOwnerRefCreateInput,
      title: 'Provider PR',
    })

    assert.deepStrictEqual(createInput, expectedCreateInputWithParsedOwnerRef('Provider PR'))
  }),
)
