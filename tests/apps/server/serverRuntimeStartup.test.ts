// tests/apps/server/serverRuntimeStartup.test.ts
// verify server runtime startup behavior

import * as NodeServices from '@effect/platform-node/NodeServices'
import { ProjectId, ThreadId } from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Crypto from 'effect/Crypto'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import * as ServerConfig from '../../../apps/server/src/config.ts'
import * as ImportService from '../../../apps/server/src/import/importService.ts'
import { PersistenceSqlError } from '../../../apps/server/src/persistence/Errors.ts'
import * as ProposalRetainedRefReconciler from '../../../apps/server/src/proposal/ProposalRetainedRefReconciler.ts'
import * as OrchestrationEngine from '../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from '../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as AnalyticsService from '../../../apps/server/src/telemetry/Services/AnalyticsService.ts'
import * as ServerRuntimeStartup from '../../../apps/server/src/serverRuntimeStartup.ts'
import { makeProjectionSnapshotQueryStub } from './projectionSnapshotQueryTestHelpers.ts'

it.effect('enqueueCommand waits for readiness and then drains queued work', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const executionCount = yield* Ref.make(0)
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped)

      yield* Effect.yieldNow
      assert.equal(yield* Ref.get(executionCount), 0)

      yield* commandGate.signalCommandReady

      const result = yield* Fiber.join(queuedCommandFiber)
      assert.equal(result, 1)
      assert.equal(yield* Ref.get(executionCount), 1)
    }),
  ),
)

it.effect('enqueueCommand times out a blocked head command and releases queued work', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate
      const headInterrupted = yield* Deferred.make<void>()
      const executionOrder = yield* Ref.make<ReadonlyArray<string>>([])

      const headCommandFiber = yield* commandGate
        .enqueueCommand(
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(headInterrupted, undefined))),
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(
          Ref.update(executionOrder, (order) => [...order, 'queued']).pipe(
            Effect.as('queued-result'),
          ),
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      yield* commandGate.signalCommandReady
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* Ref.get(executionOrder), [])
      yield* TestClock.adjust(`${ServerRuntimeStartup.COMMAND_EXECUTION_TIMEOUT_MS} millis`)

      const error = yield* Effect.flip(Fiber.join(headCommandFiber))
      assert.equal(error._tag, 'ServerRuntimeCommandTimeoutError')
      if (error._tag !== 'ServerRuntimeCommandTimeoutError')
      {
        return assert.fail('Expected ServerRuntimeCommandTimeoutError')
      }
      assert.equal(error.timeoutMs, ServerRuntimeStartup.COMMAND_EXECUTION_TIMEOUT_MS)
      yield* Deferred.await(headInterrupted)
      assert.equal(yield* Fiber.join(queuedCommandFiber), 'queued-result')
      assert.deepStrictEqual(yield* Ref.get(executionOrder), ['queued'])
    }),
  ),
)

it.effect('enqueueCommand leaves fast queued commands unaffected by the timeout', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate
      const executionOrder = yield* Ref.make<ReadonlyArray<string>>([])
      const makeCommand = (name: string) =>
        Ref.update(executionOrder, (order) => [...order, name]).pipe(Effect.as(name))

      const firstCommandFiber = yield* commandGate
        .enqueueCommand(makeCommand('first'))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const secondCommandFiber = yield* commandGate
        .enqueueCommand(makeCommand('second'))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      yield* commandGate.signalCommandReady

      assert.equal(yield* Fiber.join(firstCommandFiber), 'first')
      assert.equal(yield* Fiber.join(secondCommandFiber), 'second')
      assert.deepStrictEqual(yield* Ref.get(executionOrder), ['first', 'second'])
    }),
  ),
)

it.effect('enqueueCommand fails queued work when readiness fails', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate
      const failure = yield* Deferred.make<void, never>()

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as('should-not-run')))
        .pipe(Effect.forkScoped)

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: 'web',
          host: '127.0.0.1',
          port: 3773,
          cause: new Error('test startup failure'),
        }),
      )

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber))
      assert.equal(error.message, 'Server runtime startup failed before command readiness.')
    }),
  ),
)

it.effect('launchStartupHeartbeat does not block the caller while counts are loading', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const releaseCounts = yield* Deferred.make<void, never>()

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          makeProjectionSnapshotQueryStub({
            getCounts: () =>
              Deferred.await(releaseCounts).pipe(
                Effect.as({
                  projectCount: 2,
                  threadCount: 3,
                }),
              ),
          }),
        ),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      )
    }),
  ),
)

it.effect('inventories import replacements before source-independent startup recovery', () =>
  Effect.gen(function* ()
  {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const emptyReport: ImportService.ImportReplacementRecoveryReport = {
      openIntentCount: 0,
      recoveredCount: 0,
      awaitingSourceRetryCount: 0,
      manualCount: 0,
      blockedCount: 0,
      items: [],
    }

    yield* ServerRuntimeStartup.runImportReplacementStartupRecovery.pipe(
      Effect.provideService(
        ImportService.ImportService,
        ImportService.ImportService.of({
          importSessions: () => Effect.die('startup must not execute an import request'),
          inspectOpenReplacementIntents: Ref.update(calls, (items) => [...items, 'inventory']).pipe(
            Effect.as(emptyReport),
          ),
          recoverOpenReplacementIntents: Ref.update(calls, (items) => [...items, 'recover']).pipe(
            Effect.as(emptyReport),
          ),
        }),
      ),
    )

    assert.deepStrictEqual(yield* Ref.get(calls), ['inventory', 'recover'])
  }),
)

