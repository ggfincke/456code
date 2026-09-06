// tests/apps/server/persistence/Migrations/073_ProjectionThreadsActiveOrderKey.test.ts
// verifies idempotent active ordering migration without changing legacy rows

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import Migration073 from '../../../../../apps/server/src/persistence/Migrations/073_ProjectionThreadsActiveOrderKey.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

it.layer(NodeSqliteClient.layerMemory())('073_ProjectionThreadsActiveOrderKey', (it) =>
{
  it.effect('keeps legacy rows keyless and preserves arranged keys across repeated migration', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 72 })
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'legacy', 'project', 'Legacy', '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access', 'default', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'
        )
      `
      yield* Migration073
      const legacy = yield* sql<{ readonly orderKey: string | null }>`
        SELECT active_order_key AS "orderKey" FROM projection_threads WHERE thread_id = 'legacy'
      `
      assert.deepStrictEqual(legacy, [{ orderKey: null }])
      yield* sql`UPDATE projection_threads SET active_order_key = 'm' WHERE thread_id = 'legacy'`
      yield* Migration073
      const arranged = yield* sql<{ readonly orderKey: string | null }>`
        SELECT active_order_key AS "orderKey" FROM projection_threads WHERE thread_id = 'legacy'
      `
      assert.deepStrictEqual(arranged, [{ orderKey: 'm' }])
    }),
  )
})
