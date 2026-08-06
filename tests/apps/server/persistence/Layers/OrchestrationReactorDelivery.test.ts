// tests/apps/server/persistence/Layers/OrchestrationReactorDelivery.test.ts
// verifies durable reactor action identity, ordering, fencing, and recovery

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { OrchestrationReactorDeliveryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationReactorDelivery.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import {
  makeReactorActionId,
  OrchestrationReactorDelivery,
  type ReactorActionDraft,
} from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-01T00:01:00.000Z'

const layer = it.layer(
  OrchestrationReactorDeliveryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
)

const draft = (outputIndex: number, targetId: string): ReactorActionDraft => ({
  outputIndex,
  effectKind: 'cleanup',
  targetKind: 'thread',
  targetId,
  payloadJson: '{}',
})

layer('OrchestrationReactorDelivery', (it) =>
{
  it.effect('uses a collision-safe canonical identity and idempotent materialization', () =>
    Effect.gen(function* ()
    {
      const delivery = yield* OrchestrationReactorDelivery
      const sql = yield* SqlClient.SqlClient
      yield* delivery.ensureProgress({
        reactorId: 'thread-deletion',
        operationVersion: 3,
        initialSequence: 0,
        mode: 'shadow',
        now: NOW,
      })

      const left = makeReactorActionId({
        reactorId: 'thread-deletion',
        sourceSequence: 1,
        sourceEventId: 'ignored-by-canonical-id',
        outputIndex: 0,
        effectKind: 'a|b',
        targetKind: 'c',
        targetId: 'd"]|[e',
        operationVersion: 3,
      })
      const right = makeReactorActionId({
        reactorId: 'thread-deletion',
        sourceSequence: 1,
        sourceEventId: 'different-event-id',
        outputIndex: 0,
        effectKind: 'a',
        targetKind: 'b|c',
        targetId: 'd"]|[e',
        operationVersion: 3,
      })
      assert.notEqual(left, right)

      const input = {
        reactorId: 'thread-deletion' as const,
        operationVersion: 3,
        sourceSequence: 1,
        sourceEventId: 'event-1',
        mode: 'shadow' as const,
        actions: [draft(0, 'thread|one'), draft(1, 'thread"]two')],
        now: NOW,
      }
      yield* delivery.materialize(input)
      yield* delivery.materialize(input)

      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM orchestration_reactor_actions
      `
      assert.deepStrictEqual(rows, [{ status: 'shadow' }, { status: 'shadow' }])
      const progress = yield* delivery.getProgress('thread-deletion')
      assert.equal(Option.getOrThrow(progress).shadowCursorSequence, 1)
      const promoted = yield* delivery.setMode({
        reactorId: 'thread-deletion',
        mode: 'durable',
        highWaterSequence: 5,
        ownerId: 'owner-a',
        now: NOW,
      })
      assert.equal(promoted.cursorSequence, 1)
      assert.equal(promoted.highWaterSequence, 5)
      assert.ok(
        Option.isNone(
          yield* delivery.claimNext({
            reactorId: 'thread-deletion',
            ownerId: 'owner-a',
            leaseDurationMs: 30_000,
            now: NOW,
          }),
        ),
      )
    }),
  )

  it.effect('claims strict FIFO and blocks later sequences behind unknown work', () =>
    Effect.gen(function* ()
    {
      const delivery = yield* OrchestrationReactorDelivery
      yield* delivery.ensureProgress({
        reactorId: 'checkpoint-domain',
        operationVersion: 1,
        initialSequence: 0,
        mode: 'durable',
        now: NOW,
      })
      yield* delivery.setMode({
        reactorId: 'checkpoint-domain',
        mode: 'durable',
        ownerId: 'owner-a',
        now: NOW,
      })
      yield* delivery.materialize({
        reactorId: 'checkpoint-domain',
        operationVersion: 1,
        sourceSequence: 1,
        sourceEventId: 'event-1',
        mode: 'durable',
        actions: [draft(1, 'second'), draft(0, 'first')],
        now: NOW,
      })
      yield* delivery.materialize({
        reactorId: 'checkpoint-domain',
        operationVersion: 1,
        sourceSequence: 2,
        sourceEventId: 'event-2',
        mode: 'durable',
        actions: [draft(0, 'later-sequence')],
        now: NOW,
      })

      const first = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'checkpoint-domain',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: NOW,
        }),
      )
      assert.equal(first.outputIndex, 0)
      assert.equal(
        yield* delivery.recordOutcome({
          actionId: first.actionId,
          ownerId: 'owner-a',
          leaseEpoch: Option.getOrThrow(Option.fromNullOr(first.leaseEpoch)),
          status: 'succeeded',
          now: NOW,
        }),
        true,
      )

      const second = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'checkpoint-domain',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: NOW,
        }),
      )
      assert.equal(second.outputIndex, 1)
      yield* delivery.recordOutcome({
        actionId: second.actionId,
        ownerId: 'owner-a',
        leaseEpoch: Option.getOrThrow(Option.fromNullOr(second.leaseEpoch)),
        status: 'unknown',
        error: 'external outcome unavailable',
        now: NOW,
      })
      assert.ok(
        Option.isNone(
          yield* delivery.claimNext({
            reactorId: 'checkpoint-domain',
            ownerId: 'owner-a',
            leaseDurationMs: 30_000,
            now: NOW,
          }),
        ),
      )
      assert.equal(
        Option.getOrThrow(yield* delivery.getProgress('checkpoint-domain')).blockedSequence,
        1,
      )

      yield* delivery.resolve({
        actionId: second.actionId,
        resolution: 'skip',
        operator: 'operator@example.test',
        detail: 'verified no external mutation',
        now: LATER,
      })
      assert.equal(
        yield* delivery.advanceCursor({
          reactorId: 'checkpoint-domain',
          sourceSequence: 2,
          expectedPreviousSequence: 0,
          now: LATER,
        }),
        false,
      )
      assert.equal(
        yield* delivery.advanceCursor({
          reactorId: 'checkpoint-domain',
          sourceSequence: 1,
          expectedPreviousSequence: 0,
          now: LATER,
        }),
        true,
      )
      const third = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'checkpoint-domain',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: LATER,
        }),
      )
      assert.equal(third.sourceSequence, 2)
    }),
  )

  it.effect('fences stale leases and recovers expiry according to policy', () =>
    Effect.gen(function* ()
    {
      const delivery = yield* OrchestrationReactorDelivery
      yield* delivery.ensureProgress({
        reactorId: 'provider-command',
        operationVersion: 1,
        initialSequence: 0,
        mode: 'durable',
        now: NOW,
      })
      const firstOwner = yield* delivery.setMode({
        reactorId: 'provider-command',
        mode: 'durable',
        ownerId: 'owner-a',
        now: NOW,
      })
      yield* delivery.materialize({
        reactorId: 'provider-command',
        operationVersion: 1,
        sourceSequence: 1,
        sourceEventId: 'event-1',
        mode: 'durable',
        actions: [draft(0, 'command-1')],
        now: NOW,
      })
      const action = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'provider-command',
          ownerId: 'owner-a',
          leaseDurationMs: 1_000,
          now: NOW,
        }),
      )
      const leaseEpoch = Option.getOrThrow(Option.fromNullOr(action.leaseEpoch))
      assert.equal(
        yield* delivery.renewLease({
          actionId: action.actionId,
          ownerId: 'wrong-owner',
          leaseEpoch,
          leaseDurationMs: 30_000,
          now: NOW,
        }),
        false,
      )
      assert.equal(
        yield* delivery.renewLease({
          actionId: action.actionId,
          ownerId: 'owner-a',
          leaseEpoch,
          leaseDurationMs: 1_000,
          now: NOW,
        }),
        true,
      )

      const secondOwner = yield* delivery.setMode({
        reactorId: 'provider-command',
        mode: 'durable',
        ownerId: 'owner-b',
        now: NOW,
      })
      assert.equal(secondOwner.ownerEpoch, firstOwner.ownerEpoch + 1)
      assert.equal(
        yield* delivery.recordOutcome({
          actionId: action.actionId,
          ownerId: 'owner-a',
          leaseEpoch,
          status: 'succeeded',
          now: NOW,
        }),
        false,
      )
      assert.equal(
        yield* delivery.advanceCursor({
          reactorId: 'provider-command',
          sourceSequence: 1,
          expectedPreviousSequence: 0,
          now: NOW,
        }),
        false,
      )
      assert.equal(
        yield* delivery.recoverExpiredLeases({
          reactorId: 'provider-command',
          ownerId: 'owner-b',
          policy: 'retryable',
          now: LATER,
        }),
        1,
      )
      const reclaimed = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'provider-command',
          ownerId: 'owner-b',
          leaseDurationMs: 30_000,
          now: LATER,
        }),
      )
      assert.equal(reclaimed.attemptCount, 2)
      assert.ok(Option.getOrThrow(Option.fromNullOr(reclaimed.leaseEpoch)) > leaseEpoch)

      yield* delivery.recordOutcome({
        actionId: reclaimed.actionId,
        ownerId: 'owner-b',
        leaseEpoch: Option.getOrThrow(Option.fromNullOr(reclaimed.leaseEpoch)),
        status: 'succeeded',
        now: LATER,
      })
      yield* delivery.advanceCursor({
        reactorId: 'provider-command',
        sourceSequence: 1,
        expectedPreviousSequence: 0,
        now: LATER,
      })
      yield* delivery.materialize({
        reactorId: 'provider-command',
        operationVersion: 1,
        sourceSequence: 2,
        sourceEventId: 'event-2',
        mode: 'durable',
        actions: [draft(0, 'command-2')],
        now: LATER,
      })
      const secondLease = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'provider-command',
          ownerId: 'owner-b',
          leaseDurationMs: 1,
          now: LATER,
        }),
      )
      assert.equal(
        yield* delivery.recoverExpiredLeases({
          reactorId: 'provider-command',
          ownerId: 'owner-b',
          policy: 'unknown',
          now: '2026-01-01T00:01:01.000Z',
        }),
        1,
      )
      assert.equal(
        Option.getOrThrow(yield* delivery.getProgress('provider-command')).blockedSequence,
        secondLease.sourceSequence,
      )
    }),
  )

  it.effect('honors retry availability and audits resolution and mode transitions', () =>
    Effect.gen(function* ()
    {
      const delivery = yield* OrchestrationReactorDelivery
      const sql = yield* SqlClient.SqlClient
      yield* delivery.ensureProgress({
        reactorId: 'thread-deletion',
        operationVersion: 1,
        initialSequence: 0,
        mode: 'durable',
        now: NOW,
      })
      yield* delivery.setMode({
        reactorId: 'thread-deletion',
        mode: 'durable',
        ownerId: 'owner-a',
        now: NOW,
      })
      yield* delivery.materialize({
        reactorId: 'thread-deletion',
        operationVersion: 1,
        sourceSequence: 4,
        sourceEventId: 'event-1',
        mode: 'durable',
        actions: [draft(0, 'thread-1')],
        now: NOW,
      })
      const action = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'thread-deletion',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: NOW,
        }),
      )
      yield* delivery.recordOutcome({
        actionId: action.actionId,
        ownerId: 'owner-a',
        leaseEpoch: Option.getOrThrow(Option.fromNullOr(action.leaseEpoch)),
        status: 'retryable',
        error: 'temporary failure',
        nextAttemptAt: LATER,
        now: NOW,
      })
      assert.ok(
        Option.isNone(
          yield* delivery.claimNext({
            reactorId: 'thread-deletion',
            ownerId: 'owner-a',
            leaseDurationMs: 30_000,
            now: '2026-01-01T00:00:30.000Z',
          }),
        ),
      )
      const retry = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'thread-deletion',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: LATER,
        }),
      )
      yield* delivery.recordOutcome({
        actionId: retry.actionId,
        ownerId: 'owner-a',
        leaseEpoch: Option.getOrThrow(Option.fromNullOr(retry.leaseEpoch)),
        status: 'manual',
        error: 'attempt limit reached',
        now: LATER,
      })
      yield* delivery.resolve({
        actionId: retry.actionId,
        resolution: 'retry',
        operator: 'operator@example.test',
        detail: 'dependency repaired',
        now: LATER,
      })

      const audit = yield* sql<{
        readonly status: string
        readonly resolvedBy: string | null
        readonly resolution: string | null
      }>`
        SELECT
          status,
          resolved_by AS "resolvedBy",
          resolution
        FROM orchestration_reactor_actions
        WHERE action_id = ${retry.actionId}
      `
      assert.deepStrictEqual(audit, [
        {
          status: 'pending',
          resolvedBy: 'operator@example.test',
          resolution: 'retry: dependency repaired',
        },
      ])

      const paused = yield* delivery.setMode({
        reactorId: 'thread-deletion',
        mode: 'paused',
        highWaterSequence: 7,
        ownerId: 'owner-a',
        now: LATER,
      })
      assert.equal(paused.mode, 'paused')
      assert.equal(paused.highWaterSequence, 7)
      assert.ok(
        Option.isNone(
          yield* delivery.claimNext({
            reactorId: 'thread-deletion',
            ownerId: 'owner-a',
            leaseDurationMs: 30_000,
            now: LATER,
          }),
        ),
      )
    }),
  )

  it.effect('lets provider-switch compensation resolve a failed action and unblock its lane', () =>
    Effect.gen(function* ()
    {
      const delivery = yield* OrchestrationReactorDelivery
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        DELETE FROM orchestration_reactor_actions
        WHERE reactor_id = 'provider-command'
      `
      yield* sql`
        DELETE FROM orchestration_reactor_progress
        WHERE reactor_id = 'provider-command'
      `
      yield* delivery.ensureProgress({
        reactorId: 'provider-command',
        operationVersion: 1,
        initialSequence: 0,
        mode: 'durable',
        now: NOW,
      })
      yield* delivery.setMode({
        reactorId: 'provider-command',
        mode: 'durable',
        ownerId: 'owner-a',
        now: NOW,
      })
      yield* delivery.materialize({
        reactorId: 'provider-command',
        operationVersion: 1,
        sourceSequence: 1,
        sourceEventId: 'switch-request-1',
        mode: 'durable',
        actions: [
          {
            outputIndex: 0,
            effectKind: 'thread.provider-switch-requested',
            targetKind: 'thread',
            targetId: 'thread-1',
            payloadJson: '{}',
          },
          {
            outputIndex: 1,
            effectKind: 'thread.provider.switch.compensate',
            targetKind: 'thread',
            targetId: 'thread-1',
            payloadJson: '{}',
          },
        ],
        now: NOW,
      })
      yield* delivery.materialize({
        reactorId: 'provider-command',
        operationVersion: 1,
        sourceSequence: 2,
        sourceEventId: 'event-2',
        mode: 'durable',
        actions: [draft(0, 'later-thread')],
        now: NOW,
      })

      const primary = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'provider-command',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: NOW,
        }),
      )
      yield* delivery.recordOutcome({
        actionId: primary.actionId,
        ownerId: 'owner-a',
        leaseEpoch: Option.getOrThrow(Option.fromNullOr(primary.leaseEpoch)),
        status: 'unknown',
        error: 'provider outcome unavailable',
        now: NOW,
      })

      const switchRows = yield* sql<{
        readonly outputIndex: number
        readonly effectKind: string
        readonly status: string
      }>`
        SELECT
          output_index AS "outputIndex",
          effect_kind AS "effectKind",
          status
        FROM orchestration_reactor_actions
        WHERE reactor_id = 'provider-command' AND source_event_id = 'switch-request-1'
        ORDER BY output_index
      `
      assert.deepStrictEqual(switchRows, [
        {
          outputIndex: 0,
          effectKind: 'thread.provider-switch-requested',
          status: 'unknown',
        },
        {
          outputIndex: 1,
          effectKind: 'thread.provider.switch.compensate',
          status: 'pending',
        },
      ])

      const compensation = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'provider-command',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: NOW,
        }),
      )
      assert.equal(compensation.effectKind, 'thread.provider.switch.compensate')
      yield* delivery.recordOutcome({
        actionId: compensation.actionId,
        ownerId: 'owner-a',
        leaseEpoch: Option.getOrThrow(Option.fromNullOr(compensation.leaseEpoch)),
        status: 'succeeded',
        now: NOW,
      })
      assert.equal(
        yield* delivery.skipStale({
          actionId: primary.actionId,
          sourceEventId: 'switch-request-1',
          operator: 'startup-reconciliation',
          detail: 'matching switch marker was terminalized',
          now: LATER,
        }),
        true,
      )
      assert.equal(
        yield* delivery.advanceCursor({
          reactorId: 'provider-command',
          sourceSequence: 1,
          expectedPreviousSequence: 0,
          now: LATER,
        }),
        true,
      )
      const later = Option.getOrThrow(
        yield* delivery.claimNext({
          reactorId: 'provider-command',
          ownerId: 'owner-a',
          leaseDurationMs: 30_000,
          now: LATER,
        }),
      )
      assert.equal(later.sourceSequence, 2)
    }),
  )
})
