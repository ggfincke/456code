// tests/apps/server/persistence/Migrations/072_ProjectionThreadsPinnedAt.test.ts
// verifies the idempotent projected thread pin column migration

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  currentMigrationManifest,
  runMigrations,
} from '../../../../../apps/server/src/persistence/Migrations.ts'
import Migration072 from '../../../../../apps/server/src/persistence/Migrations/072_ProjectionThreadsPinnedAt.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('072_ProjectionThreadsPinnedAt', (it) =>
{
  it.effect('adds one nullable column without backfilling legacy rows', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      assert.deepStrictEqual(currentMigrationManifest.at(-1), {
        id: 72,
        name: 'ProjectionThreadsPinnedAt',
      })

      yield* runMigrations({ toMigrationInclusive: 71 })
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        )
        VALUES (
          'thread-legacy',
          'project-1',
          'Legacy thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-08-29T00:00:00.000Z',
          '2026-08-29T00:00:00.000Z'
        )
      `

      yield* Migration072
      yield* Migration072

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`
      assert.strictEqual(columns.filter((column) => column.name === 'pinned_at').length, 1)
      const rows = yield* sql<{ readonly pinnedAt: string | null }>`
        SELECT pinned_at AS "pinnedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `
      assert.deepStrictEqual(rows, [{ pinnedAt: null }])
    }),
  )
})
