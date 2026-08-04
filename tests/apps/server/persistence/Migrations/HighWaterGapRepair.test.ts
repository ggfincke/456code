// tests/apps/server/persistence/Migrations/HighWaterGapRepair.test.ts
// verifies skipped migration gaps replay in canonical order exactly once

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('migration high-water gap repair', (it) =>
{
  it.effect('replays multiple holes by ascending id and remains idempotent', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 50 })

      yield* sql`DROP TABLE orchestration_reactor_actions`
      yield* sql`DROP TABLE orchestration_reactor_progress`
      yield* sql`DROP TABLE import_replacement_intents`
      yield* sql`DROP TABLE proposal_retained_ref_attempts`
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (43, 44, 45)`

      const repaired = yield* runMigrations({ toMigrationInclusive: 50 })
      assert.deepEqual(repaired, [
        [43, 'ProposalRetainedRefAttempts'],
        [44, 'ImportReplacementIntents'],
        [45, 'OrchestrationReactorDelivery'],
      ])

      const ledger = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE migration_id IN (43, 44, 45)
        ORDER BY migration_id
      `
      assert.deepEqual(
        ledger.map((row) => row.migrationId),
        [43, 44, 45],
      )
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 50 }), [])
    }),
  )
})
