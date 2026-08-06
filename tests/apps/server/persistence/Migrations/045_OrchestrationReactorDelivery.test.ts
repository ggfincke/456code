// tests/apps/server/persistence/Migrations/045_OrchestrationReactorDelivery.test.ts
// verifies durable reactor delivery schema constraints and indexes

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import migration from '../../../../../apps/server/src/persistence/Migrations/045_OrchestrationReactorDelivery.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('045_OrchestrationReactorDelivery', (it) =>
{
  it.effect('is idempotent and creates the required indexes', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      yield* migration
      yield* migration

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'orchestration_reactor_actions'
      `
      const names = new Set(indexes.map((row) => row.name))
      assert.ok(names.has('idx_orchestration_reactor_actions_claim'))
      assert.ok(names.has('idx_orchestration_reactor_actions_source'))
      assert.ok(names.has('idx_orchestration_reactor_actions_lease_expiry'))
    }),
  )

  it.effect('enforces modes, statuses, output indexes, uniqueness, and progress ownership', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      yield* migration
      yield* sql`
        INSERT INTO orchestration_reactor_progress (
          reactor_id,
          operation_version,
          mode,
          updated_at
        )
        VALUES ('thread-deletion', 1, 'durable', '2026-01-01T00:00:00.000Z')
      `

      const invalidMode = yield* Effect.result(sql`
        INSERT INTO orchestration_reactor_progress (
          reactor_id,
          operation_version,
          mode,
          updated_at
        )
        VALUES ('invalid', 1, 'live', '2026-01-01T00:00:00.000Z')
      `)
      assert.equal(invalidMode._tag, 'Failure')

      const insertAction = (actionId: string, outputIndex: number, status: string) => sql`
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
          created_at,
          updated_at
        )
        VALUES (
          ${actionId},
          'thread-deletion',
          1,
          'event-1',
          ${outputIndex},
          'cleanup',
          'thread',
          'thread-1',
          1,
          '{}',
          ${status},
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `

      assert.equal((yield* Effect.result(insertAction('negative', -1, 'pending')))._tag, 'Failure')
      assert.equal((yield* Effect.result(insertAction('bad-status', 0, 'running')))._tag, 'Failure')
      yield* insertAction('valid', 0, 'pending')
      assert.equal((yield* Effect.result(insertAction('duplicate', 0, 'pending')))._tag, 'Failure')
      assert.equal(
        (yield* Effect.result(insertAction('missing-owner', 1, 'pending')))._tag,
        'Success',
      )

      const foreignKey = yield* Effect.result(sql`
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
          created_at,
          updated_at
        )
        VALUES (
          'orphan',
          'checkpoint-domain',
          1,
          'event-1',
          0,
          'cleanup',
          'thread',
          'thread-1',
          1,
          '{}',
          'pending',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `)
      assert.equal(foreignKey._tag, 'Failure')
    }),
  )
})
