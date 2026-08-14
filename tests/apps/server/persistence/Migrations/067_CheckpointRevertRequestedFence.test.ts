// tests/apps/server/persistence/Migrations/067_CheckpointRevertRequestedFence.test.ts
// verifies request fencing and conservative legacy checkpoint-revert recovery

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('067_CheckpointRevertRequestedFence', (it) =>
{
  it.effect('fails pre-fence destructive rows closed and admits nullable requested rows', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 66 })

      yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          thread_id,
          target_ref,
          target_turn_count,
          cwd,
          phase,
          provider_instance_id,
          provider_thread_id,
          provider_session_generation,
          created_at,
          updated_at
        )
        VALUES
          (
            'legacy-active',
            'thread-legacy-active',
            'refs/t3/checkpoint/legacy-active',
            1,
            '/tmp/legacy-active',
            'restore-started',
            'codex',
            'thread-legacy-active',
            1,
            '2026-08-09T00:00:00.000Z',
            '2026-08-09T00:00:00.000Z'
          ),
          (
            'legacy-completed',
            'thread-legacy-completed',
            'refs/t3/checkpoint/legacy-completed',
            1,
            '/tmp/legacy-completed',
            'completed',
            'codex',
            'thread-legacy-completed',
            1,
            '2026-08-09T00:00:00.000Z',
            '2026-08-09T00:00:00.000Z'
          )
      `

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 67 }), [
        [67, 'CheckpointRevertRequestedFence'],
      ])

      const migrated = yield* sql<{
        readonly operationId: string
        readonly phase: string
        readonly requestSourceSequence: number
        readonly providerInboxHighWater: number
        readonly provider: string | null
        readonly manualResumePhase: string | null
        readonly lastError: string | null
      }>`
        SELECT
          operation_id AS "operationId",
          phase,
          request_source_sequence AS "requestSourceSequence",
          provider_inbox_high_water AS "providerInboxHighWater",
          provider_kind AS provider,
          manual_resume_phase AS "manualResumePhase",
          last_error AS "lastError"
        FROM checkpoint_revert_operations
        ORDER BY operation_id
      `
      assert.equal(migrated[0]?.operationId, 'legacy-active')
      assert.equal(migrated[0]?.phase, 'manual-required')
      assert.equal(migrated[0]?.requestSourceSequence, 0)
      assert.equal(migrated[0]?.providerInboxHighWater, 0)
      assert.isNull(migrated[0]?.provider)
      assert.isNull(migrated[0]?.manualResumePhase)
      assert.include(migrated[0]?.lastError ?? '', 'automatic resume is refused')
      assert.equal(migrated[1]?.operationId, 'legacy-completed')
      assert.equal(migrated[1]?.phase, 'completed')

      yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          thread_id,
          target_ref,
          target_turn_count,
          request_source_sequence,
          provider_inbox_high_water,
          cwd,
          phase,
          created_at,
          updated_at
        )
        VALUES (
          'new-requested',
          'thread-new-requested',
          'refs/t3/checkpoint/new-requested',
          2,
          41,
          17,
          NULL,
          'requested',
          '2026-08-09T01:00:00.000Z',
          '2026-08-09T01:00:00.000Z'
        )
      `
      const requested = yield* sql<{
        readonly cwd: string | null
        readonly requestSourceSequence: number
        readonly providerInboxHighWater: number
      }>`
        SELECT
          cwd,
          request_source_sequence AS "requestSourceSequence",
          provider_inbox_high_water AS "providerInboxHighWater"
        FROM checkpoint_revert_operations
        WHERE operation_id = 'new-requested'
      `
      assert.deepStrictEqual(requested, [
        { cwd: null, requestSourceSequence: 41, providerInboxHighWater: 17 },
      ])

      yield* sql`
        UPDATE checkpoint_revert_operations
        SET phase = 'aborted'
        WHERE operation_id = 'new-requested'
      `

      const invalid = yield* Effect.exit(sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          thread_id,
          target_ref,
          target_turn_count,
          request_source_sequence,
          provider_inbox_high_water,
          cwd,
          phase,
          created_at,
          updated_at
        )
        VALUES (
          'invalid-admitted',
          'thread-invalid-admitted',
          'refs/t3/checkpoint/invalid-admitted',
          1,
          1,
          0,
          NULL,
          'admitted',
          '2026-08-09T01:00:00.000Z',
          '2026-08-09T01:00:00.000Z'
        )
      `)
      assert.isTrue(invalid._tag === 'Failure')
    }),
  )
})
