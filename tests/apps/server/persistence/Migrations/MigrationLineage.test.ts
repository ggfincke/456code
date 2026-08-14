// tests/apps/server/persistence/Migrations/MigrationLineage.test.ts
// verifies exact migration identity validation and fail-closed reconciliation

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  runMigrations,
  validateMigrationLineage,
} from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

it.effect('accepts an older canonical ledger against the full manifest', () =>
  validateMigrationLineage({
    applied: [
      { id: 1, name: 'OrchestrationEvents' },
      { id: 2, name: 'OrchestrationCommandReceipts' },
    ],
  }),
)

it.effect('rejects duplicate ids and names in the current manifest', () =>
  Effect.gen(function* ()
  {
    const duplicateId = yield* validateMigrationLineage({
      manifest: [
        { id: 1, name: 'First' },
        { id: 1, name: 'Second' },
      ],
      applied: [],
    }).pipe(Effect.flip)
    assert.equal(duplicateId.reason, 'duplicate-manifest-id')

    const duplicateName = yield* validateMigrationLineage({
      manifest: [
        { id: 1, name: 'Repeated' },
        { id: 2, name: 'Repeated' },
      ],
      applied: [],
    }).pipe(Effect.flip)
    assert.equal(duplicateName.reason, 'duplicate-manifest-name')
  }),
)

const layer = it.layer(NodeSqliteClient.layerMemory())

const createLedger = Effect.fn('createMigrationLineageTestLedger')(function* ()
{
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE IF EXISTS effect_sql_migrations`
  yield* sql`
    CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `
})

layer('migration lineage database validation', (it) =>
{
  it.effect('rejects a name mismatch without applying the expected schema', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* createLedger()
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (1, 'UnknownOrchestrationEvents')
      `

      const error = yield* runMigrations({ toMigrationInclusive: 1 }).pipe(Effect.flip)
      assert.equal(error._tag, 'MigrationLineageError')
      if (error._tag !== 'MigrationLineageError') return
      assert.equal(error.reason, 'ledger-name-mismatch')

      const ledger = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 1
      `
      assert.deepStrictEqual(ledger, [{ name: 'UnknownOrchestrationEvents' }])
      const schema = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'
      `
      assert.deepStrictEqual(schema, [])
    }),
  )

  it.effect('rejects an unknown future id against the full manifest', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* createLedger()
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (999, 'FutureMigration')
      `

      const error = yield* runMigrations({ toMigrationInclusive: 1 }).pipe(Effect.flip)
      assert.equal(error._tag, 'MigrationLineageError')
      if (error._tag !== 'MigrationLineageError') return
      assert.equal(error.reason, 'unknown-ledger-id')
      assert.equal(error.migrationId, 999)

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name FROM effect_sql_migrations
      `
      assert.deepStrictEqual(ledger, [{ migrationId: 999, name: 'FutureMigration' }])
    }),
  )

  it.effect('rejects an occupied noncanonical 59 before probing or mutating schema', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* createLedger()
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (52, 'DiffAnalysisGenerations'),
          (59, 'DifferentMigration')
      `

      const error = yield* runMigrations({ toMigrationInclusive: 0 }).pipe(Effect.flip)
      assert.equal(error._tag, 'MigrationLineageError')
      if (error._tag !== 'MigrationLineageError') return
      assert.equal(error.reason, 'historical-row-59-collision')

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `
      assert.deepStrictEqual(ledger, [
        { migrationId: 52, name: 'DiffAnalysisGenerations' },
        { migrationId: 59, name: 'DifferentMigration' },
      ])
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('diff_analysis_generations', 'projection_threads')
      `
      assert.deepStrictEqual(tables, [])
    }),
  )

  it.effect('rejects a historical 052 row whose schema is not the exact known lineage', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* createLedger()
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`
      yield* sql`CREATE TABLE diff_analysis_generations (diff_analysis_id TEXT PRIMARY KEY)`
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (52, 'DiffAnalysisGenerations')
      `

      const error = yield* runMigrations({ toMigrationInclusive: 0 }).pipe(Effect.flip)
      assert.equal(error._tag, 'MigrationLineageError')
      if (error._tag !== 'MigrationLineageError') return
      assert.equal(error.reason, 'historical-schema-mismatch')

      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name FROM effect_sql_migrations
      `
      assert.deepStrictEqual(ledger, [{ migrationId: 52, name: 'DiffAnalysisGenerations' }])
      const projectionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `
      assert.isFalse(projectionColumns.some((column) => column.name === 'interaction_orchestrate'))
    }),
  )
})
