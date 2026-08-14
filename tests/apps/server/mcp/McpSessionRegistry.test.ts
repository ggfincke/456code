// tests/apps/server/mcp/McpSessionRegistry.test.ts
// verifies mcp credential lifetime and revocation
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import { EnvironmentId, ProviderInstanceId, ThreadId, TurnId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import { HttpServer } from 'effect/unstable/http'

import * as ServerEnvironment from '../../../../apps/server/src/environment/ServerEnvironment.ts'
import * as McpSessionRegistry from '../../../../apps/server/src/mcp/McpSessionRegistry.ts'

const environmentId = EnvironmentId.make('environment-1')
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: 'TcpAddress', hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer['Service']['serve'],
  })
const fakeHttpServer = makeFakeHttpServer('127.0.0.1')
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die('unused'),
})

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    )

it.effect('stores only a token hash, resolves the bearer token, and revokes by thread', () =>
  Effect.gen(function* ()
  {
    let timestamp = 1_000
    const registry = yield* makeRegistry(() => timestamp)
    const threadId = ThreadId.make('thread-1')
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make('codex'),
      providerSessionGeneration: 1,
    })
    expect(issued.config.endpoint).toBe('http://127.0.0.1:43123/mcp')
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, '')
    expect(token.length).toBeGreaterThan(20)

    const resolved = yield* registry.resolve(token)
    expect(resolved?.threadId).toBe(threadId)
    expect(resolved?.capabilities).toEqual(
      new Set(['preview', 'proposal', 'orchestrate', 'architecture']),
    )
    expect(resolved?.activeTurnId).toBeUndefined()

    const turnId = TurnId.make('turn-1')
    yield* registry.bindActiveTurn(threadId, turnId)
    expect((yield* registry.resolve(token))?.activeTurnId).toBe(turnId)

    yield* registry.bindActiveTurn(threadId)
    expect((yield* registry.resolve(token))?.activeTurnId).toBeUndefined()

    yield* registry.revokeThread(threadId)
    expect(yield* registry.resolve(token)).toBeUndefined()

    timestamp += 2_000
  }),
)

it.effect('builds MCP endpoints from the bound server host', () =>
  Effect.gen(function* ()
  {
    const cases = [
      ['100.64.0.40', 'http://100.64.0.40:43123/mcp'],
      ['0.0.0.0', 'http://127.0.0.1:43123/mcp'],
      ['localhost', 'http://localhost:43123/mcp'],
      ['127.0.0.1', 'http://127.0.0.1:43123/mcp'],
    ] as const

    for (const [hostname, expectedEndpoint] of cases)
    {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname))
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make('codex'),
        providerSessionGeneration: 1,
      })
      expect(issued.config.endpoint).toBe(expectedEndpoint)
    }
  }),
)

it.effect('expires credentials once their session stops showing signs of life', () =>
  Effect.gen(function* ()
  {
    let timestamp = 1_000
    const registry = yield* makeRegistry(() => timestamp)
    const issued = yield* registry.issue({
      threadId: ThreadId.make('thread-2'),
      providerInstanceId: ProviderInstanceId.make('claude'),
      providerSessionGeneration: 1,
    })
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, '')
    timestamp += 101
    expect(yield* registry.resolve(token)).toBeUndefined()
  }),
)

it.effect('keeps a credential alive across turns that never touch an MCP tool', () =>
  Effect.gen(function* ()
  {
    let timestamp = 1_000
    const registry = yield* makeRegistry(() => timestamp)
    const threadId = ThreadId.make('thread-3')
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make('claude'),
      providerSessionGeneration: 1,
    })
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, '')

    // each turn refreshes the credential before the liveness window lapses
    for (let turn = 0; turn < 10; turn += 1)
    {
      timestamp += 99
      yield* registry.touch(threadId)
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId)
  }),
)

it.effect('does not keep credentials of other threads alive', () =>
  Effect.gen(function* ()
  {
    let timestamp = 1_000
    const registry = yield* makeRegistry(() => timestamp)
    const issued = yield* registry.issue({
      threadId: ThreadId.make('thread-4'),
      providerInstanceId: ProviderInstanceId.make('codex'),
      providerSessionGeneration: 1,
    })
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, '')

    timestamp += 99
    yield* registry.touch(ThreadId.make('thread-unrelated'))
    timestamp += 2

    expect(yield* registry.resolve(token)).toBeUndefined()
  }),
)

