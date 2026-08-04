// tests/apps/server/persistence/Migrations/048_CheckpointRevertOperations.test.ts
// verifies checkpoint revert journal invalid-phase CHECK and active-operation index

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration048 from '../../../../../apps/server/src/persistence/Migrations/048_CheckpointRevertOperations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(
  Layer.effectDiscard(Migration048).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
)

layer('048_CheckpointRevertOperations', (it) =>
{
  it.effect('enforces invalid-phase CHECK and documents one-active index', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient

      const invalidPhase = yield* Effect.result(
        sql`
          INSERT INTO checkpoint_revert_operations (
            operation_id,
            thread_id,
            target_ref,
            target_turn_count,
            cwd,
            phase,
            created_at,
            updated_at
          )
          VALUES (
            'operation-invalid',
            'thread-invalid-phase',
            'refs/t3/checkpoint',
            1,
            '/tmp/worktree',
            'not-a-phase',
            '2026-08-02T00:00:00.000Z',
            '2026-08-02T00:00:00.000Z'
          )
        `,
      )
      assert.equal(invalidPhase._tag, 'Failure')

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'checkpoint_revert_operations_one_active_per_thread'
      `
      assert.equal(indexes.length, 1)
      assert.include(indexes[0]?.sql ?? '', "phase NOT IN ('completed', 'aborted')")
    }),
  )
})
