// tests/apps/server/orchestration/Layers/ProviderRuntimeInboxRunner.test.ts
// verifies independent durable provider consumers, restart checkpoints, and drain fencing

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from 'node:crypto'

import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'
import { stableStringify } from '@t3tools/shared/relaySigning'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { ProviderRuntimeInboxRunnerLive } from '../../../../../apps/server/src/orchestration/Layers/ProviderRuntimeInboxRunner.ts'
import { PersistenceSqlError } from '../../../../../apps/server/src/persistence/Errors.ts'
import {
  PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
  PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
  ProviderRuntimeInboxRunner,
  type ProviderRuntimeInboxConsumerDefinition,
} from '../../../../../apps/server/src/orchestration/Services/ProviderRuntimeInboxRunner.ts'
import { OrchestrationReactorDeliveryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationReactorDelivery.ts'
import { ProviderRuntimeInboxLive } from '../../../../../apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { OrchestrationReactorDelivery } from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import { ProviderRuntimeInbox } from '../../../../../apps/server/src/persistence/Services/ProviderRuntimeInbox.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const providerInstanceId = ProviderInstanceId.make('codex')
const threadId = ThreadId.make('thread-provider-runtime-runner')

interface CompletionFault
{
  readonly sequence: number
  failuresRemaining: number
}

class ProviderRuntimeInboxRunnerTestError extends Schema.TaggedErrorClass<ProviderRuntimeInboxRunnerTestError>()(
  'ProviderRuntimeInboxRunnerTestError',
  { detail: Schema.String },
)
{
  override get message(): string
  {
    return this.detail
  }
}

const decodeSequenceState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Number)),
)
const encodeSequenceState = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Number)))

const makeLayer = (completionFault?: CompletionFault) =>
{
  const sqlite = Layer.fresh(SqlitePersistenceMemory)
  const basePersistence = Layer.merge(
    ProviderRuntimeInboxLive,
    OrchestrationReactorDeliveryLive,
  ).pipe(Layer.provideMerge(sqlite))
  const persistence =
    completionFault === undefined
      ? basePersistence
      : Layer.merge(
          basePersistence,
          Layer.effect(
            ProviderRuntimeInbox,
            Effect.gen(function* ()
              {
              const live = yield* ProviderRuntimeInbox
              return ProviderRuntimeInbox.of({
                ...live,
                completeConsumerEvent: (input) =>
                  {
                  if (
                    input.record.sequence === completionFault.sequence &&
                    completionFault.failuresRemaining > 0
                  )
                    {
                    completionFault.failuresRemaining -= 1
                    return Effect.fail(
                      new PersistenceSqlError({
                        operation: 'ProviderRuntimeInboxRunner.test.completeConsumerEvent',
                      }),
                    )
                  }
                  return live.completeConsumerEvent(input)
                },
              })
            }),
          ).pipe(Layer.provide(basePersistence)),
        )
  const runner = ProviderRuntimeInboxRunnerLive.pipe(Layer.provide(persistence))
  return Layer.merge(persistence, runner).pipe(Layer.provideMerge(NodeServices.layer))
}

const startedEvent = (eventId: string): ProviderRuntimeEvent => ({
  type: 'session.started',
  eventId: EventId.make(eventId),
  provider: ProviderDriverKind.make('codex'),
  providerInstanceId,
  threadId,
  createdAt: NOW,
  payload: {},
})

const exitedEvent = (eventId: string): ProviderRuntimeEvent => ({
  type: 'session.exited',
  eventId: EventId.make(eventId),
  provider: ProviderDriverKind.make('codex'),
  providerInstanceId,
  threadId,
  createdAt: '2026-01-01T00:00:01.000Z',
  payload: {
    reason: 'test provider stopped',
    recoverable: false,
    exitKind: 'graceful',
  },
})

const makeAdmission = Effect.gen(function* ()
{
  const inbox = yield* ProviderRuntimeInbox
  const owner = yield* inbox.claimAdmissionOwner({ ownerId: 'runner-test-owner', now: NOW })
  let session: { readonly generation: number; closed: boolean } | undefined
  const append = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* ()
    {
      if (session === undefined || (session.closed && event.type === 'session.started'))
      {
        const started = yield* inbox.beginSession({
          ownerId: 'runner-test-owner',
          ownerGeneration: owner.ownerGeneration,
          provider: event.provider,
          providerInstanceId,
          threadId: event.threadId,
          now: event.createdAt,
        })
        session = { generation: started.sessionGeneration, closed: false }
      }
      const eventJson = stableStringify(event)
      const appended = yield* inbox.append({
        ownerId: 'runner-test-owner',
        ownerGeneration: owner.ownerGeneration,
        provider: event.provider,
        providerInstanceId,
        threadId: event.threadId,
        sessionGeneration: session.generation,
        sourceEventId: event.eventId,
        eventType: event.type,
        eventCreatedAt: event.createdAt,
        receivedAt: event.createdAt,
        eventJson,
        eventDigest: NodeCrypto.createHash('sha256').update(eventJson).digest('hex'),
      })
      if (event.type === 'session.exited')
      {
        session.closed = true
      }
      return appended
    })
  return { append }
})

