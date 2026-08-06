// apps/server/src/mcp/McpSessionRegistry.ts
// issues and revokes provider-bound mcp credentials
import { ProviderInstanceId, ThreadId, type TurnId } from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SynchronizedRef from 'effect/SynchronizedRef'
import { HttpServer } from 'effect/unstable/http'

import * as ServerEnvironment from '../environment/ServerEnvironment.ts'
import * as McpInvocationContext from './McpInvocationContext.ts'
import * as McpProviderSession from './McpProviderSession.ts'

export interface McpCredentialRequest
{
  readonly threadId: ThreadId
  readonly providerInstanceId: ProviderInstanceId
}

export interface McpIssuedCredential
{
  readonly config: McpProviderSession.McpProviderSessionConfig
}

export interface McpSessionRegistryShape
{
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>
  // records provider activity so a live thread keeps its credential
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>
  readonly bindActiveTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void>
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>
  readonly revokeAll: Effect.Effect<void>
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()('456code/mcp/McpSessionRegistry')
{}

interface CredentialRecord
{
  readonly tokenHash: string
  readonly scope: McpInvocationContext.McpInvocationScope
  readonly lastAliveAt: number
}

interface RegistryState
{
  readonly records: ReadonlyMap<string, CredentialRecord>
}

export interface McpSessionRegistryOptions
{
  readonly livenessWindowMs?: number
  readonly now?: () => number
}

// bounds credentials whose provider session died without a clean stop
// live sessions refresh this through provider turns and mcp traffic
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

const getHttpMcpEndpointHost = (hostname: string): string =>
{
  const normalized = hostname.toLowerCase()
  const endpointHostname =
    normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]'
      ? '127.0.0.1'
      : hostname
  return endpointHostname.includes(':') && !endpointHostname.startsWith('[')
    ? `[${endpointHostname}]`
    : endpointHostname
}

const makeWithOptions = Effect.fn('McpSessionRegistry.make')(function* (
  options: McpSessionRegistryOptions = {},
)
{
  const crypto = yield* Crypto.Crypto
  const environment = yield* ServerEnvironment.ServerEnvironment
  const environmentId = yield* environment.getEnvironmentId
  const httpServer = yield* HttpServer.HttpServer
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() })
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS
  const endpoint =
    httpServer.address._tag === 'TcpAddress'
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : 'http://127.0.0.1/mcp'

  const hashToken = (token: string) =>
    crypto
      .digest('SHA-256', new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie)

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) =>
  {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    )
    return next.size === records.size ? records : next
  }

  const issue: McpSessionRegistryShape['issue'] = Effect.fn('McpSessionRegistry.issue')(
    function* (request)
    {
      const issuedAt = yield* currentTimeMillis
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie)
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie)
      const tokenHash = yield* hashToken(rawToken)
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities: new Set(['preview', 'proposal', 'orchestrate']),
        issuedAt,
      }
      yield* SynchronizedRef.update(state, ({ records }) =>
      {
        const current = pruneDead(records, issuedAt)
        const next = new Map(
          Array.from(current).filter(([, record]) => record.scope.threadId !== scope.threadId),
        )
        next.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt })
        return { records: next }
      })
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
        },
      }
    },
  )

  const resolve: McpSessionRegistryShape['resolve'] = Effect.fn('McpSessionRegistry.resolve')(
    function* (rawToken)
    {
      if (rawToken.length === 0) return undefined
      const tokenHash = yield* hashToken(rawToken)
      const timestamp = yield* currentTimeMillis
      return yield* SynchronizedRef.modify(state, ({ records }) =>
      {
        const current = pruneDead(records, timestamp)
        const record = current.get(tokenHash)
        if (!record) return [undefined, { records: current }] as const
        const next = new Map(current)
        next.set(tokenHash, { ...record, lastAliveAt: timestamp })
        return [record.scope, { records: next }] as const
      })
    },
  )

  const touch: McpSessionRegistryShape['touch'] = Effect.fn('McpSessionRegistry.touch')(
    function* (threadId)
    {
      const timestamp = yield* currentTimeMillis
      yield* SynchronizedRef.update(state, ({ records }) =>
      {
        const current = pruneDead(records, timestamp)
        const next = new Map(current)
        for (const [tokenHash, record] of current)
        {
          if (record.scope.threadId === threadId)
          {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp })
          }
        }
        return { records: next }
      })
    },
  )

  const bindActiveTurn: McpSessionRegistryShape['bindActiveTurn'] = Effect.fn(
    'McpSessionRegistry.bindActiveTurn',
  )(function* (threadId, turnId)
  {
    yield* SynchronizedRef.update(state, ({ records }) =>
    {
      const next = new Map(records)
      for (const [tokenHash, record] of records)
      {
        if (record.scope.threadId !== threadId)
        {
          continue
        }
        const { activeTurnId: _activeTurnId, ...scope } = record.scope
        next.set(tokenHash, {
          ...record,
          scope: turnId === undefined ? scope : { ...scope, activeTurnId: turnId },
        })
      }
      return { records: next }
    })
  })

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }))

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    bindActiveTurn,
    revokeProviderSession: Effect.fn('McpSessionRegistry.revokeProviderSession')(
      function* (providerSessionId)
      {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId)
      },
    ),
    revokeThread: Effect.fn('McpSessionRegistry.revokeThread')(function* (threadId)
    {
      yield* revokeWhere((record) => record.scope.threadId === threadId)
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  })
})

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() =>
      {
        activeMcpSessionRegistry = registry
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() =>
    {
      if (activeMcpSessionRegistry === registry)
      {
        activeMcpSessionRegistry = undefined
      }
    }),
)

export const layer = Layer.effect(McpSessionRegistry, make)

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.issue(request)
    : Effect.succeed<McpIssuedCredential | undefined>(undefined)

// refreshes the thread credential from provider activity
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void

export const bindActiveMcpTurn = (threadId: ThreadId, turnId?: TurnId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.bindActiveTurn(threadId, turnId) : Effect.void

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void

// exposed for tests.
export const __testing = {
  make: makeWithOptions,
}
