// apps/server/src/sourceControl/SourceControlProviderRegistry.ts
// resolves source control providers by kind and repository discovery
import * as Cache from 'effect/Cache'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from '@t3tools/contracts'
import type { SourceControlProviderKind } from '@t3tools/contracts'
import { detectSourceControlProviderFromRemoteUrl } from '@t3tools/shared/sourceControl'

import * as AzureDevOpsSourceControlProvider from './AzureDevOps/AzureDevOpsSourceControlProvider.ts'
import * as BitbucketSourceControlProvider from './Bitbucket/BitbucketSourceControlProvider.ts'
import * as GitHubSourceControlProvider from './GitHub/GitHubSourceControlProvider.ts'
import * as GitLabSourceControlProvider from './GitLab/GitLabSourceControlProvider.ts'
import * as SourceControlProvider from './SourceControlProvider.ts'
import * as SourceControlRateLimit from './SourceControlRateLimit.ts'
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
  type SourceControlProviderDiscoverySpec,
} from './SourceControlProviderDiscovery.ts'
import { ServerConfig } from '../config.ts'
import * as VcsDriverRegistry from '../vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../vcs/VcsProcess.ts'

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5)

export interface SourceControlProviderRegistration
{
  readonly kind: SourceControlProviderKind
  readonly provider: SourceControlProvider.SourceControlProvider['Service']
  readonly discovery: SourceControlProviderDiscoverySpec
}

export interface SourceControlProviderHandle
{
  readonly provider: SourceControlProvider.SourceControlProvider['Service']
  readonly context: SourceControlProvider.SourceControlProviderContext | null
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  {
    readonly get: (
      kind: SourceControlProviderKind,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider['Service'],
      SourceControlProviderError
    >
    readonly resolveHandle: (input: {
      readonly cwd: string
    }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>
    readonly resolve: (input: {
      readonly cwd: string
    }) => Effect.Effect<
      SourceControlProvider.SourceControlProvider['Service'],
      SourceControlProviderError
    >
    readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>
  }
>()('456code/sourceControl/SourceControlProviderRegistry')
{}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProvider['Service']
{
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: 'listChangeRequests',
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    getChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: 'getChangeRequest',
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: 'createChangeRequest',
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.headSelector),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getRepositoryCloneUrls: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: 'getRepositoryCloneUrls',
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: 'createRepository',
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getDefaultBranch: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: 'getDefaultBranch',
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    checkoutChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: 'checkoutChangeRequest',
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
  })
}

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string
    readonly url: string
  }>,
): SourceControlProvider.SourceControlProviderContext | null
{
  const candidates: Array<SourceControlProvider.SourceControlProviderContext> = []
  for (const remote of remotes)
  {
    const provider = detectSourceControlProviderFromRemoteUrl(remote.url)
    if (provider)
    {
      candidates.push({
        provider,
        remoteName: remote.name,
        remoteUrl: remote.url,
      })
    }
  }

  return (
    candidates.find((candidate) => candidate.remoteName === 'origin') ??
    candidates.find((candidate) => candidate.provider.kind !== 'unknown') ??
    candidates[0] ??
    null
  )
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProvider['Service'],
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProvider['Service']
{
  if (context === null)
  {
    return provider
  }

  return SourceControlProvider.SourceControlProvider.of({
    kind: provider.kind,
    listChangeRequests: (input) =>
      provider.listChangeRequests({
        ...input,
        context: input.context ?? context,
      }),
    getChangeRequest: (input) =>
      provider.getChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    createChangeRequest: (input) =>
      provider.createChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    getRepositoryCloneUrls: (input) =>
      provider.getRepositoryCloneUrls({
        ...input,
        context: input.context ?? context,
      }),
    createRepository: (input) => provider.createRepository(input),
    getDefaultBranch: (input) =>
      provider.getDefaultBranch({
        ...input,
        context: input.context ?? context,
      }),
    checkoutChangeRequest: (input) =>
      provider.checkoutChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
  })
}

interface ProviderRateLimitInfo
{
  readonly retryAt?: number | undefined
}

function providerRateLimitInfo(
  error: unknown,
  depth = 0,
  seen = new Set<object>(),
): ProviderRateLimitInfo | null
{
  if (depth > 8 || typeof error !== 'object' || error === null || seen.has(error)) return null
  seen.add(error)
  const value = error as Record<string, unknown>
  if (value._tag === 'VcsProcessExitError' && value.failureKind === 'rate-limited') return {}
  if (value._tag === 'BitbucketResponseError' && value.status === 429)
  {
    return typeof value.retryAt === 'number' ? { retryAt: value.retryAt } : {}
  }
  return providerRateLimitInfo(value.cause, depth + 1, seen)
}

const defaultProviderHost = (kind: SourceControlProviderKind): string =>
{
  switch (kind)
  {
    case 'github':
      return 'github.com'
    case 'gitlab':
      return 'gitlab.com'
    case 'azure-devops':
      return 'dev.azure.com'
    case 'bitbucket':
      return 'bitbucket.org'
    case 'unknown':
      return 'unknown'
  }
}

function providerHost(
  kind: SourceControlProviderKind,
  context: SourceControlProvider.SourceControlProviderContext | null,
): string
{
  try
  {
    return context ? new URL(context.provider.baseUrl).host : defaultProviderHost(kind)
  }
  catch
  {
    return defaultProviderHost(kind)
  }
}

function bindProviderRateLimit(
  provider: SourceControlProvider.SourceControlProvider['Service'],
  context: SourceControlProvider.SourceControlProviderContext | null,
  limits: SourceControlRateLimit.SourceControlRateLimit['Service'],
): SourceControlProvider.SourceControlProvider['Service']
{
  const key = { provider: provider.kind, host: providerHost(provider.kind, context) }
  const run = <A>(input: {
    readonly operation: string
    readonly cwd: string
    readonly allowPaused: boolean
    readonly effect: Effect.Effect<A, SourceControlProviderError>
  }): Effect.Effect<A, SourceControlProviderError> =>
    Effect.gen(function* ()
    {
      const lease = yield* limits.check(key, { allowPaused: input.allowPaused }).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: provider.kind,
              operation: input.operation,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      )
      return yield* input.effect.pipe(
        Effect.tap(() => limits.recordSuccess({ ...key, lease })),
        Effect.tapError((error) =>
        {
          const rateLimit = providerRateLimitInfo(error)
          return rateLimit === null
            ? Effect.void
            : limits.recordRateLimit({ ...key, lease, ...rateLimit })
        }),
      )
    })

  return SourceControlProvider.SourceControlProvider.of({
    kind: provider.kind,
    listChangeRequests: (input) =>
      run({
        operation: 'listChangeRequests',
        cwd: input.cwd,
        allowPaused: false,
        effect: provider.listChangeRequests(input),
      }),
    getChangeRequest: (input) =>
      run({
        operation: 'getChangeRequest',
        cwd: input.cwd,
        allowPaused: false,
        effect: provider.getChangeRequest(input),
      }),
    createChangeRequest: (input) =>
      run({
        operation: 'createChangeRequest',
        cwd: input.cwd,
        allowPaused: true,
        effect: provider.createChangeRequest(input),
      }),
    getRepositoryCloneUrls: (input) =>
      run({
        operation: 'getRepositoryCloneUrls',
        cwd: input.cwd,
        allowPaused: true,
        effect: provider.getRepositoryCloneUrls(input),
      }),
    createRepository: (input) =>
      run({
        operation: 'createRepository',
        cwd: input.cwd,
        allowPaused: true,
        effect: provider.createRepository(input),
      }),
    getDefaultBranch: (input) =>
      run({
        operation: 'getDefaultBranch',
        cwd: input.cwd,
        allowPaused: false,
        effect: provider.getDefaultBranch(input),
      }),
    checkoutChangeRequest: (input) =>
      run({
        operation: 'checkoutChangeRequest',
        cwd: input.cwd,
        allowPaused: true,
        effect: provider.checkoutChangeRequest(input),
      }),
  })
}

