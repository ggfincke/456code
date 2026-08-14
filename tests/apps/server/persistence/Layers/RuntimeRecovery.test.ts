// tests/apps/server/persistence/Layers/RuntimeRecovery.test.ts
// verifies optimistic recovery transitions and atomic immutable audit insertion

import { assert, it } from '@effect/vitest'
import { RuntimeRecoveryReactorAuditState } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { RuntimeRecoveryPersistenceLive } from '../../../../../apps/server/src/persistence/Layers/RuntimeRecovery.ts'
import Migration045 from '../../../../../apps/server/src/persistence/Migrations/045_OrchestrationReactorDelivery.ts'
import Migration048 from '../../../../../apps/server/src/persistence/Migrations/048_CheckpointRevertOperations.ts'
import Migration060 from '../../../../../apps/server/src/persistence/Migrations/060_RuntimeRecoveryAudit.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'
import { RuntimeRecoveryPersistence } from '../../../../../apps/server/src/persistence/Services/RuntimeRecovery.ts'

const databaseLayer = NodeSqliteClient.layerMemory()
const persistenceLayer = Layer.mergeAll(
  RuntimeRecoveryPersistenceLive,
  Layer.effectDiscard(Migration045),
  Layer.effectDiscard(Migration048),
  Layer.effectDiscard(Migration060),
).pipe(Layer.provideMerge(databaseLayer))
const layer = it.layer(persistenceLayer)

const originalAt = '2026-08-09T00:00:00.000Z'
const recoveredAt = '2026-08-09T00:01:00.000Z'
const decodeReactorAuditState = Schema.decodeUnknownSync(
  Schema.fromJsonString(RuntimeRecoveryReactorAuditState),
)

const insertProgress = (sql: SqlClient.SqlClient, reactorId: string) => sql`
  INSERT INTO orchestration_reactor_progress (
    reactor_id,
    operation_version,
    mode,
    cursor_sequence,
    shadow_cursor_sequence,
    blocked_sequence,
    last_error,
    updated_at
  )
  VALUES (${reactorId}, 1, 'durable', 0, 0, 1, 'stale lane error', ${originalAt})
`

const insertAction = (
  sql: SqlClient.SqlClient,
  input: {
    readonly actionId: string
    readonly reactorId: string
    readonly sourceSequence: number
    readonly outputIndex?: number
    readonly effectKind: string
    readonly status: 'pending' | 'unknown' | 'manual'
  },
) => sql`
  INSERT INTO orchestration_reactor_actions (
    action_id,
    reactor_id,
    source_sequence,
    source_event_id,
    output_index,
    effect_kind,
    target_kind,
    target_id,
    operation_version,
    payload_json,
    status,
    available_at,
    last_error,
    created_at,
    updated_at
  )
  VALUES (
    ${input.actionId},
    ${input.reactorId},
    ${input.sourceSequence},
    ${`event-${input.actionId}`},
    ${input.outputIndex ?? 0},
    ${input.effectKind},
    'thread-turn-checkpoint',
    ${`target-${input.actionId}`},
    1,
    '{"secret":"never-return-this"}',
    ${input.status},
    ${originalAt},
    'sensitive failure detail',
    ${originalAt},
    ${originalAt}
  )
`

