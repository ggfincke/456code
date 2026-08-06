// tests/apps/server/sourceControl/SourceControlProviderRegistry.test.ts
// verifies source control provider registration and lookup
import { assert, it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { VcsRepositoryDetectionError } from '@t3tools/contracts'

import * as ServerConfig from '../../../../apps/server/src/config.ts'
import type * as VcsDriver from '../../../../apps/server/src/vcs/VcsDriver.ts'
import * as VcsDriverRegistry from '../../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../../../../apps/server/src/vcs/VcsProcess.ts'
import * as AzureDevOpsCli from '../../../../apps/server/src/sourceControl/AzureDevOps/AzureDevOpsCli.ts'
import * as BitbucketApi from '../../../../apps/server/src/sourceControl/Bitbucket/BitbucketApi.ts'
import * as GitHubCli from '../../../../apps/server/src/sourceControl/GitHub/GitHubCli.ts'
import * as GitLabCli from '../../../../apps/server/src/sourceControl/GitLab/GitLabCli.ts'
import * as SourceControlProviderRegistry from '../../../../apps/server/src/sourceControl/SourceControlProviderRegistry.ts'

const TEST_EPOCH = DateTime.makeUnsafe('1970-01-01T00:00:00.000Z')

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string
    readonly exitCode?: ChildProcessSpawner.ExitCode
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? '',
  stdoutTruncated: false,
  stderrTruncated: false,
})

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string
    readonly url: string
  }>
  readonly process?: Partial<VcsProcess.VcsProcess['Service']>
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry['Service']['resolve']
})
{
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === 'origin',
        })),
        freshness: {
          source: 'live-local' as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver['Service']>

  const registryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriver.VcsDriver['Service']),
    resolve:
      input.resolve ??
      (() =>
        Effect.succeed({
          kind: 'git',
          repository: {
            kind: 'git',
            rootPath: '/repo',
            metadataPath: null,
            freshness: {
              source: 'live-local' as const,
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: driver as unknown as VcsDriver.VcsDriver['Service'],
        })),
  })

  const processLayer = Layer.mock(VcsProcess.VcsProcess)({
    run: () => Effect.succeed(processOutput('')),
    ...input.process,
  })

  return SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        registryLayer,
        processLayer,
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)({}),
        Layer.mock(GitHubCli.GitHubCli)({}),
        Layer.mock(GitLabCli.GitLabCli)({}),
        ServerConfig.layerTest(process.cwd(), {
          prefix: 't3-source-control-registry-test-',
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  )
}

it.effect.each([
  {
    name: 'GitHub',
    url: 'git@github.com:pingdotgg/t3code.git',
    kind: 'github' as const,
  },
  {
    name: 'GitLab',
    url: 'git@gitlab.com:group/project.git',
    kind: 'gitlab' as const,
  },
  {
    name: 'Bitbucket',
    url: 'git@bitbucket.org:pingdotgg/t3code.git',
    kind: 'bitbucket' as const,
  },
  {
    name: 'Azure DevOps',
    url: 'https://dev.azure.com/acme/project/_git/repo',
    kind: 'azure-devops' as const,
  },
])('routes $name remotes to the $name provider', ({ url, kind }) =>
  Effect.gen(function* ()
  {
    const registry = yield* makeRegistry({
      remotes: [{ name: 'origin', url }],
    })

    const provider = yield* registry.resolve({ cwd: '/repo' })

    assert.strictEqual(provider.kind, kind)
  }),
)

it.effect('routes directly by provider kind for remote-first workflows', () =>
  Effect.gen(function* ()
  {
    const registry = yield* makeRegistry({
      remotes: [],
    })

    const provider = yield* registry.get('github')

    assert.strictEqual(provider.kind, 'github')
  }),
)

it.effect('includes the request cwd when an unregistered provider is used', () =>
  Effect.gen(function* ()
  {
    const registry = yield* makeRegistry({ remotes: [] })
    const provider = yield* registry.get('unknown')

    const error = yield* provider
      .getChangeRequest({ cwd: '/repo', reference: '#42' })
      .pipe(Effect.flip)

    assert.strictEqual(error.provider, 'unknown')
    assert.strictEqual(error.operation, 'getChangeRequest')
    assert.strictEqual(error.cwd, '/repo')
    assert.strictEqual(error.reference, '#42')
  }),
)

it.effect('retains VCS detection failures with structured cwd context', () =>
  Effect.gen(function* ()
  {
    const cause = new VcsRepositoryDetectionError({
      operation: 'resolve',
      cwd: '/repo',
      detail: 'raw VCS detection failure',
      cause: new Error('raw nested failure'),
    })
    const registry = yield* makeRegistry({
      remotes: [],
      resolve: () => Effect.fail(cause),
    })

    const error = yield* registry.resolve({ cwd: '/repo' }).pipe(Effect.flip)

    assert.strictEqual(error.provider, 'unknown')
    assert.strictEqual(error.operation, 'detectProvider')
    assert.strictEqual(error.cwd, '/repo')
    assert.strictEqual(error.detail, 'Failed to detect source control provider.')
    assert.strictEqual(error.cause, cause)
    assert.equal(error.message.includes(cause.message), false)
  }),
)

it.effect('routes authenticated self-hosted GitLab remotes without relying on host naming', () =>
  Effect.gen(function* ()
  {
    const registry = yield* makeRegistry({
      remotes: [
        {
          name: 'origin',
          url: 'https://self-hosted.example.test/group/project.git',
        },
      ],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(
              `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
              { exitCode: ChildProcessSpawner.ExitCode(1) },
            ),
          ),
      },
    })

    const provider = yield* registry.resolve({ cwd: '/repo' })

    assert.strictEqual(provider.kind, 'gitlab')
  }),
)

it.effect('routes authenticated self-hosted GitLab remotes on non-standard ports', () =>
  Effect.gen(function* ()
  {
    const registry = yield* makeRegistry({
      remotes: [
        {
          name: 'origin',
          url: 'https://self-hosted.example.test:8443/group/project.git',
        },
      ],
      process: {
        run: () =>
          Effect.succeed(
            processOutput(
              `self-hosted.example.test:8443
  ✓ Logged in to self-hosted.example.test:8443 as gitlab-user
  ✓ Token found: ******
`,
            ),
          ),
      },
    })

    const provider = yield* registry.resolve({ cwd: '/repo' })

    assert.strictEqual(provider.kind, 'gitlab')
  }),
)

it.effect('falls back to a non-origin remote when origin is not configured', () =>
  Effect.gen(function* ()
  {
    const registry = yield* makeRegistry({
      remotes: [
        {
          name: 'upstream',
          url: 'https://dev.azure.com/acme/project/_git/repo',
        },
      ],
    })

    const provider = yield* registry.resolve({ cwd: '/repo' })

    assert.strictEqual(provider.kind, 'azure-devops')
  }),
)
