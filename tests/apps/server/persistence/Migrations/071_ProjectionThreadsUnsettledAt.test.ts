// tests/apps/server/persistence/Migrations/071_ProjectionThreadsUnsettledAt.test.ts
// verifies the idempotent active-list re-entry column migration

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  currentMigrationManifest,
  runMigrations,
} from '../../../../../apps/server/src/persistence/Migrations.ts'
import Migration071 from '../../../../../apps/server/src/persistence/Migrations/071_ProjectionThreadsUnsettledAt.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('071_ProjectionThreadsUnsettledAt', (it) =>
{
  it.effect('adds one nullable column without backfilling legacy rows', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      assert.deepStrictEqual(
        currentMigrationManifest.find(({ id }) => id === 71),
        {
          id: 71,
          name: 'ProjectionThreadsUnsettledAt',
        },
      )

      yield* runMigrations({ toMigrationInclusive: 70 })
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
          '2026-08-26T00:00:00.000Z',
          '2026-08-26T00:00:00.000Z'
        )
      `

      yield* Migration071
      yield* Migration071

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`
      assert.strictEqual(columns.filter((column) => column.name === 'unsettled_at').length, 1)
      const rows = yield* sql<{ readonly unsettledAt: string | null }>`
        SELECT unsettled_at AS "unsettledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `
      assert.deepStrictEqual(rows, [{ unsettledAt: null }])
    }),
  )
})
