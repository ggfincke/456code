// apps/web/src/state/environmentHttp.ts
// prepares authenticated environment http fetches
import type { PreparedConnection } from '@t3tools/client-runtime/connection'
import { ManagedRelay } from '@t3tools/client-runtime/relay'
import { buildEnvironmentAuthHeaders } from '@t3tools/client-runtime/state/environment-http-auth'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { HttpMethod } from 'effect/unstable/http'
import { useMemo } from 'react'

import { runtime } from '~/lib/runtime'

import { usePreparedConnection } from './session'

export interface EnvironmentHttpFetchOptions
{
  readonly fetch?: typeof globalThis.fetch
  readonly signer?: Option.Option<ManagedRelay.ManagedRelayDpopSigner['Service']>
}

export function makeEnvironmentHttpFetch(
  prepared: PreparedConnection,
  options: EnvironmentHttpFetchOptions = {},
): typeof globalThis.fetch
{
  const fetch = options.fetch ?? globalThis.fetch
  const environmentOrigin = new URL(prepared.httpBaseUrl).origin
  return async (input, init) =>
  {
    const request = new Request(input, init)
    if (new URL(request.url).origin !== environmentOrigin)
    {
      throw new Error('Environment HTTP requests must target the prepared environment origin.')
    }
    const signer =
      options.signer ??
      (await runtime.runPromise(Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner)))
    const authorization = await Effect.runPromise(
      buildEnvironmentAuthHeaders(
        prepared.httpAuthorization,
        request.method as HttpMethod.HttpMethod,
        request.url,
        signer,
      ),
    )
    const headers = new Headers(request.headers)
    if (authorization.authorization !== undefined)
    {
      headers.set('authorization', authorization.authorization)
    }
    if (authorization.dpop !== undefined)
    {
      headers.set('dpop', authorization.dpop)
    }
    return fetch(
      new Request(request, {
        credentials: prepared.httpAuthorization === null ? 'include' : 'omit',
        headers,
      }),
    )
  }
}

export function useEnvironmentHttpFetch(
  environmentId: PreparedConnection['environmentId'] | null,
): typeof globalThis.fetch | null
{
  const prepared = usePreparedConnection(environmentId)
  return useMemo(
    () => (Option.isSome(prepared) ? makeEnvironmentHttpFetch(prepared.value) : null),
    [prepared],
  )
}
