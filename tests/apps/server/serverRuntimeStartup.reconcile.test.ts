// tests/apps/server/serverRuntimeStartup.reconcile.test.ts
// verify orphaned provider session startup reconciliation

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import { type OrchestrationCommand, ProviderDriverKind, ThreadId, TurnId } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'

import { OrchestrationCommandInvariantError } from '../../../apps/server/src/orchestration/Errors.ts'
import * as OrchestrationEngine from '../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from '../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { ProviderSessionDirectoryPersistenceError } from '../../../apps/server/src/provider/Errors.ts'
import * as ProviderService from '../../../apps/server/src/provider/Services/ProviderService.ts'
import * as ProviderSessionDirectory from '../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts'
import * as ServerRuntimeStartup from '../../../apps/server/src/serverRuntimeStartup.ts'

const providerInstanceId = 'codex-instance-reconcile' as never
const updatedAt = '2026-08-20T12:00:00.000Z'

const makeThread = (
  id: string,
  status: 'starting' | 'running' | 'ready' | 'stopped' | 'error',
  activeTurnId: TurnId | null = null,
) => ({
  id: ThreadId.make(id),
  session: {
    threadId: ThreadId.make(id),
    status,
    providerName: 'codex',
    providerInstanceId,
    runtimeMode: 'full-access',
    activeTurnId,
    lastError: null,
    updatedAt,
  },
})

const makeProviderServiceStub = (
  liveThreadIds: ReadonlyArray<ThreadId> = [],
): ProviderService.ProviderService['Service'] =>
  ({
    listSessions: () => Effect.succeed(liveThreadIds.map((threadId) => ({ threadId }) as never)),
  }) as unknown as ProviderService.ProviderService['Service']

const makeQueryStub = (threads: ReadonlyArray<ReturnType<typeof makeThread>>) =>
  ({
    getCommandReadModel: () => Effect.succeed({ threads } as never),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']

const makeEngineStub = (
  dispatch: OrchestrationEngine.OrchestrationEngineService['Service']['dispatch'],
): OrchestrationEngine.OrchestrationEngineService['Service'] => ({
  readEvents: () => Stream.empty,
  readThreadEvents: () => Stream.die('thread replay is not used by reconciliation tests'),
  getThreadReplayStats: () =>
    Effect.die('thread replay stats are not used by reconciliation tests'),
  dispatch,
  dispatchInternal: () => Effect.die('unused'),
  streamDomainEvents: Stream.empty,
  streamDomainEventsForAggregate: () => Stream.empty,
  latestSequence: Effect.succeed(0),
})

const runReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof makeThread>>
  readonly liveThreadIds?: ReadonlyArray<ThreadId>
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory['Service']
  readonly dispatch: OrchestrationEngine.OrchestrationEngineService['Service']['dispatch']
}) =>
  ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      makeQueryStub(input.threads),
    ),
    Effect.provideService(
      ProviderService.ProviderService,
      makeProviderServiceStub(input.liveThreadIds),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, input.directory),
    Effect.provideService(
      OrchestrationEngine.OrchestrationEngineService,
      makeEngineStub(input.dispatch),
    ),
    Effect.provide(NodeServices.layer),
  )

