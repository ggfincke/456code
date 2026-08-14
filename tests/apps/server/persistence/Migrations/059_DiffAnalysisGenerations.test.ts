// tests/apps/server/persistence/Migrations/059_DiffAnalysisGenerations.test.ts
// verifies collision reconciliation, cache identity, and bounded cleanup indexes

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const cartographer052Layer = it.layer(NodeSqliteClient.layerMemory())

cartographer052Layer('historical Cartographer 052 lineage reconciliation', (it) =>
{
  it.effect('proves the schema, preserves data, and records both canonical identities', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY
        )
      `
      yield* sql`
        CREATE TABLE diff_analysis_generations (
          diff_analysis_id TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL,
          repository_key TEXT NOT NULL,
          base_tree_oid TEXT NOT NULL,
          head_tree_oid TEXT NOT NULL,
          base_analyzer_ref TEXT NOT NULL,
          head_analyzer_ref TEXT NOT NULL,
          analyzer_version TEXT NOT NULL,
          analysis_policy_version TEXT NOT NULL,
          config_digest TEXT NOT NULL,
          scope_digest TEXT NOT NULL,
          tsconfig_digest TEXT NOT NULL,
          source_descriptor_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(
            state IN (
              'queued',
              'preparing',
              'analyzing',
              'ready',
              'failed',
              'cancelled',
              'abandoned'
            )
          ),
          artifact_root TEXT NOT NULL,
          head_root_path TEXT,
          base_graph_path TEXT,
          head_graph_path TEXT,
          impact_path TEXT,
          artifact_byte_length INTEGER NOT NULL DEFAULT 0 CHECK(artifact_byte_length >= 0),
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          UNIQUE (
            environment_id,
            repository_key,
            base_tree_oid,
            head_tree_oid,
            analyzer_version,
            analysis_policy_version,
            config_digest,
            scope_digest,
            tsconfig_digest
          )
        )
      `
      yield* sql`
        CREATE INDEX idx_diff_analysis_generations_repository_lru
        ON diff_analysis_generations(
          environment_id,
          repository_key,
          last_accessed_at,
          diff_analysis_id
        )
        WHERE state = 'ready'
      `
      yield* sql`
        CREATE INDEX idx_diff_analysis_generations_global_lru
        ON diff_analysis_generations(last_accessed_at, diff_analysis_id)
        WHERE state = 'ready'
      `
      yield* sql`
        CREATE INDEX idx_diff_analysis_generations_terminal_cutoff
        ON diff_analysis_generations(updated_at, diff_analysis_id)
        WHERE state IN ('failed', 'cancelled', 'abandoned')
      `
      yield* sql`
        INSERT INTO diff_analysis_generations (
          diff_analysis_id,
          environment_id,
          repository_key,
          base_tree_oid,
          head_tree_oid,
          base_analyzer_ref,
          head_analyzer_ref,
          analyzer_version,
          analysis_policy_version,
          config_digest,
          scope_digest,
          tsconfig_digest,
          source_descriptor_json,
          state,
          artifact_root,
          created_at,
          updated_at,
          last_accessed_at
        )
        VALUES (
          'historical-analysis',
          'environment-1',
          'repository-1',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'base-commit',
          'head-commit',
          'analyzer-1',
          'diff-analysis-v1',
          'config-1',
          'scope-1',
          'tsconfig-1',
          '{"historical":true}',
          'ready',
          '/tmp/historical-analysis',
          '2026-08-07T12:00:00.000Z',
          '2026-08-07T12:00:00.000Z',
          '2026-08-07T12:00:00.000Z'
        )
      `

      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (52, 'DiffAnalysisGenerations')
      `

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 0 }), [])
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 0 }), [])

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`
      assert.equal(columns.filter((column) => column.name === 'interaction_orchestrate').length, 1)
      const ledger = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `
      assert.deepStrictEqual(ledger, [
        { migrationId: 52, name: 'ProjectionThreadsInteractionOrchestrate' },
        { migrationId: 59, name: 'DiffAnalysisGenerations' },
      ])
      const retained = yield* sql<{ readonly source: string }>`
        SELECT source_descriptor_json AS source
        FROM diff_analysis_generations
        WHERE diff_analysis_id = 'historical-analysis'
      `
      assert.deepStrictEqual(retained, [{ source: '{"historical":true}' }])
    }),
  )
})