const definition = (
  consumerId: ProviderRuntimeInboxConsumerDefinition['consumerId'],
  process: ProviderRuntimeInboxConsumerDefinition['process'],
  restore: ProviderRuntimeInboxConsumerDefinition['restore'] = () => Effect.void,
  classify: ProviderRuntimeInboxConsumerDefinition['classify'] = () => 'manual',
): ProviderRuntimeInboxConsumerDefinition => ({
  consumerId,
  operationVersion: 1,
  process,
  restore,
  classify,
})

it.effect('restores the versioned buffer before replay and does not repeat completed work', () =>
  Effect.gen(function* ()
  {
    yield* TestClock.setTime(Date.parse(NOW))
    const runner = yield* ProviderRuntimeInboxRunner
    const delivery = yield* OrchestrationReactorDelivery
    const admission = yield* makeAdmission
    yield* admission.append(startedEvent('event-buffer-restart'))

    const processed = yield* Ref.make(0)
    const restored = yield* Ref.make<ReadonlyArray<number | null>>([])
    const consumer = definition(
      PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
      (record) =>
        Ref.update(processed, (count) => count + 1).pipe(
          Effect.as({
            stateVersion: 1,
            stateJson: JSON.stringify({ throughSequence: record.sequence }),
            sessionBufferTerminal: false,
          }),
        ),
      (checkpoint) =>
        Ref.update(restored, (values) => [
          ...values,
          Option.match(checkpoint, {
            onNone: () => null,
            onSome: (value) => value.throughSequence,
          }),
        ]),
    )

    yield* Effect.scoped(runner.start(consumer))
    assert.equal(
      Option.getOrThrow(yield* delivery.getProgress(PROVIDER_RUNTIME_INGESTION_REACTOR_ID))
        .cursorSequence,
      1,
    )
    yield* Effect.scoped(runner.start(consumer))

    assert.equal(yield* Ref.get(processed), 1)
    assert.deepStrictEqual(yield* Ref.get(restored), [null, 1])
  }).pipe(Effect.provide(makeLayer())),
)

it.effect('restores speculative buffer state when durable completion fails before retry', () =>
  Effect.gen(function* ()
  {
    yield* TestClock.setTime(Date.parse(NOW))
    const runner = yield* ProviderRuntimeInboxRunner
    const delivery = yield* OrchestrationReactorDelivery
    const admission = yield* makeAdmission
    const state = yield* Ref.make<ReadonlyArray<number>>([])
    const sequenceTwoRuns = yield* Ref.make(0)
    const consumer = definition(
      PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
      (record) =>
        Effect.gen(function* ()
        {
          if (record.sequence === 2)
          {
            yield* Ref.update(sequenceTwoRuns, (count) => count + 1)
          }
          const next = [...(yield* Ref.get(state)), record.sequence]
          yield* Ref.set(state, next)
          return {
            stateVersion: 1,
            stateJson: encodeSequenceState(next),
            sessionBufferTerminal: false,
          }
        }),
      (checkpoint) =>
        Option.match(checkpoint, {
          onNone: () => Effect.succeed([] as ReadonlyArray<number>),
          onSome: (value) => decodeSequenceState(value.stateJson),
        }).pipe(Effect.flatMap((restoredState) => Ref.set(state, restoredState))),
    )

    yield* admission.append(startedEvent('event-completion-one'))
    yield* Effect.scoped(runner.start(consumer))
    yield* admission.append(startedEvent('event-completion-two'))

    const failedStart = yield* Effect.exit(Effect.scoped(runner.start(consumer)))
    assert.equal(Exit.isFailure(failedStart), true)
    assert.deepStrictEqual(yield* Ref.get(state), [1])

    yield* TestClock.setTime(Date.parse(NOW) + 60_000)
    yield* Effect.scoped(runner.start(consumer))

    assert.deepStrictEqual(yield* Ref.get(state), [1, 2])
    assert.equal(yield* Ref.get(sequenceTwoRuns), 2)
    assert.equal(
      Option.getOrThrow(yield* delivery.getProgress(PROVIDER_RUNTIME_INGESTION_REACTOR_ID))
        .cursorSequence,
      2,
    )
  }).pipe(
    Effect.provide(
      makeLayer({
        sequence: 2,
        failuresRemaining: 1,
      }),
    ),
  ),
)

