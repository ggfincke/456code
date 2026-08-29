// tests/apps/server/orchestration/Layers/DurableReactorRunner.test.ts
// verifies persisted replay, shadow delivery, restart convergence, and blocking

import * as NodeServices from '@effect/platform-node/NodeServices'
import { EventId, ProjectId, type OrchestrationEvent } from '@t3tools/contracts'
import { assert, describe, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'

import { DurableReactorRunnerLive } from '../../../../../apps/server/src/orchestration/Layers/DurableReactorRunner.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../../../../../apps/server/src/orchestration/Services/DurableReactorRunner.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { OrchestrationReactorDeliveryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationReactorDelivery.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import {
  makeReactorActionId,
  OrchestrationReactorDelivery,
  type ReactorId,
} from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'

const NOW = '2026-01-01T00:00:00.000Z'

interface TestEventFeedShape
{
  readonly append: (event: OrchestrationEvent, wake: boolean) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<ReadonlyArray<OrchestrationEvent>>
  readonly stream: Stream.Stream<OrchestrationEvent>
}

class TestEventFeed extends Context.Service<TestEventFeed, TestEventFeedShape>()(
  '@t3tools/tests/apps/server/orchestration/Layers/DurableReactorRunner.test/TestEventFeed',
)
{}

const TestEventFeedLive = Layer.effect(
  TestEventFeed,
  Effect.gen(function* ()
  {
    const events = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([])
    const wakeups = yield* PubSub.unbounded<OrchestrationEvent>()
    return TestEventFeed.of({
      append: (event, wake) =>
        Ref.update(events, (current) => [...current, event]).pipe(
          Effect.andThen(wake ? PubSub.publish(wakeups, event) : Effect.void),
          Effect.asVoid,
        ),
      snapshot: Ref.get(events),
      get stream()
      {
        return Stream.fromPubSub(wakeups)
      },
    })
  }),
)

const TestEngineLive = Layer.effect(
  OrchestrationEngineService,
  Effect.gen(function* ()
  {
    const feed = yield* TestEventFeed
    return OrchestrationEngineService.of({
      readEvents: (cursor, limit = 1_000) =>
        Stream.unwrap(
          feed.snapshot.pipe(
            Effect.map((events) =>
              Stream.fromIterable(
                events.filter((event) => event.sequence > cursor).slice(0, limit),
              ),
            ),
          ),
        ),
      dispatch: () => Effect.die(new Error('dispatch is not used by runner tests')),
      dispatchInternal: () =>
        Effect.die(new Error('internal dispatch is not used by runner tests')),
      get streamDomainEvents()
      {
        return feed.stream
      },
      streamDomainEventsForAggregate: () => feed.stream,
      latestSequence: feed.snapshot.pipe(Effect.map((events) => events.at(-1)?.sequence ?? 0)),
    })
  }),
).pipe(Layer.provide(TestEventFeedLive))

const DeliveryLive = OrchestrationReactorDeliveryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
)
const RunnerLive = DurableReactorRunnerLive.pipe(
  Layer.provide(DeliveryLive),
  Layer.provide(TestEngineLive),
)
// each test builds a fresh layer so the shared feed/db cannot leak across tests
const makeTestLayer = () =>
  Layer.mergeAll(TestEventFeedLive, TestEngineLive, DeliveryLive, RunnerLive).pipe(
    Layer.provideMerge(NodeServices.layer),
  )