const sessionPostmortem052Layer = it.layer(NodeSqliteClient.layerMemory())

sessionPostmortem052Layer('059_DiffAnalysisGenerations from session-postmortem 052', (it) =>
{
  it.effect('creates the diff schema once with the full effective identity and indexes', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 55 })
      const diffTableBefore = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'diff_analysis_generations'
      `
      assert.deepStrictEqual(diffTableBefore, [])
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 59 }), [
        [59, 'DiffAnalysisGenerations'],
      ])
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 59 }), [])

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`
      assert.equal(columns.filter((column) => column.name === 'interaction_orchestrate').length, 1)
      const insert = (input: {
        readonly id: string
        readonly source: string
        readonly configDigest: string
      }) => sql`
        INSERT INTO diff_analysis_generations (
          diff_analysis_id,
          environment_id,
          repository_key,
          base_tree_oid,
          head_tree_oid,
          base_analyzer_ref,
          head_analyzer_ref,
          analyzer_version,
          analysis_policy_version,
          config_digest,
          scope_digest,
          tsconfig_digest,
          source_descriptor_json,
          state,
          artifact_root,
          created_at,
          updated_at,
          last_accessed_at
        )
        VALUES (
          ${input.id},
          'environment-1',
          'repository-1',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'base-commit',
          'head-commit',
          'analyzer-1',
          'diff-analysis-v1',
          ${input.configDigest},
          'scope-1',
          'tsconfig-1',
          ${input.source},
          'queued',
          ${`/tmp/${input.id}`},
          '2026-08-07T12:00:00.000Z',
          '2026-08-07T12:00:00.000Z',
          '2026-08-07T12:00:00.000Z'
        )
      `

      yield* insert({ id: 'analysis-1', source: '{"first":true}', configDigest: 'config-1' })
      const duplicate = yield* Effect.result(
        insert({ id: 'analysis-2', source: '{"first":false}', configDigest: 'config-1' }),
      )
      assert.equal(duplicate._tag, 'Failure')
      yield* insert({ id: 'analysis-3', source: '{"first":false}', configDigest: 'config-2' })

      const tableIndexes = yield* sql<{
        readonly name: string
        readonly unique: number
        readonly origin: string
      }>`PRAGMA index_list(diff_analysis_generations)`
      const identityIndex = tableIndexes.find((index) => index.unique === 1 && index.origin === 'u')
      if (identityIndex === undefined) return yield* Effect.die('identity index was not created')
      const identityColumns = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_index_info(${identityIndex.name})
        ORDER BY seqno
      `
      assert.deepStrictEqual(
        identityColumns.map((column) => column.name),
        [
          'environment_id',
          'repository_key',
          'base_tree_oid',
          'head_tree_oid',
          'analyzer_version',
          'analysis_policy_version',
          'config_digest',
          'scope_digest',
          'tsconfig_digest',
        ],
      )

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_diff_analysis_generations_repository_lru',
            'idx_diff_analysis_generations_global_lru',
            'idx_diff_analysis_generations_terminal_cutoff'
          )
        ORDER BY name
      `
      assert.equal(indexes.length, 3)
      assert.isTrue(
        indexes
          .filter((index) => index.name.endsWith('_lru'))
          .every((index) => index.sql.includes("WHERE state = 'ready'")),
      )
      assert.include(
        indexes.find((index) => index.name.endsWith('_terminal_cutoff'))?.sql ?? '',
        "WHERE state IN ('failed', 'cancelled', 'abandoned')",
      )
    }),
  )
})