it.effect('replaces the credential owned by an existing provider thread', () =>
  Effect.gen(function* ()
  {
    const registry = yield* makeRegistry(() => 1_000)
    const threadId = ThreadId.make('thread-replaced')
    const first = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make('codex'),
      providerSessionGeneration: 1,
    })
    const second = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make('claude'),
      providerSessionGeneration: 2,
    })
    const firstToken = first.config.authorizationHeader.replace(/^Bearer\s+/, '')
    const secondToken = second.config.authorizationHeader.replace(/^Bearer\s+/, '')

    expect(yield* registry.resolve(firstToken)).toBeUndefined()
    expect((yield* registry.resolve(secondToken))?.providerInstanceId).toBe(
      ProviderInstanceId.make('claude'),
    )
    yield* registry.revokeExact({
      threadId,
      providerInstanceId: ProviderInstanceId.make('codex'),
      providerSessionGeneration: 1,
    })
    expect((yield* registry.resolve(secondToken))?.providerSessionGeneration).toBe(2)
  }),
)

it.effect('keeps disabled provider composition explicit and inert', () =>
  Effect.gen(function* ()
  {
    const registry = McpSessionRegistry.__testing.disabled
    const threadId = ThreadId.make('thread-disabled')

    expect(registry.enabled).toBe(false)
    expect(
      yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make('codex'),
        providerSessionGeneration: 1,
      }),
    ).toBeUndefined()
    yield* registry.touch(threadId)
    yield* registry.bindActiveTurn(threadId, TurnId.make('turn-disabled'))
    yield* registry.revokeThread(threadId)
    yield* registry.revokeAll
    expect(yield* registry.resolve('unissued-token')).toBeUndefined()
  }),
)

it.effect('isolates concurrent registry scopes and revokes only the scope that closes', () =>
  Effect.gen(function* ()
  {
    const registryLayer = Layer.fresh(
      McpSessionRegistry.enabledLayer.pipe(
        Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
        Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
        Layer.provide(NodeServices.layer),
      ),
    )
    const firstScope = yield* Scope.make()
    const secondScope = yield* Scope.make()
    const firstContext = yield* Layer.build(registryLayer).pipe(Scope.provide(firstScope))
    const secondContext = yield* Layer.build(registryLayer).pipe(Scope.provide(secondScope))
    const firstRegistry = yield* McpSessionRegistry.McpSessionRegistry.pipe(
      Effect.provide(firstContext),
    )
    const secondRegistry = yield* McpSessionRegistry.McpSessionRegistry.pipe(
      Effect.provide(secondContext),
    )
    const firstIssued = yield* firstRegistry.issue({
      threadId: ThreadId.make('thread-shared-name'),
      providerInstanceId: ProviderInstanceId.make('codex'),
      providerSessionGeneration: 1,
    })
    const secondIssued = yield* secondRegistry.issue({
      threadId: ThreadId.make('thread-shared-name'),
      providerInstanceId: ProviderInstanceId.make('claude'),
      providerSessionGeneration: 1,
    })
    if (!firstIssued || !secondIssued)
    {
      throw new Error('enabled registry did not issue credentials')
    }
    const firstToken = firstIssued.config.authorizationHeader.replace(/^Bearer\s+/, '')
    const secondToken = secondIssued.config.authorizationHeader.replace(/^Bearer\s+/, '')

    expect(yield* firstRegistry.resolve(secondToken)).toBeUndefined()
    expect(yield* secondRegistry.resolve(firstToken)).toBeUndefined()
    yield* Scope.close(firstScope, Exit.void)
    expect(yield* firstRegistry.resolve(firstToken)).toBeUndefined()
    expect((yield* secondRegistry.resolve(secondToken))?.providerInstanceId).toBe(
      ProviderInstanceId.make('claude'),
    )
    yield* Scope.close(secondScope, Exit.void)
  }),
)
