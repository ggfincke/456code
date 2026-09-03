// tests/apps/server/auth/http.test.ts
// verify storage-owner and bearer environment HTTP authentication

// @effect-diagnostics nodeBuiltinImport:off - test lease metadata uses the platform path boundary.

import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationRecoverScope,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  AuthRelayWriteScope,
  AuthSessionId,
  EnvironmentId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentStorageOwnerTokenHeaderName,
} from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'

import * as EnvironmentAuth from '../../../../apps/server/src/auth/EnvironmentAuth.ts'
import {
  environmentAuthenticatedAuthLayer,
  requirePairingDelegatedScopes,
  requirePairingIssuer,
} from '../../../../apps/server/src/auth/http.ts'
import * as ServerSecretStore from '../../../../apps/server/src/auth/ServerSecretStore.ts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as ServerEnvironment from '../../../../apps/server/src/environment/ServerEnvironment.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as ServerStorageLease from '../../../../apps/server/src/serverStorageLease.ts'

const STORAGE_OWNER_TOKEN = 'storage-owner-token'
const isPairingDelegationError = Schema.is(
  Schema.Union([EnvironmentScopeRequiredError, EnvironmentRequestInvalidError]),
)

const makeEnvironmentAuthLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make('environment-http-auth-test')),
        getDescriptor: Effect.die(new Error('unused in environment HTTP auth tests')),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: 't3-http-auth-test-' })),
  )

const makeStorageOwnerLease = (): ServerStorageLease.ServerStorageLease['Service'] => ({
  canonicalBaseDir: process.cwd(),
  lockPath: NodePath.join(process.cwd(), ServerStorageLease.SERVER_STORAGE_LEASE_FILE),
  mutexPath: NodePath.join(process.cwd(), ServerStorageLease.SERVER_STORAGE_LEASE_MUTEX_FILE),
  owner: {
    version: 1,
    token: STORAGE_OWNER_TOKEN,
    pid: process.pid,
    hostname: 'http-auth-test',
    acquiredAt: '2026-08-09T00:00:00.000Z',
    processStartedAt: '2026-08-09T00:00:00.000Z',
    canonicalBaseDir: process.cwd(),
  },
})

const makeHttpAuthLayer = () =>
{
  const environmentAuthLayer = makeEnvironmentAuthLayer()
  return Layer.mergeAll(
    environmentAuthLayer,
    environmentAuthenticatedAuthLayer.pipe(Layer.provide(environmentAuthLayer)),
    ServerStorageLease.layer(makeStorageOwnerLease()),
  )
}

const makeRequest = (input: {
  readonly path: string
  readonly method?: 'GET' | 'POST'
  readonly remoteAddress: string
  readonly storageOwnerToken?: string
  readonly authorization?: string
}): HttpServerRequest.HttpServerRequest =>
  ({
    originalUrl: input.path,
    method: input.method ?? 'GET',
    headers: {
      ...(input.storageOwnerToken === undefined
        ? {}
        : { [EnvironmentStorageOwnerTokenHeaderName]: input.storageOwnerToken }),
      ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
    },
    cookies: {},
    source: { socket: { remoteAddress: input.remoteAddress } },
  }) as unknown as HttpServerRequest.HttpServerRequest

const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* ()
  {
    const authenticate = yield* EnvironmentAuthenticatedAuth
    const authenticated = authenticate(EnvironmentAuthenticatedPrincipal as never, {} as never)
    return yield* authenticated as unknown as Effect.Effect<
      EnvironmentAuthenticatedPrincipal['Service'],
      EnvironmentAuthInvalidError | EnvironmentInternalError
    >
  }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))