layer('RuntimeRecoveryPersistence', (it) =>
{
  it.effect(
    'atomically retries matching state, rejects stale state, and rolls back on audit failure',
    () =>
      Effect.gen(function* ()
      {
        const sql = yield* SqlClient.SqlClient
        const recovery = yield* RuntimeRecoveryPersistence
        yield* insertProgress(sql, 'architecture-auto-analysis')
        yield* insertAction(sql, {
          actionId: 'action-retry',
          reactorId: 'architecture-auto-analysis',
          sourceSequence: 1,
          effectKind: 'architecture.diff-analysis.request',
          status: 'manual',
        })
        yield* insertAction(sql, {
          actionId: 'action-stale',
          reactorId: 'architecture-auto-analysis',
          sourceSequence: 2,
          effectKind: 'architecture.diff-analysis.request',
          status: 'manual',
        })
        yield* insertAction(sql, {
          actionId: 'action-audit-rollback',
          reactorId: 'architecture-auto-analysis',
          sourceSequence: 3,
          effectKind: 'architecture.diff-analysis.request',
          status: 'manual',
        })

        const updated = yield* recovery.recoverReactorAction({
          actionId: 'action-retry',
          expectedReactorId: 'architecture-auto-analysis',
          expectedEffectKind: 'architecture.diff-analysis.request',
          expectedOperationVersion: 1,
          expectedStatus: 'manual',
          expectedUpdatedAt: originalAt,
          action: 'retry',
          actor: { sessionId: 'operator-session', subject: 'operator-subject' },
          reason: 'dependency repaired',
          auditId: 'audit-retry',
          now: recoveredAt,
        })
        assert.equal(updated.status, 'pending')
        const audits = yield* recovery.listAudit({
          subjectKind: 'reactor-action',
          subjectId: 'action-retry',
          limit: 100,
        })
        assert.equal(audits.length, 1)
        assert.equal(audits[0]?.actorSessionId, 'operator-session')
        assert.equal(audits[0]?.reason, 'dependency repaired')
        assert.deepStrictEqual(decodeReactorAuditState(audits[0]?.beforeStateJson ?? ''), {
          kind: 'reactor-action',
          status: 'manual',
          updatedAt: originalAt,
        })
        assert.deepStrictEqual(decodeReactorAuditState(audits[0]?.afterStateJson ?? ''), {
          kind: 'reactor-action',
          status: 'pending',
          updatedAt: recoveredAt,
        })
        const progress = yield* sql<{
          readonly blockedSequence: number | null
          readonly lastError: string | null
        }>`
          SELECT
            blocked_sequence AS "blockedSequence",
            last_error AS "lastError"
          FROM orchestration_reactor_progress
          WHERE reactor_id = 'architecture-auto-analysis'
        `
        assert.deepStrictEqual(progress, [{ blockedSequence: 2, lastError: null }])

        const stale = yield* recovery
          .recoverReactorAction({
            actionId: 'action-stale',
            expectedReactorId: 'architecture-auto-analysis',
            expectedEffectKind: 'architecture.diff-analysis.request',
            expectedOperationVersion: 1,
            expectedStatus: 'manual',
            expectedUpdatedAt: '2026-08-09T00:00:00.001Z',
            action: 'retry',
            actor: { sessionId: 'operator-session', subject: 'operator-subject' },
            reason: 'stale attempt',
            auditId: 'audit-stale',
            now: recoveredAt,
          })
          .pipe(Effect.flip)
        assert.equal(stale._tag, 'RuntimeRecoveryPersistenceStaleError')
        assert.deepStrictEqual(
          yield* recovery.listAudit({
            subjectKind: 'reactor-action',
            subjectId: 'action-stale',
            limit: 100,
          }),
          [],
        )

        const auditFailure = yield* recovery
          .recoverReactorAction({
            actionId: 'action-audit-rollback',
            expectedReactorId: 'architecture-auto-analysis',
            expectedEffectKind: 'architecture.diff-analysis.request',
            expectedOperationVersion: 1,
            expectedStatus: 'manual',
            expectedUpdatedAt: originalAt,
            action: 'retry',
            actor: { sessionId: 'operator-session', subject: 'operator-subject' },
            reason: 'must roll back',
            auditId: 'audit-retry',
            now: recoveredAt,
          })
          .pipe(Effect.flip)
        assert.equal(auditFailure._tag, 'PersistenceSqlError')
        const rolledBack = yield* recovery.getBlockedReactorAction('action-audit-rollback')
        assert.equal(rolledBack._tag, 'Some')
        if (rolledBack._tag === 'Some') assert.equal(rolledBack.value.status, 'manual')
      }),
  )

  it.effect('counts only materialized successors that are actually blocked by the action', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      const recovery = yield* RuntimeRecoveryPersistence
      yield* insertProgress(sql, 'provider-command')
      yield* insertAction(sql, {
        actionId: 'action-provider-unknown',
        reactorId: 'provider-command',
        sourceSequence: 10,
        effectKind: 'thread.provider-switch-requested',
        status: 'unknown',
      })
      yield* insertAction(sql, {
        actionId: 'action-provider-compensate',
        reactorId: 'provider-command',
        sourceSequence: 10,
        outputIndex: 1,
        effectKind: 'thread.provider.switch.compensate',
        status: 'pending',
      })
      yield* insertAction(sql, {
        actionId: 'action-provider-later',
        reactorId: 'provider-command',
        sourceSequence: 11,
        effectKind: 'thread.turn-start-requested',
        status: 'pending',
      })

      const action = yield* recovery.getBlockedReactorAction('action-provider-unknown')
      assert.equal(action._tag, 'Some')
      if (action._tag === 'Some')
      {
        assert.equal(action.value.materializedBlockedActionCount, 1)
      }
    }),
  )
})
