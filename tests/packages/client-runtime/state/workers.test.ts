// tests/packages/client-runtime/state/workers.test.ts
// covers worker subscription atoms

import { describe, expect, it } from '@effect/vitest'
import { EnvironmentId, WS_METHODS } from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as Layer from 'effect/Layer'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import * as TestClock from 'effect/testing/TestClock'
import { AsyncResult, Atom, AtomRegistry } from 'effect/unstable/reactivity'

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from '../../../../packages/client-runtime/src/connection/model.ts'
import * as EnvironmentRegistry from '../../../../packages/client-runtime/src/connection/registry.ts'
import * as EnvironmentSupervisor from '../../../../packages/client-runtime/src/connection/supervisor.ts'
import type { WsRpcProtocolClient } from '../../../../packages/client-runtime/src/rpc/protocol.ts'
import type { RpcSession } from '../../../../packages/client-runtime/src/rpc/session.ts'
import { createWorkersEnvironmentAtoms } from '../../../../packages/client-runtime/src/state/workers.ts'

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make('environment-1'),
  label: 'Test environment',
  httpBaseUrl: 'https://environment.example.test',
  wsBaseUrl: 'wss://environment.example.test',
})

function session(client: WsRpcProtocolClient): RpcSession
{
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  }
}

describe('worker activity environment atoms', () =>
{
  it('maps one selected job to one stable subscription atom', () =>
  {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry,
      never
    >
    const workers = createWorkersEnvironmentAtoms(runtime)
    const target = {
      environmentId: EnvironmentId.make('environment-1'),
      input: { jobId: 'job-a' },
    }

    expect(workers.activity(target)).toBe(
      workers.activity({ environmentId: target.environmentId, input: { jobId: 'job-a' } }),
    )
    expect(
      workers.activity({ environmentId: target.environmentId, input: { jobId: 'job-b' } }),
    ).not.toBe(workers.activity(target))
    expect(
      workers.activity({
        environmentId: EnvironmentId.make('environment-2'),
        input: target.input,
      }),
    ).not.toBe(workers.activity(target))
  })

  it.effect('falls back immediately and filters run-scoped snapshots', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const listInputs: Array<{ readonly run?: string }> = []
        const listRunsInputs: Array<Record<string, never>> = []
        const job = { jobId: 'job-a' }
        const requestedRun = { run: 'run-a' }
        const otherRun = { run: 'run-b' }
        const client = {
          [WS_METHODS.workersSubscribe]: () => Stream.fail(new Error('subscription unavailable')),
          [WS_METHODS.workersList]: (input: { readonly run?: string }) =>
            Effect.sync(() =>
            {
              listInputs.push(input)
              return {
                readAt: '2026-08-06T00:00:00.000Z',
                jobs: [job],
                error: Option.none(),
              }
            }),
          [WS_METHODS.workersListRuns]: (input: Record<string, never>) =>
            Effect.sync(() =>
            {
              listRunsInputs.push(input)
              return { runs: [requestedRun, otherRun] }
            }),
        } as unknown as WsRpcProtocolClient
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor['Service'])
        const followStream: EnvironmentRegistry.EnvironmentRegistry['Service']['followStream'] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry['Service'])
        const clock = yield* TestClock.make()
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(Clock.Clock, clock),
          ),
        )
        const workers = createWorkersEnvironmentAtoms(runtime)
        const scheduledTasks: Array<{ canceled: boolean; run: () => void }> = []
        const flushScheduledTasks = () =>
        {
          while (scheduledTasks.length > 0)
          {
            const task = scheduledTasks.shift()!
            if (!task.canceled) task.run()
          }
        }
        const registry = yield* Effect.acquireRelease(
          Effect.sync(() =>
            AtomRegistry.make({
              scheduleTask: (run) =>
              {
                const task = { canceled: false, run }
                scheduledTasks.push(task)
                return () =>
                {
                  task.canceled = true
                }
              },
            }),
          ),
          (registry) => Effect.sync(() => registry.dispose()),
        )
        type WorkerSnapshot = {
          readonly jobs: ReadonlyArray<{ readonly jobId: string }>
          readonly run: Option.Option<{ readonly run: string }>
        }
        const snapshots: WorkerSnapshot[] = []
        const workerAtom = workers.getRun({
          environmentId: TARGET.environmentId,
          input: { run: 'run-a' },
        })
        registry.subscribe(
          workerAtom,
          (result) =>
          {
            if (AsyncResult.isSuccess(result))
            {
              snapshots.push(result.value)
            }
          },
          { immediate: true },
        )
        for (let attempt = 0; attempt < 10 && snapshots.length === 0; attempt += 1)
        {
          flushScheduledTasks()
          yield* TestClock.withLive(Effect.sleep('1 millis'))
        }
        flushScheduledTasks()

        expect(snapshots).toHaveLength(1)
        const firstSnapshot = snapshots.shift()!

        expect(listInputs).toEqual([{ run: 'run-a' }])
        expect(listRunsInputs).toEqual([{}])
        expect(firstSnapshot.jobs).toEqual([job])
        expect(firstSnapshot.run).toEqual(Option.some(requestedRun))

        yield* clock.adjust('29 seconds')
        flushScheduledTasks()
        yield* TestClock.withLive(Effect.sleep('1 millis'))
        flushScheduledTasks()
        expect(listInputs).toHaveLength(1)
        expect(listRunsInputs).toHaveLength(1)
        expect(snapshots).toHaveLength(0)

        yield* clock.adjust('1 second')
        for (let attempt = 0; attempt < 10 && snapshots.length === 0; attempt += 1)
        {
          flushScheduledTasks()
          yield* TestClock.withLive(Effect.sleep('1 millis'))
        }
        flushScheduledTasks()
        expect(snapshots).toHaveLength(1)
        expect(listInputs).toHaveLength(2)
        expect(listRunsInputs).toHaveLength(2)
      }),
    ),
  )
})