it.effect('settles an orphaned thread by stopping its binding and failing its session', () =>
  Effect.gen(function* ()
  {
    const orphan = makeThread('thread-orphan', 'running', TurnId.make('turn-stale'))
    const bindingReads: ThreadId[] = []
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = []
    const dispatched: OrchestrationCommand[] = []

    yield* runReconciliation({
      threads: [orphan],
      directory: {
        getBinding: (candidate) =>
          Effect.sync(() => bindingReads.push(candidate)).pipe(
            Effect.as(
              Option.some({
                threadId: candidate,
                provider: ProviderDriverKind.make('codex'),
                providerInstanceId,
                status: 'running' as const,
                resumeCursor: { cursor: candidate },
                runtimePayload: { activeTurnId: 'stale-turn' },
                lastSeenAt: updatedAt,
              }),
            ),
          ),
        upsert: (binding) => Effect.sync(() => upserts.push(binding)),
        getProvider: () => Effect.die('unused'),
        listThreadIds: () => Effect.die('unused'),
        listBindings: () => Effect.die('unused'),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    })

    assert.deepStrictEqual(bindingReads, [orphan.id])
    assert.deepStrictEqual(
      upserts.map((binding) => ({
        status: binding.status,
        runtimePayload: binding.runtimePayload,
        resumeCursor: binding.resumeCursor,
      })),
      [
        {
          status: 'stopped',
          runtimePayload: { activeTurnId: null },
          resumeCursor: { cursor: orphan.id },
        },
      ],
    )

    assert.equal(dispatched.length, 1)
    const command = dispatched[0]
    if (command?.type !== 'thread.session.set')
    {
      return assert.fail(`Expected thread.session.set, got ${String(command?.type)}`)
    }
    assert.equal(command.threadId, orphan.id)
    assert.equal(command.session.status, 'error')
    assert.equal(command.session.activeTurnId, null)
    assert.equal(
      command.session.lastError,
      'Provider session did not survive a server restart. Send a new message to continue.',
    )
    assert.notEqual(command.session.updatedAt, updatedAt)
  }),
)

it.effect('leaves live and settled threads untouched while catching every orphan flavor', () =>
  Effect.gen(function* ()
  {
    const starting = makeThread('thread-starting', 'starting')
    const staleActiveTurn = makeThread('thread-stale-active-turn', 'ready', TurnId.make('turn-old'))
    const liveRunning = makeThread('thread-live-running', 'running', TurnId.make('turn-live'))
    const stoppedSettled = makeThread('thread-stopped-settled', 'stopped')
    const bindingReads: ThreadId[] = []
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = []
    const dispatched: OrchestrationCommand[] = []

    yield* runReconciliation({
      threads: [starting, staleActiveTurn, liveRunning, stoppedSettled],
      liveThreadIds: [liveRunning.id],
      directory: {
        getBinding: (candidate) =>
          Effect.sync(() => bindingReads.push(candidate)).pipe(
            Effect.as(Option.none<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>()),
          ),
        upsert: (binding) => Effect.sync(() => upserts.push(binding)),
        getProvider: () => Effect.die('unused'),
        listThreadIds: () => Effect.die('unused'),
        listBindings: () => Effect.die('unused'),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    })

    // the live running thread and the settled stopped thread must be untouched
    assert.deepStrictEqual(bindingReads, [starting.id, staleActiveTurn.id])
    assert.equal(upserts.length, 0)
    assert.deepStrictEqual(
      dispatched.map((command) => command.type === 'thread.session.set' && command.threadId),
      [starting.id, staleActiveTurn.id],
    )
  }),
)

it.effect('continues to settle projections when directory cleanup fails', () =>
  Effect.gen(function* ()
  {
    const orphan = makeThread('thread-cleanup-failure', 'starting')
    const readFailure = new ProviderSessionDirectoryPersistenceError({
      operation: 'ProviderSessionDirectory.getBinding',
      detail: 'simulated binding read failure',
    })
    const writeFailure = new ProviderSessionDirectoryPersistenceError({
      operation: 'ProviderSessionDirectory.upsert',
      detail: 'simulated binding write failure',
    })
    const upsertAttempts = yield* Ref.make(0)
    const dispatched: OrchestrationCommand[] = []

    yield* runReconciliation({
      threads: [orphan],
      directory: {
        getBinding: () => Effect.fail(readFailure),
        upsert: () =>
          Effect.gen(function* ()
          {
            yield* Ref.update(upsertAttempts, (count) => count + 1)
            return yield* Effect.fail(writeFailure)
          }),
        getProvider: () => Effect.die('unused'),
        listThreadIds: () => Effect.die('unused'),
        listBindings: () => Effect.die('unused'),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    })

    // cleanup failures are logged away and must not block or fail settlement
    assert.equal(yield* Ref.get(upsertAttempts), 0)
    assert.deepStrictEqual(
      dispatched.map((command) => command.type === 'thread.session.set' && command.threadId),
      [orphan.id],
    )
  }),
)

it.effect('propagates interrupts instead of logging them away', () =>
  Effect.gen(function* ()
  {
    const orphan = makeThread('thread-interrupted', 'starting')

    const exit = yield* runReconciliation({
      threads: [orphan],
      directory: {
        getBinding: () => Effect.succeed(Option.none()),
        upsert: () => Effect.void,
        getProvider: () => Effect.die('unused'),
        listThreadIds: () => Effect.die('unused'),
        listBindings: () => Effect.die('unused'),
      },
      dispatch: () => Effect.interrupt,
    }).pipe(Effect.exit)

    assert.isTrue(Exit.isFailure(exit))
    if (Exit.isFailure(exit))
    {
      assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
    }
  }),
)

// retry({ times: 1 }) gives transient dispatch failures one more attempt
it.effect('retries a failed projection once before logging it away', () =>
  Effect.gen(function* ()
  {
    const orphan = makeThread('thread-dispatch-transient-failure', 'running')
    const failure = new OrchestrationCommandInvariantError({
      commandType: 'thread.session.set',
      detail: 'simulated startup reconciliation failure',
    })
    let attempts = 0

    yield* runReconciliation({
      threads: [orphan],
      directory: {
        getBinding: () => Effect.succeed(Option.none()),
        upsert: () => Effect.void,
        getProvider: () => Effect.die('unused'),
        listThreadIds: () => Effect.die('unused'),
        listBindings: () => Effect.die('unused'),
      },
      dispatch: () =>
        Effect.suspend(() =>
          ++attempts === 1 ? Effect.fail(failure) : Effect.succeed({ sequence: attempts }),
        ),
    })

    assert.equal(attempts, 2)
  }),
)