it.effect('does not recover import replacements when read-only inventory fails', () =>
  Effect.gen(function* ()
  {
    const recoveryCount = yield* Ref.make(0)
    const inventoryError = new PersistenceSqlError({
      operation: 'serverRuntimeStartup.test.import-inventory',
    })
    const error = yield* ServerRuntimeStartup.runImportReplacementStartupRecovery.pipe(
      Effect.provideService(
        ImportService.ImportService,
        ImportService.ImportService.of({
          importSessions: () => Effect.die('startup must not execute an import request'),
          inspectOpenReplacementIntents: Effect.fail(inventoryError),
          recoverOpenReplacementIntents: Ref.update(recoveryCount, (count) => count + 1).pipe(
            Effect.as({
              openIntentCount: 0,
              recoveredCount: 0,
              awaitingSourceRetryCount: 0,
              manualCount: 0,
              blockedCount: 0,
              items: [],
            }),
          ),
        }),
      ),
      Effect.flip,
    )

    assert.equal(error, inventoryError)
    assert.equal(yield* Ref.get(recoveryCount), 0)
  }),
)

it.effect('proposal retained-ref reconciliation failure cannot fail startup readiness', () =>
  ServerRuntimeStartup.runProposalRetainedRefReconciliation.pipe(
    Effect.provideService(ServerConfig.ServerConfig, {
      proposalReconciliationMode: 'report',
      proposalReconciliationDeleteEnabled: false,
    } as never),
    Effect.provideService(
      ProposalRetainedRefReconciler.ProposalRetainedRefReconciler,
      ProposalRetainedRefReconciler.ProposalRetainedRefReconciler.of({
        reconcile: Effect.fail(
          new PersistenceSqlError({
            operation: 'serverRuntimeStartup.test.reconciliation',
          }),
        ),
      }),
    ),
  ),
)

it.effect('proposal retained-ref reconciliation is bounded', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const fiber = yield* ServerRuntimeStartup.runProposalRetainedRefReconciliation.pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          proposalReconciliationMode: 'report',
          proposalReconciliationDeleteEnabled: false,
        } as never),
        Effect.provideService(
          ProposalRetainedRefReconciler.ProposalRetainedRefReconciler,
          ProposalRetainedRefReconciler.ProposalRetainedRefReconciler.of({
            reconcile: Effect.never,
          }),
        ),
        Effect.forkScoped,
      )

      yield* TestClock.adjust('600 millis')
      yield* Fiber.join(fiber)
    }),
  ),
)

it.effect('resolveWelcomeBase derives cwd and project name from server config', () =>
  Effect.gen(function* ()
  {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: '/tmp/startup-project',
      } as never),
    )

    assert.deepStrictEqual(welcome, {
      cwd: '/tmp/startup-project',
      projectName: 'startup-project',
    })
  }),
)

it.effect('resolveAutoBootstrapWelcomeTargets returns existing project and thread ids', () =>
{
  const bootstrapProjectId = ProjectId.make('project-startup-bootstrap')
  const bootstrapThreadId = ThreadId.make('thread-startup-bootstrap')

  return Effect.gen(function* ()
  {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([])
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: '/tmp/startup-project',
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        makeProjectionSnapshotQueryStub({
          getActiveProjectByWorkspaceRoot: () =>
            Effect.succeed(
              Option.some({
                id: bootstrapProjectId,
                title: 'Startup Project',
                workspaceRoot: '/tmp/startup-project',
                defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
                scripts: [],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                deletedAt: null,
              }),
            ),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        }),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.die('unused thread replay'),
        getThreadReplayStats: () => Effect.die('unused thread replay stats'),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        dispatchInternal: () => Effect.succeed({ sequence: 1 }),
        streamDomainEvents: Stream.empty,
        streamDomainEventsForAggregate: () => Stream.empty,
        registerDomainEventAdmission: () => Effect.void,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService['Service']),
      Effect.provide(NodeServices.layer),
    )

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    })
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), [])
  })
})

it.effect('resolveAutoBootstrapWelcomeTargets creates a project and thread when missing', () =>
  Effect.gen(function* ()
  {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([])
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: '/tmp/startup-project',
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        makeProjectionSnapshotQueryStub({
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        }),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.die('unused thread replay'),
        getThreadReplayStats: () => Effect.die('unused thread replay stats'),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        dispatchInternal: () => Effect.succeed({ sequence: 1 }),
        streamDomainEvents: Stream.empty,
        streamDomainEventsForAggregate: () => Stream.empty,
        registerDomainEventAdmission: () => Effect.void,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService['Service']),
      Effect.provide(NodeServices.layer),
    )

    assert.equal(typeof targets.bootstrapProjectId, 'string')
    assert.equal(typeof targets.bootstrapThreadId, 'string')
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ['project.create', 'thread.create'])
  }),
)

it.effect('resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures', () =>
  Effect.gen(function* ()
  {
    const crypto = yield* Crypto.Crypto
    const uuidError = PlatformError.systemError({
      _tag: 'Unknown',
      module: 'Crypto',
      method: 'randomUUIDv4',
      description: 'UUID generation unavailable',
    })
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([])

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: '/tmp/startup-project',
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        makeProjectionSnapshotQueryStub({
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        }),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.die('unused thread replay'),
        getThreadReplayStats: () => Effect.die('unused thread replay stats'),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        dispatchInternal: () => Effect.succeed({ sequence: 1 }),
        streamDomainEvents: Stream.empty,
        streamDomainEventsForAggregate: () => Stream.empty,
        registerDomainEventAdmission: () => Effect.void,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService['Service']),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    )

    assert.strictEqual(error, uuidError)
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), [])
  }).pipe(Effect.provide(NodeServices.layer)),
)
