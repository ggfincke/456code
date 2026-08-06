// apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts
// handle desktop authentication

import { bootstrapRemoteBearerSession } from '@t3tools/client-runtime/authorization'
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as HttpClient from 'effect/unstable/http/HttpClient'

import * as DesktopBackendPool from './DesktopBackendPool.ts'
import type { DesktopBackendStartConfig } from './DesktopBackendManager.ts'

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  'DesktopLocalEnvironmentAuthBackendNotConfiguredError',
  {},
)
{
  override get message(): string
  {
    return 'Local backend is not configured.'
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  'DesktopLocalEnvironmentAuthSessionBootstrapError',
  { cause: Schema.Defect() },
)
{
  override get message(): string
  {
    return 'Failed to create the local desktop bearer session.'
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
])
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>
  }
>()('@t3tools/desktop/backend/DesktopLocalEnvironmentAuth')
{}

interface CachedDesktopBearerToken
{
  readonly configIdentity: string
  readonly token: string
  readonly refreshAtEpochMs: number
}

const BEARER_REFRESH_SKEW_MS = 5_000

function configIdentity(config: DesktopBackendStartConfig): string
{
  return `${config.httpBaseUrl.href}|${config.bootstrap.desktopBootstrapToken ?? ''}`
}

export const make = Effect.gen(function* ()
{
  const pool = yield* DesktopBackendPool.DesktopBackendPool
  const httpClient = yield* HttpClient.HttpClient
  const tokenRef = yield* Ref.make(Option.none<CachedDesktopBearerToken>())
  const mutex = yield* Semaphore.make(1)

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* ()
      {
        const instances = yield* pool.list
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID)
        const configOption = primary === undefined ? Option.none() : yield* primary.currentConfig
        if (Option.isNone(configOption))
        {
          yield* Ref.set(tokenRef, Option.none())
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError()
        }
        const config = configOption.value
        const credential = config.bootstrap.desktopBootstrapToken
        if (!credential)
        {
          yield* Ref.set(tokenRef, Option.none())
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError()
        }
        const identity = configIdentity(config)
        const nowEpochMs = yield* Clock.currentTimeMillis
        const cached = yield* Ref.get(tokenRef)
        if (
          Option.isSome(cached) &&
          cached.value.configIdentity === identity &&
          nowEpochMs < cached.value.refreshAtEpochMs
        )
        {
          return cached.value.token
        }

        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: config.httpBaseUrl.href,
          credential,
          clientMetadata: {
            label: '456code Desktop',
            deviceType: 'desktop',
          },
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        )
        const latestConfig = primary === undefined ? Option.none() : yield* primary.currentConfig
        if (Option.isNone(latestConfig) || configIdentity(latestConfig.value) !== identity)
        {
          yield* Ref.set(tokenRef, Option.none())
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError()
        }
        yield* Ref.set(
          tokenRef,
          Option.some({
            configIdentity: identity,
            token: session.access_token,
            refreshAtEpochMs: Math.max(
              nowEpochMs,
              nowEpochMs + Math.max(0, session.expires_in * 1_000) - BEARER_REFRESH_SKEW_MS,
            ),
          }),
        )
        return session.access_token
      }),
    )
    .pipe(Effect.withSpan('desktop.localEnvironmentAuth.getBearerToken'))

  return DesktopLocalEnvironmentAuth.of({ getBearerToken })
})

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make)
