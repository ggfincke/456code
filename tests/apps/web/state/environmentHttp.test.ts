// tests/apps/web/state/environmentHttp.test.ts
// verifies authenticated environment fetch preparation
import type {
  PreparedConnection,
  PreparedHttpAuthorization,
} from '@t3tools/client-runtime/connection'
import { ManagedRelay } from '@t3tools/client-runtime/relay'
import { EnvironmentId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { describe, expect, it, vi } from 'vite-plus/test'

import { makeEnvironmentHttpFetch } from '../../../../apps/web/src/state/environmentHttp'

function prepared(httpAuthorization: PreparedHttpAuthorization | null): PreparedConnection
{
  return {
    environmentId: EnvironmentId.make('environment-http-test'),
    label: 'Environment HTTP test',
    httpBaseUrl: 'https://environment.example',
    socketUrl: 'wss://environment.example/ws',
    httpAuthorization,
    target: {
      _tag: 'PrimaryConnectionTarget',
      environmentId: EnvironmentId.make('environment-http-test'),
      label: 'Environment HTTP test',
      httpBaseUrl: 'https://environment.example',
      wsBaseUrl: 'wss://environment.example',
    },
  }
}

function captureFetch(requests: Request[]): typeof globalThis.fetch
{
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
  {
    requests.push(new Request(input, init))
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch
}

describe('makeEnvironmentHttpFetch', () =>
{
  it('uses cookies locally and prepares Bearer and DPoP requests remotely', async () =>
  {
    const requests: Request[] = []
    const fetch = captureFetch(requests)
    const url = 'https://environment.example/api/architecture/source'

    await makeEnvironmentHttpFetch(prepared(null), { fetch, signer: Option.none() })(url, {
      headers: { Accept: 'application/json' },
    })
    await makeEnvironmentHttpFetch(prepared({ _tag: 'Bearer', token: 'bearer-token' }), {
      fetch,
      signer: Option.none(),
    })(url)

    let proofSequence = 0
    const createProof = vi.fn(() => Effect.succeed(`dpop-proof-${++proofSequence}`))
    const signer = ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed('dpop-thumbprint'),
      createProof,
    })
    const dpopFetch = makeEnvironmentHttpFetch(
      prepared({ _tag: 'Dpop', accessToken: 'dpop-access-token' }),
      { fetch, signer: Option.some(signer) },
    )
    await dpopFetch(url)
    await dpopFetch(url)

    expect(requests[0]?.credentials).toBe('include')
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    expect(requests[0]?.headers.get('accept')).toBe('application/json')
    expect(requests[1]?.credentials).toBe('omit')
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer bearer-token')
    expect(requests[2]?.credentials).toBe('omit')
    expect(requests[2]?.headers.get('authorization')).toBe('DPoP dpop-access-token')
    expect(requests[2]?.headers.get('dpop')).toBe('dpop-proof-1')
    expect(requests[3]?.headers.get('dpop')).toBe('dpop-proof-2')
    expect(createProof).toHaveBeenCalledTimes(2)
    expect(createProof).toHaveBeenCalledWith({
      method: 'GET',
      url,
      accessToken: 'dpop-access-token',
    })
  })

  it('preserves aborts and rejects a different origin before attaching credentials', async () =>
  {
    const requests: Request[] = []
    const fetch = captureFetch(requests)
    const controller = new AbortController()
    controller.abort()
    const environmentFetch = makeEnvironmentHttpFetch(
      prepared({ _tag: 'Bearer', token: 'bearer-token' }),
      { fetch, signer: Option.none() },
    )

    await environmentFetch('https://environment.example/api/test', {
      signal: controller.signal,
    })
    expect(requests[0]?.signal.aborted).toBe(true)
    await expect(environmentFetch('https://other.example/api/test')).rejects.toThrow(
      'Environment HTTP requests must target the prepared environment origin.',
    )
    expect(requests).toHaveLength(1)
  })
})
