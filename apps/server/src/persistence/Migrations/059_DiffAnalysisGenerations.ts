// apps/server/src/persistence/Migrations/059_DiffAnalysisGenerations.ts
// reconciles both historical 052 schemas and stores diff analysis generations

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const projectionThreadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `

  if (!projectionThreadColumns.some((column) => column.name === 'interaction_orchestrate'))
  {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN interaction_orchestrate INTEGER NOT NULL DEFAULT 0
    `
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS diff_analysis_generations (
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
    CREATE INDEX IF NOT EXISTS idx_diff_analysis_generations_repository_lru
    ON diff_analysis_generations(
      environment_id,
      repository_key,
      last_accessed_at,
      diff_analysis_id
    )
    WHERE state = 'ready'
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_diff_analysis_generations_global_lru
    ON diff_analysis_generations(last_accessed_at, diff_analysis_id)
    WHERE state = 'ready'
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_diff_analysis_generations_terminal_cutoff
    ON diff_analysis_generations(updated_at, diff_analysis_id)
    WHERE state IN ('failed', 'cancelled', 'abandoned')
  `
})