it.layer(NodeServices.layer)('environment HTTP storage-owner authentication', (it) =>
{
  it.effect('accepts the owner token only on the two loopback project CLI paths', () =>
    Effect.gen(function* ()
    {
      for (const path of ['/api/orchestration/shell', '/api/orchestration/project-commands/v1'])
      {
        const principal = yield* authenticateRequest(
          makeRequest({
            path,
            remoteAddress: '127.0.0.1',
            storageOwnerToken: STORAGE_OWNER_TOKEN,
          }),
        )

        assert.equal(principal.subject, 'server-storage-owner')
        assert.deepStrictEqual(
          [...principal.scopes],
          [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        )
      }
    }).pipe(Effect.provide(makeHttpAuthLayer())),
  )

  it.effect('rejects invalid, remote, and wrong-path owner token attempts', () =>
    Effect.gen(function* ()
    {
      const requests = [
        makeRequest({
          path: '/api/orchestration/shell',
          remoteAddress: '127.0.0.1',
          storageOwnerToken: 'wrong-token',
        }),
        makeRequest({
          path: '/api/orchestration/shell',
          remoteAddress: '203.0.113.10',
          storageOwnerToken: STORAGE_OWNER_TOKEN,
        }),
        makeRequest({
          path: '/api/orchestration/dispatch',
          remoteAddress: '127.0.0.1',
          storageOwnerToken: STORAGE_OWNER_TOKEN,
        }),
      ]

      for (const request of requests)
      {
        const error = yield* authenticateRequest(request).pipe(Effect.flip)
        assert.instanceOf(error, EnvironmentAuthInvalidError)
        assert.equal(error.reason, 'missing_credential')
      }
    }).pipe(Effect.provide(makeHttpAuthLayer())),
  )

  it.effect(
    'issues standard pairing credentials to the verified local owner without admin scope',
    () =>
      Effect.gen(function* ()
      {
        const request = makeRequest({
          path: '/api/auth/pairing-token',
          method: 'POST',
          remoteAddress: '127.0.0.1',
          storageOwnerToken: STORAGE_OWNER_TOKEN,
        })
        const principal = yield* authenticateRequest(request)
        assert.deepStrictEqual([...principal.scopes], [...AuthStandardClientScopes])
        assert.isFalse(principal.scopes.has(AuthAccessWriteScope))
        const issuer = yield* requirePairingIssuer().pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(EnvironmentAuthenticatedPrincipal, principal),
        )
        const scopes = yield* requirePairingDelegatedScopes(issuer, AuthStandardClientScopes)
        const auth = yield* EnvironmentAuth.EnvironmentAuth
        const issued = yield* auth.issuePairingCredential({ scopes, label: 'local pair test' })
        const links = yield* auth.listPairingLinks()
        assert.isTrue(issued.credential.length > 0)
        assert.deepStrictEqual(links.find((link) => link.id === issued.id)?.scopes, scopes)

        for (const scopes of [
          AuthAdministrativeScopes,
          [AuthOrchestrationRecoverScope],
          [AuthRelayWriteScope],
        ] as const)
        {
          const error = yield* requirePairingDelegatedScopes(issuer, scopes).pipe(Effect.flip)
          assert.isTrue(isPairingDelegationError(error))
        }
      }).pipe(Effect.provide(makeHttpAuthLayer())),
  )

  it.effect('rejects remote, wrong-token, and wrong-method pairing owner authority', () =>
    Effect.gen(function* ()
    {
      for (const overrides of [
        { remoteAddress: '203.0.113.10' },
        { storageOwnerToken: 'wrong-token' },
        { method: 'GET' as const },
      ])
      {
        const request = makeRequest({
          path: '/api/auth/pairing-token',
          method: 'POST',
          remoteAddress: '127.0.0.1',
          storageOwnerToken: STORAGE_OWNER_TOKEN,
          ...overrides,
        })
        const error = yield* authenticateRequest(request).pipe(Effect.flip)
        assert.instanceOf(error, EnvironmentAuthInvalidError)
        const forgedIssuerError = yield* requirePairingIssuer().pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            sessionId: AuthSessionId.make('server-storage-owner'),
            subject: 'server-storage-owner',
            method: 'bearer-access-token',
            scopes: new Set(AuthStandardClientScopes),
          }),
          Effect.flip,
        )
        assert.equal(forgedIssuerError.requiredScope, AuthAccessWriteScope)
      }
    }).pipe(Effect.provide(makeHttpAuthLayer())),
  )

  it.effect('preserves ordinary bearer authentication on a project CLI path', () =>
    Effect.gen(function* ()
    {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth
      const session = yield* environmentAuth.issueSession({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        label: 'ordinary bearer regression',
      })
      const principal = yield* authenticateRequest(
        makeRequest({
          path: '/api/orchestration/project-commands/v1',
          remoteAddress: '127.0.0.1',
          storageOwnerToken: 'wrong-token',
          authorization: `Bearer ${session.token}`,
        }),
      )

      assert.equal(principal.sessionId, session.sessionId)
      assert.notEqual(principal.subject, 'server-storage-owner')
    }).pipe(Effect.provide(makeHttpAuthLayer())),
  )
})

it.effect('rejects recovery scope delegation even when the pairing issuer holds it', () =>
  Effect.gen(function* ()
  {
    const error = yield* requirePairingDelegatedScopes(
      {
        sessionId: AuthSessionId.make('recovery-pairing-issuer'),
        subject: 'recovery-operator',
        method: 'bearer-access-token',
        scopes: new Set([AuthAccessWriteScope, AuthOrchestrationRecoverScope]),
      },
      [AuthOrchestrationRecoverScope],
    ).pipe(Effect.flip)

    assert.instanceOf(error, EnvironmentRequestInvalidError)
    assert.equal(error.reason, 'invalid_scope')
  }),
)
