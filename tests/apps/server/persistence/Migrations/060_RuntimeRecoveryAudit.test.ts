// tests/apps/server/persistence/Migrations/060_RuntimeRecoveryAudit.test.ts
// verifies append-only runtime recovery audit schema and database enforcement

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration060 from '../../../../../apps/server/src/persistence/Migrations/060_RuntimeRecoveryAudit.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(
  Layer.effectDiscard(Migration060).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
)

layer('060_RuntimeRecoveryAudit', (it) =>
{
  it.effect('creates immutable audit history that rejects update and delete', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO runtime_recovery_audit (
          audit_id,
          subject_kind,
          subject_id,
          reactor_id,
          operation_version,
          actor_session_id,
          actor_subject,
          effect_kind,
          recovery_action,
          before_state_json,
          after_state_json,
          reason,
          created_at
        )
        VALUES (
          'audit-immutable',
          'reactor-action',
          'action-immutable',
          'architecture-auto-analysis',
          1,
          'session-operator',
          'operator-subject',
          'architecture.diff-analysis.request',
          'retry',
          '{"kind":"reactor-action","status":"manual","updatedAt":"2026-08-09T00:00:00.000Z"}',
          '{"kind":"reactor-action","status":"pending","updatedAt":"2026-08-09T00:01:00.000Z"}',
          'transient dependency repaired',
          '2026-08-09T00:01:00.000Z'
        )
      `

      const missingOwnerIdentity = yield* Effect.result(sql`
        INSERT INTO runtime_recovery_audit (
          audit_id,
          subject_kind,
          subject_id,
          actor_session_id,
          actor_subject,
          effect_kind,
          recovery_action,
          before_state_json,
          after_state_json,
          reason,
          created_at
        )
        VALUES (
          'audit-missing-owner',
          'reactor-action',
          'action-missing-owner',
          'session-operator',
          'operator-subject',
          'architecture.diff-analysis.request',
          'retry',
          '{}',
          '{}',
          'must fail',
          '2026-08-09T00:01:00.000Z'
        )
      `)
      assert.equal(missingOwnerIdentity._tag, 'Failure')

      const update = yield* Effect.result(
        sql`UPDATE runtime_recovery_audit SET reason = 'rewritten' WHERE audit_id = 'audit-immutable'`,
      )
      const deletion = yield* Effect.result(
        sql`DELETE FROM runtime_recovery_audit WHERE audit_id = 'audit-immutable'`,
      )
      assert.equal(update._tag, 'Failure')
      assert.equal(deletion._tag, 'Failure')

      const rows = yield* sql<{
        readonly reactorId: string
        readonly operationVersion: number
        readonly reason: string
      }>`
        SELECT
          reactor_id AS "reactorId",
          operation_version AS "operationVersion",
          reason
        FROM runtime_recovery_audit
        WHERE audit_id = 'audit-immutable'
      `
      assert.deepStrictEqual(rows, [
        {
          reactorId: 'architecture-auto-analysis',
          operationVersion: 1,
          reason: 'transient dependency repaired',
        },
      ])

      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'runtime_recovery_audit'
        ORDER BY name
      `
      assert.deepStrictEqual(triggers, [
        { name: 'runtime_recovery_audit_deny_delete' },
        { name: 'runtime_recovery_audit_deny_update' },
      ])
    }),
  )
})
