// tests/apps/server/persistence/Migrations/061_ProviderRuntimeInbox.test.ts
// verifies durable provider inbox ownership, session, and consumer schema guards

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration061 from '../../../../../apps/server/src/persistence/Migrations/061_ProviderRuntimeInbox.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(
  Layer.effectDiscard(Migration061).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
)

layer('061_ProviderRuntimeInbox', (it) =>
{
  it.effect('creates fenced admission and exactly one open generation per provider thread', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      const control = yield* sql<{
        readonly nextSequence: number
        readonly mode: string
        readonly ownerGeneration: number
      }>`
        SELECT
          next_sequence AS "nextSequence",
          admission_mode AS mode,
          owner_generation AS "ownerGeneration"
        FROM provider_runtime_inbox_control
      `
      assert.deepStrictEqual(control, [{ nextSequence: 1, mode: 'required', ownerGeneration: 0 }])

      yield* sql`
        INSERT INTO provider_runtime_inbox_sessions (
          provider_kind,
          provider_instance_id,
          thread_id,
          session_generation,
          status,
          created_at,
          updated_at
        )
        VALUES ('codex', 'codex', 'thread-1', 1, 'open', '2026-01-01', '2026-01-01')
      `
      const secondOpen = yield* Effect.result(sql`
        INSERT INTO provider_runtime_inbox_sessions (
          provider_kind,
          provider_instance_id,
          thread_id,
          session_generation,
          status,
          created_at,
          updated_at
        )
        VALUES ('codex', 'codex', 'thread-1', 2, 'open', '2026-01-02', '2026-01-02')
      `)
      const unknownConsumer = yield* Effect.result(sql`
        INSERT INTO provider_runtime_inbox_buffers (
          consumer_id,
          state_version,
          through_sequence,
          state_json,
          updated_at
        )
        VALUES ('unknown-consumer', 1, 0, '{}', '2026-01-01')
      `)

      assert.equal(secondOpen._tag, 'Failure')
      assert.equal(unknownConsumer._tag, 'Failure')

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'provider_runtime_inbox%'
        ORDER BY name
      `
      assert.deepStrictEqual(tables, [
        { name: 'provider_runtime_inbox' },
        { name: 'provider_runtime_inbox_buffers' },
        { name: 'provider_runtime_inbox_consumer_sessions' },
        { name: 'provider_runtime_inbox_control' },
        { name: 'provider_runtime_inbox_sessions' },
      ])
    }),
  )
})
