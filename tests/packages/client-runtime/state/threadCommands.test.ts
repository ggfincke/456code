// tests/packages/client-runtime/state/threadCommands.test.ts
// verify shared thread environment commands expose an explicit provider switch

import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { Atom } from 'effect/unstable/reactivity'

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from '../../../../packages/client-runtime/src/connection/model.ts'
import type { EnvironmentRegistry } from '../../../../packages/client-runtime/src/connection/registry.ts'
import * as EnvironmentSupervisor from '../../../../packages/client-runtime/src/connection/supervisor.ts'
import { switchThreadProvider } from '../../../../packages/client-runtime/src/operations/commands.ts'
import * as RpcSession from '../../../../packages/client-runtime/src/rpc/session.ts'
import type { WsRpcProtocolClient } from '../../../../packages/client-runtime/src/rpc/protocol.ts'
import { createThreadEnvironmentAtoms } from '../../../../packages/client-runtime/src/state/threadCommands.ts'

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
)

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make('environment-1'),
  label: 'Test environment',
  httpBaseUrl: 'https://environment.example.test',
  wsBaseUrl: 'wss://environment.example.test',
})

const makeSupervisor = Effect.fn('TestThreadCommands.makeSupervisor')(function* (
  dispatched: ClientOrchestrationCommand[],
)
{
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() =>
      {
        dispatched.push(command)
        return { sequence: dispatched.length }
      }),
  } as unknown as WsRpcProtocolClient
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  }
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor['Service'])
})

describe('thread environment commands', () =>
{
  it.effect('dispatches an explicit provider switch carrying the expected current instance', () =>
    Effect.gen(function* ()
    {
      const dispatched: ClientOrchestrationCommand[] = []
      const supervisor = yield* makeSupervisor(dispatched)

      yield* switchThreadProvider({
        threadId: ThreadId.make('thread-1'),
        targetModelSelection: {
          instanceId: ProviderInstanceId.make('provider-next'),
          model: 'gpt-next',
        },
        expectedCurrentInstanceId: ProviderInstanceId.make('provider-current'),
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provide(TEST_CRYPTO_LAYER),
      )

      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]).toMatchObject({
        type: 'thread.provider.switch',
        threadId: 'thread-1',
        expectedCurrentInstanceId: 'provider-current',
        targetModelSelection: { instanceId: 'provider-next', model: 'gpt-next' },
      })
      expect(dispatched[0]?.commandId).toBeTruthy()
    }),
  )

  it('exposes the provider switch alongside the other per-thread commands', () =>
  {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | Crypto.Crypto,
      never
    >
    const commands = createThreadEnvironmentAtoms(runtime)

    expect(commands.switchProvider).toBeDefined()
    expect(typeof commands.switchProvider.label).toBe('string')
    expect(commands.switchProvider.label.length).toBeGreaterThan(0)
  })
})