export const makeWithProviders = Effect.fn('makeSourceControlProviderRegistryWithProviders')(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>)
  {
    const config = yield* ServerConfig
    const process = yield* VcsProcess.VcsProcess
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry
    const limits = yield* SourceControlRateLimit.make
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProvider['Service']
    >(registrations.map((registration) => [registration.kind, registration.provider]))
    const discoverySpecs = registrations.map((registration) => registration.discovery)

    const get: SourceControlProviderRegistry['Service']['get'] = (kind) =>
      Effect.succeed(
        bindProviderRateLimit(providers.get(kind) ?? unsupportedProvider(kind), null, limits),
      )

    const detectProviderContext = Effect.fn('SourceControlProviderRegistry.detectProviderContext')(
      function* (cwd: string)
      {
        const handle = yield* vcsRegistry.resolve({ cwd }).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: 'unknown',
                operation: 'detectProvider',
                cwd,
                detail: 'Failed to detect source control provider.',
                cause: error,
              }),
          ),
        )
        const remotes = yield* handle.driver.listRemotes(cwd).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: 'unknown',
                operation: 'detectProvider',
                cwd,
                detail: 'Failed to detect source control provider.',
                cause: error,
              }),
          ),
        )
        const context = selectProviderContext(remotes.remotes)

        return yield* refineUnknownRemoteProvider({
          specs: discoverySpecs,
          process,
          cwd,
          context,
        })
      },
    )

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    })

    const resolveHandle: SourceControlProviderRegistry['Service']['resolveHandle'] = (input) =>
      Cache.get(providerContextCache, input.cwd).pipe(
        Effect.map((context) =>
        {
          const kind = context?.provider.kind ?? 'unknown'
          const provider = providers.get(kind) ?? unsupportedProvider(kind)
          const contextualProvider = bindProviderContext(provider, context)
          return {
            provider: bindProviderRateLimit(contextualProvider, context, limits),
            context,
          } satisfies SourceControlProviderHandle
        }),
      )

    return SourceControlProviderRegistry.of({
      get,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
      discover: Effect.all(
        discoverySpecs.map((spec) =>
          probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
          }),
        ),
        { concurrency: 'unbounded' },
      ),
    })
  },
)

export const make = Effect.gen(function* ()
{
  const github = yield* GitHubSourceControlProvider.make
  const gitlab = yield* GitLabSourceControlProvider.make
  const bitbucket = yield* BitbucketSourceControlProvider.make
  const bitbucketDiscovery = yield* BitbucketSourceControlProvider.makeDiscovery
  const azureDevOps = yield* AzureDevOpsSourceControlProvider.make
  return yield* makeWithProviders([
    {
      kind: 'github',
      provider: github,
      discovery: GitHubSourceControlProvider.discovery,
    },
    {
      kind: 'gitlab',
      provider: gitlab,
      discovery: GitLabSourceControlProvider.discovery,
    },
    {
      kind: 'azure-devops',
      provider: azureDevOps,
      discovery: AzureDevOpsSourceControlProvider.discovery,
    },
    {
      kind: 'bitbucket',
      provider: bitbucket,
      discovery: bitbucketDiscovery,
    },
  ])
})

export const layer = Layer.effect(SourceControlProviderRegistry, make)