it.effect('fails drainThrough when a manual consumer blocks before the requested high-water', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(Date.parse(NOW))
      const runner = yield* ProviderRuntimeInboxRunner
      const delivery = yield* OrchestrationReactorDelivery
      const sql = yield* SqlClient.SqlClient
      const admission = yield* makeAdmission
      const admitted = yield* admission.append(startedEvent('event-manual-block'))

      yield* runner.start(
        definition(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID, () =>
          Effect.fail(
            new ProviderRuntimeInboxRunnerTestError({
              detail: 'deterministic checkpoint failure',
            }),
          ),
        ),
      )
      const drainFailure = yield* Effect.flip(
        runner.drainThrough(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID, admitted.record.sequence),
      )
      const progress = Option.getOrThrow(
        yield* delivery.getProgress(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID),
      )
      const actions = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM orchestration_reactor_actions
        WHERE reactor_id = 'provider-runtime-checkpoint'
      `

      assert.match(drainFailure.operation, /blockedBeforeHighWater/)
      assert.equal(progress.cursorSequence, 0)
      assert.equal(progress.blockedSequence, 1)
      assert.deepStrictEqual(actions, [{ status: 'manual' }])
    }).pipe(Effect.provide(makeLayer())),
  ),
)

it.effect('prunes terminal event payload only after both durable consumers complete it', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      yield* TestClock.setTime(Date.parse(NOW))
      const runner = yield* ProviderRuntimeInboxRunner
      const delivery = yield* OrchestrationReactorDelivery
      const inbox = yield* ProviderRuntimeInbox
      const sql = yield* SqlClient.SqlClient
      const admission = yield* makeAdmission
      yield* admission.append(startedEvent('event-prune-started'))
      const terminal = yield* admission.append(exitedEvent('event-prune-exited'))
      assert.deepStrictEqual(yield* inbox.getDiagnostics, {
        admissionMode: 'required',
        lastSequence: 2,
        retainedRecordCount: 2,
        backlogCount: 2,
        oldestPendingReceivedAt: NOW,
        consumers: [
          {
            consumerId: PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
            cursorSequence: 0,
            lag: 2,
          },
          {
            consumerId: PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
            cursorSequence: 0,
            lag: 2,
          },
        ],
      })
      yield* TestClock.setTime(Date.parse('2026-01-10T00:00:00.000Z'))
      const consumer = (consumerId: ProviderRuntimeInboxConsumerDefinition['consumerId']) =>
        definition(consumerId, (record, event) =>
          Effect.succeed({
            stateVersion: 1,
            stateJson: JSON.stringify({ throughSequence: record.sequence }),
            sessionBufferTerminal: event.type === 'session.exited',
          }),
        )

      yield* runner.start(consumer(PROVIDER_RUNTIME_INGESTION_REACTOR_ID))
      const beforeCheckpoint = yield* inbox.pruneCompleted({
        completedBefore: '2026-01-08T00:00:00.000Z',
        now: '2026-01-10T00:00:00.000Z',
      })
      assert.equal(beforeCheckpoint, 0)
      assert.equal(
        Option.getOrThrow(yield* delivery.getProgress(PROVIDER_RUNTIME_INGESTION_REACTOR_ID))
          .cursorSequence,
        terminal.record.sequence,
      )
      assert.equal(
        Option.isNone(yield* delivery.getProgress(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID)),
        true,
      )
      assert.deepStrictEqual(yield* inbox.getDiagnostics, {
        admissionMode: 'required',
        lastSequence: 2,
        retainedRecordCount: 2,
        backlogCount: 2,
        oldestPendingReceivedAt: NOW,
        consumers: [
          {
            consumerId: PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
            cursorSequence: 2,
            lag: 0,
          },
          {
            consumerId: PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
            cursorSequence: 0,
            lag: 2,
          },
        ],
      })

      yield* runner.start(consumer(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID))
      const beforeRetention = yield* inbox.pruneCompleted({
        completedBefore: '2026-01-08T00:00:00.000Z',
        now: '2026-01-10T00:00:00.000Z',
      })

      assert.equal(beforeRetention, 0)
      assert.deepStrictEqual(yield* inbox.getDiagnostics, {
        admissionMode: 'required',
        lastSequence: 2,
        retainedRecordCount: 2,
        backlogCount: 0,
        oldestPendingReceivedAt: null,
        consumers: [
          {
            consumerId: PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
            cursorSequence: 2,
            lag: 0,
          },
          {
            consumerId: PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
            cursorSequence: 2,
            lag: 0,
          },
        ],
      })
      const afterRetention = yield* inbox.pruneCompleted({
        completedBefore: '2026-01-18T00:00:00.000Z',
        now: '2026-01-18T00:00:00.000Z',
      })
      assert.equal(afterRetention, 2)
      assert.equal(Option.isNone(yield* inbox.get(terminal.record.sequence)), true)
      assert.deepStrictEqual(
        yield* sql<{ readonly sessionCount: number; readonly consumerSessionCount: number }>`
          SELECT
            (SELECT COUNT(*) FROM provider_runtime_inbox_sessions) AS "sessionCount",
            (
              SELECT COUNT(*)
              FROM provider_runtime_inbox_consumer_sessions
            ) AS "consumerSessionCount"
        `,
        [{ sessionCount: 1, consumerSessionCount: 0 }],
      )
      assert.equal((yield* inbox.getDiagnostics).retainedRecordCount, 0)
      assert.equal(
        Option.getOrThrow(yield* delivery.getProgress(PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID))
          .cursorSequence,
        terminal.record.sequence,
      )
      const restarted = yield* admission.append(startedEvent('event-prune-restarted'))
      assert.equal(restarted.record.sessionGeneration, terminal.record.sessionGeneration + 1)
    }).pipe(Effect.provide(makeLayer())),
  ),
)
