// tests/apps/server/persistence/Migrations/065_CheckpointRevertProviderGeneration.test.ts
// verifies exact provider generations are additive and legacy revert journals remain unknown

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration065 from '../../../../../apps/server/src/persistence/Migrations/065_CheckpointRevertProviderGeneration.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('065_CheckpointRevertProviderGeneration', (it) =>
{
  it.effect('leaves legacy identity unknown and accepts only positive generations', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE checkpoint_revert_operations (
          operation_id TEXT PRIMARY KEY,
          provider_instance_id TEXT,
          provider_thread_id TEXT
        )
      `
      yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          provider_instance_id,
          provider_thread_id
        )
        VALUES ('legacy-revert', 'codex', 'thread-legacy')
      `

      yield* Migration065

      const legacy = yield* sql<{ readonly providerSessionGeneration: number | null }>`
        SELECT provider_session_generation AS "providerSessionGeneration"
        FROM checkpoint_revert_operations
        WHERE operation_id = 'legacy-revert'
      `
      assert.deepStrictEqual(legacy, [{ providerSessionGeneration: null }])

      yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          provider_instance_id,
          provider_thread_id,
          provider_session_generation
        )
        VALUES ('exact-revert', 'codex', 'thread-exact', 1)
      `
      const invalid = yield* Effect.exit(sql`
        UPDATE checkpoint_revert_operations
        SET provider_session_generation = 0
        WHERE operation_id = 'exact-revert'
      `)
      assert.isTrue(invalid._tag === 'Failure')
    }),
  )
})
