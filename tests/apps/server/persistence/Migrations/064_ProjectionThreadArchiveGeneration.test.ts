// tests/apps/server/persistence/Migrations/064_ProjectionThreadArchiveGeneration.test.ts
// verifies legacy archive generation defaults without inventing prior lifecycles

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration064 from '../../../../../apps/server/src/persistence/Migrations/064_ProjectionThreadArchiveGeneration.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('064_ProjectionThreadArchiveGeneration', (it) =>
{
  it.effect('adds a non-negative generation and leaves legacy rows at zero', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          archived_at TEXT
        )
      `
      yield* sql`
        INSERT INTO projection_threads (thread_id, archived_at)
        VALUES ('legacy-archived', '2026-08-01T00:00:00.000Z')
      `

      yield* Migration064

      const rows = yield* sql<{ readonly archiveGeneration: number }>`
        SELECT archive_generation AS "archiveGeneration"
        FROM projection_threads
        WHERE thread_id = 'legacy-archived'
      `
      assert.deepStrictEqual(rows, [{ archiveGeneration: 0 }])

      const invalid = yield* Effect.exit(sql`
        UPDATE projection_threads
        SET archive_generation = -1
        WHERE thread_id = 'legacy-archived'
      `)
      assert.isTrue(invalid._tag === 'Failure')
    }),
  )
})
