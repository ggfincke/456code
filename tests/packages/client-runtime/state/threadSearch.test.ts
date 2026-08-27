// tests/packages/client-runtime/state/threadSearch.test.ts
// verifies debounced search cancellation and stale-result isolation through public rpc atoms

import { expect, it } from '@effect/vitest'
import { vi } from 'vite-plus/test'
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationSearchThreadsError,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from '../../../../packages/client-runtime/src/connection/model.ts'
import * as EnvironmentRegistry from '../../../../packages/client-runtime/src/connection/registry.ts'
import * as EnvironmentSupervisor from '../../../../packages/client-runtime/src/connection/supervisor.ts'
import type { WsRpcProtocolClient } from '../../../../packages/client-runtime/src/rpc/protocol.ts'
import type { RpcSession } from '../../../../packages/client-runtime/src/rpc/session.ts'
import { createOrchestrationEnvironmentAtoms } from '../../../../packages/client-runtime/src/state/session/orchestration.ts'
import { createThreadSearchAtoms } from '../../../../packages/client-runtime/src/state/threadSearch.ts'

it('debounces connected-only queries, aborts replaced work and suppresses late old results', async () =>
{
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const atomRegistry = AtomRegistry.make({
    scheduleTask: (run) =>
    {
      const timer = setTimeout(run, 0)
      return () => clearTimeout(timer)
    },
  })
  const online = EnvironmentId.make('online')
  const offline = EnvironmentId.make('offline')
  const started: string[] = []
  const cancelled: string[] = []
  const complete = new Map<string, (value: OrchestrationSearchThreadsResult) => void>()
  const fail = new Map<string, () => void>()
  const result = (query: string): OrchestrationSearchThreadsResult => ({
    matches: [
      {
        threadId: ThreadId.make(query),
        projectId: ProjectId.make('project'),
        source: 'user',
        snippet: query,
        messageCreatedAt: '2026-08-27T00:00:00.000Z',
      },
    ],
  })
  try
  {
    const runtime = Atom.runtime(
      Layer.effect(
        EnvironmentRegistry.EnvironmentRegistry,
        Effect.gen(function* ()
        {
          const target = new PrimaryConnectionTarget({
            environmentId: online,
            label: 'Search',
            httpBaseUrl: 'http://localhost',
            wsBaseUrl: 'ws://localhost',
          })
          const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: 'connected',
          })
          const client = {
            [ORCHESTRATION_WS_METHODS.searchThreads]: ({ query }: { query: string }) =>
              Effect.callback<OrchestrationSearchThreadsResult, OrchestrationSearchThreadsError>(
                (resume) =>
                {
                  started.push(query)
                  complete.set(query, (value) => resume(Effect.succeed(value)))
                  fail.set(query, () =>
                    resume(
                      Effect.fail(
                        new OrchestrationSearchThreadsError({ message: 'Search unavailable.' }),
                      ),
                    ),
                  )
                  return Effect.sync(() =>
                  {
                    cancelled.push(query)
                  })
                },
              ),
          } as unknown as WsRpcProtocolClient
          const session = yield* SubscriptionRef.make(
            Option.some<RpcSession>({
              client,
              initialConfig: Effect.never,
              ready: Effect.void,
              probe: Effect.void,
              closed: Effect.never,
            }),
          )
          const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
            target,
            state,
            session,
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          })
          const run: EnvironmentRegistry.EnvironmentRegistry['Service']['run'] = (id, effect) =>
          {
            expect(id).not.toBe(offline)
            return Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor,
            )
          }
          const followStream: EnvironmentRegistry.EnvironmentRegistry['Service']['followStream'] = (
            _id,
            stream,
          ) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
          return EnvironmentRegistry.EnvironmentRegistry.of({
            run,
            followStream,
          } as EnvironmentRegistry.EnvironmentRegistry['Service'])
        }),
      ),
    )
    const orchestration = createOrchestrationEnvironmentAtoms(runtime)
    const connected = Atom.make<ReadonlyArray<EnvironmentId>>([online])
    const search = createThreadSearchAtoms({
      connectedEnvironmentIds: connected,
      getSearchAtom: (environmentId, query) =>
        orchestration.searchThreads({ environmentId, input: { query } }),
    })
    const unmount = atomRegistry.subscribe(search.results, () =>
    {}, { immediate: true })
    atomRegistry.set(search.query, 'x')
    await vi.advanceTimersByTimeAsync(220)
    expect(atomRegistry.get(search.results)).toEqual({ matches: [], isLoading: false })
    expect(started).toEqual([])
    atomRegistry.set(search.query, 'old')
    await vi.advanceTimersByTimeAsync(199)
    expect(started).toEqual([])
    await vi.advanceTimersByTimeAsync(21)
    expect(started).toEqual(['old'])
    atomRegistry.set(search.query, 'new')
    expect(atomRegistry.get(search.results).matches).toEqual([])
    await vi.advanceTimersByTimeAsync(220)
    expect(cancelled).toContain('old')
    expect(started).toEqual(['old', 'new'])
    complete.get('old')!(result('old'))
    complete.get('new')!(result('new'))
    await vi.advanceTimersByTimeAsync(20)
    expect(atomRegistry.get(search.results).matches.map((match) => match.threadId)).toEqual(['new'])
    atomRegistry.refresh(
      orchestration.searchThreads({ environmentId: online, input: { query: 'new' } }),
    )
    await vi.advanceTimersByTimeAsync(20)
    expect(started).toEqual(['old', 'new', 'new'])
    fail.get('new')!()
    await vi.advanceTimersByTimeAsync(20)
    expect(atomRegistry.get(search.results)).toEqual({ matches: [], isLoading: false })
    atomRegistry.set(connected, [])
    expect(atomRegistry.get(search.results)).toEqual({ matches: [], isLoading: false })
    atomRegistry.set(search.query, 'disconnected')
    await vi.advanceTimersByTimeAsync(200)
    expect(started).toEqual(['old', 'new', 'new'])
    unmount()
  }
  finally
  {
    atomRegistry.dispose()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  }
})