const event = (sequence: number): OrchestrationEvent => ({
  type: 'project.created',
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: 'project',
  aggregateId: ProjectId.make(`project-${sequence}`),
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    projectId: ProjectId.make(`project-${sequence}`),
    title: `Project ${sequence}`,
    workspaceRoot: `/tmp/project-${sequence}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  },
})

const prepareProgress = (reactorId: ReactorId, mode: 'shadow' | 'durable', operationVersion = 1) =>
  Effect.gen(function* ()
  {
    // align the test clock with fixture timestamps so availability checks pass
    yield* TestClock.setTime(Date.parse(NOW))
    const delivery = yield* OrchestrationReactorDelivery
    yield* delivery.ensureProgress({
      reactorId,
      operationVersion,
      initialSequence: 0,
      mode,
      now: NOW,
    })
    yield* delivery.setMode({ reactorId, mode, ownerId: 'prestart-owner', now: NOW })
  })

const definition = (
  reactorId: ReactorId,
  execute: DurableReactorDefinition['execute'],
  classify: DurableReactorDefinition['classify'] = () => 'retryable',
): DurableReactorDefinition => ({
  reactorId,
  operationVersion: 1,
  plan: (source) =>
    Effect.succeed([
      {
        outputIndex: 0,
        effectKind: 'test-effect',
        targetKind: 'project',
        targetId: source.aggregateId,
        payloadJson: '{}',
      },
    ]),
  execute,
  classify,
  onLeaseExpiry: 'retryable',
})

describe('DurableReactorRunner', () =>
{
  it.effect('replays while stopped and catches missed wakeups by polling', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const runner = yield* DurableReactorRunner
        const delivery = yield* OrchestrationReactorDelivery
        const feed = yield* TestEventFeed
        const executions = yield* Ref.make<ReadonlyArray<number>>([])
        yield* prepareProgress('thread-deletion', 'durable')
        yield* feed.append(event(1), false)

        yield* runner.start(
          definition('thread-deletion', (action) =>
            Ref.update(executions, (values) => [...values, action.sourceSequence]).pipe(
              Effect.as({ status: 'succeeded' as const }),
            ),
          ),
        )
        assert.deepStrictEqual(yield* Ref.get(executions), [1])
        assert.equal(
          Option.getOrThrow(yield* delivery.getProgress('thread-deletion')).cursorSequence,
          1,
        )

        yield* feed.append(event(2), false)
        // poll interval widened from 500ms to 5s (megacore perf batch)
        yield* TestClock.adjust('5100 millis')
        assert.deepStrictEqual(yield* Ref.get(executions), [1, 2])
        assert.equal(
          Option.getOrThrow(yield* delivery.getProgress('thread-deletion')).cursorSequence,
          2,
        )
      }).pipe(Effect.provide(makeTestLayer())),
    ),
  )

  it.effect('materializes shadow actions without executing and advances only shadow cursor', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const runner = yield* DurableReactorRunner
        const delivery = yield* OrchestrationReactorDelivery
        const feed = yield* TestEventFeed
        const sql = yield* SqlClient.SqlClient
        const executions = yield* Ref.make(0)
        yield* prepareProgress('checkpoint-domain', 'shadow')
        yield* feed.append(event(1), false)

        yield* runner.start(
          definition('checkpoint-domain', () =>
            Ref.update(executions, (count) => count + 1).pipe(
              Effect.as({ status: 'succeeded' as const }),
            ),
          ),
        )
        const progress = Option.getOrThrow(yield* delivery.getProgress('checkpoint-domain'))
        assert.equal(yield* Ref.get(executions), 0)
        assert.equal(progress.cursorSequence, 0)
        assert.equal(progress.shadowCursorSequence, 1)
        const rows = yield* sql<{ readonly status: string }>`
          SELECT status
          FROM orchestration_reactor_actions
          WHERE reactor_id = 'checkpoint-domain'
        `
        assert.deepStrictEqual(rows, [{ status: 'shadow' }])
      }).pipe(Effect.provide(makeTestLayer())),
    ),
  )

  it.effect('converges from all four persisted kill points without duplicate target mutation', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const runner = yield* DurableReactorRunner
        const delivery = yield* OrchestrationReactorDelivery
        const feed = yield* TestEventFeed
        const sql = yield* SqlClient.SqlClient
        yield* prepareProgress('provider-command', 'durable')

        for (let sequence = 1; sequence <= 4; sequence += 1)
        {
          const source = event(sequence)
          yield* feed.append(source, false)
          yield* delivery.materialize({
            reactorId: 'provider-command',
            operationVersion: 1,
            sourceSequence: sequence,
            sourceEventId: source.eventId,
            mode: 'durable',
            actions: [
              {
                outputIndex: 0,
                effectKind: 'test-effect',
                targetKind: 'project',
                targetId: source.aggregateId,
                payloadJson: '{}',
              },
            ],
            now: NOW,
          })
        }

        const actionId = (sequence: number) =>
          makeReactorActionId({
            reactorId: 'provider-command',
            sourceSequence: sequence,
            sourceEventId: `event-${sequence}`,
            outputIndex: 0,
            effectKind: 'test-effect',
            targetKind: 'project',
            targetId: `project-${sequence}`,
            operationVersion: 1,
          })
        yield* sql`
          UPDATE orchestration_reactor_actions
          SET
            status = 'leased',
            attempt_count = 1,
            lease_owner = 'stopped-owner',
            lease_epoch = 1,
            lease_expires_at = '2025-12-31T23:59:00.000Z'
          WHERE source_sequence IN (2, 3)
        `
        yield* sql`
          UPDATE orchestration_reactor_actions
          SET status = 'succeeded', completed_at = ${NOW}
          WHERE source_sequence = 4
        `

        const applied = yield* Ref.make(new Set<string>([actionId(3)]))
        const calls = yield* Ref.make<ReadonlyArray<number>>([])
        yield* runner.start(
          definition('provider-command', (action) =>
            Effect.gen(function* ()
            {
              yield* Ref.update(calls, (values) => [...values, action.sourceSequence])
              yield* Ref.update(applied, (ids) => new Set(ids).add(action.actionId))
              return { status: 'succeeded' as const }
            }),
          ),
        )

        assert.deepStrictEqual(yield* Ref.get(calls), [1, 2, 3])
        assert.equal((yield* Ref.get(applied)).size, 3)
        assert.equal(
          Option.getOrThrow(yield* delivery.getProgress('provider-command')).cursorSequence,
          4,
        )
      }).pipe(Effect.provide(makeTestLayer())),
    ),
  )

  it.effect('keeps poison and attempt-limit manual work visible until retry resolution', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const runner = yield* DurableReactorRunner
        const delivery = yield* OrchestrationReactorDelivery
        const feed = yield* TestEventFeed
        const sql = yield* SqlClient.SqlClient
        const repaired = yield* Ref.make(false)
        const blockedHooks = yield* Ref.make<ReadonlyArray<string>>([])
        yield* prepareProgress('thread-deletion', 'durable')
        yield* feed.append(event(1), false)

        yield* runner.start({
          ...definition(
            'thread-deletion',
            () =>
              Ref.get(repaired).pipe(
                Effect.flatMap((ready) =>
                  ready
                    ? Effect.succeed({ status: 'succeeded' as const })
                    : Effect.fail('poison payload'),
                ),
              ),
            (_cause, action) => (action.sourceSequence === 1 ? 'poison' : 'retryable'),
          ),
          onBlocked: ({ action, status }) =>
            Ref.update(blockedHooks, (values) => [...values, `${action.sourceSequence}:${status}`]),
        })
        const blocked = Option.getOrThrow(yield* delivery.getProgress('thread-deletion'))
        assert.equal(blocked.cursorSequence, 0)
        assert.equal(blocked.blockedSequence, 1)

        const rows = yield* sql<{ readonly actionId: string; readonly status: string }>`
          SELECT action_id AS "actionId", status
          FROM orchestration_reactor_actions
          WHERE reactor_id = 'thread-deletion'
        `
        assert.equal(rows[0]?.status, 'poison')
        assert.deepStrictEqual(yield* Ref.get(blockedHooks), ['1:poison'])
        yield* Ref.set(repaired, true)
        yield* delivery.resolve({
          actionId: rows[0]!.actionId,
          resolution: 'retry',
          operator: 'operator@example.test',
          detail: 'payload repaired',
          now: NOW,
        })
        yield* runner.drainThrough('thread-deletion', 1)
        const recovered = Option.getOrThrow(yield* delivery.getProgress('thread-deletion'))
        assert.equal(recovered.cursorSequence, 1)
        assert.equal(recovered.blockedSequence, null)

        yield* Ref.set(repaired, false)
        yield* feed.append(event(2), false)
        yield* delivery.materialize({
          reactorId: 'thread-deletion',
          operationVersion: 1,
          sourceSequence: 2,
          sourceEventId: EventId.make('event-2'),
          mode: 'durable',
          actions: [
            {
              outputIndex: 0,
              effectKind: 'test-effect',
              targetKind: 'project',
              targetId: ProjectId.make('project-2'),
              payloadJson: '{}',
            },
          ],
          now: NOW,
        })
        yield* sql`
          UPDATE orchestration_reactor_actions
          SET attempt_count = 7
          WHERE reactor_id = 'thread-deletion' AND source_sequence = 2
        `
        const fenceFailure = yield* Effect.flip(runner.drainThrough('thread-deletion', 2))
        const manualRows = yield* sql<{ readonly actionId: string; readonly status: string }>`
          SELECT action_id AS "actionId", status
          FROM orchestration_reactor_actions
          WHERE reactor_id = 'thread-deletion' AND source_sequence = 2
        `
        assert.equal(manualRows[0]?.status, 'manual')
        assert.match(fenceFailure.operation, /blockedBeforeSequence:thread-deletion:1:2/)
        assert.deepStrictEqual(yield* Ref.get(blockedHooks), ['1:poison', '2:manual'])
        assert.equal(
          Option.getOrThrow(yield* delivery.getProgress('thread-deletion')).blockedSequence,
          2,
        )

        yield* Ref.set(repaired, true)
        yield* delivery.resolve({
          actionId: manualRows[0]!.actionId,
          resolution: 'retry',
          operator: 'operator@example.test',
          detail: 'dependency repaired after attempt limit',
          now: NOW,
        })
        yield* runner.drainThrough('thread-deletion', 2)
        assert.equal(
          Option.getOrThrow(yield* delivery.getProgress('thread-deletion')).cursorSequence,
          2,
        )
      }).pipe(Effect.provide(makeTestLayer())),
    ),
  )

  it.effect('interrupts execution when lease renewal loses ownership', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const runner = yield* DurableReactorRunner
        const feed = yield* TestEventFeed
        const sql = yield* SqlClient.SqlClient
        const executionStarted = yield* Deferred.make<void>()
        const executionFinalized = yield* Ref.make(false)
        const staleCommit = yield* Ref.make(false)
        yield* prepareProgress('provider-command', 'durable')
        yield* feed.append(event(1), false)

        const startFiber = yield* runner
          .start(
            definition('provider-command', () =>
              Deferred.succeed(executionStarted, undefined).pipe(
                Effect.andThen(Effect.sleep('20 seconds')),
                Effect.andThen(Ref.set(staleCommit, true)),
                Effect.as({ status: 'succeeded' as const }),
                Effect.ensuring(Ref.set(executionFinalized, true)),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(executionStarted)
        yield* sql`
          UPDATE orchestration_reactor_actions
          SET lease_owner = 'replacement-owner'
          WHERE reactor_id = 'provider-command' AND source_sequence = 1
        `

        yield* TestClock.adjust('10 seconds')
        yield* Fiber.await(startFiber)
        assert.equal(yield* Ref.get(executionFinalized), true)
        assert.equal(yield* Ref.get(staleCommit), false)
        const rows = yield* sql<{
          readonly status: string
          readonly completedAt: string | null
        }>`
          SELECT status, completed_at AS "completedAt"
          FROM orchestration_reactor_actions
          WHERE reactor_id = 'provider-command' AND source_sequence = 1
        `
        assert.deepStrictEqual(rows, [{ status: 'leased', completedAt: null }])
      }).pipe(Effect.provide(makeTestLayer())),
    ),
  )
})
