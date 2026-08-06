// apps/server/src/persistence/Migrations/044_ImportReplacementIntents.ts
// adds durable state for crash-safe active import replacement

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE import_replacement_intents (
      intent_key TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      source_path TEXT NOT NULL,
      native_session_id TEXT,
      provider_instance_id TEXT,
      original_workspace_root TEXT,
      source_version TEXT NOT NULL,
      replacement_version TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_project_id TEXT NOT NULL,
      replacement_thread_id TEXT NOT NULL,
      replacement_project_id TEXT NOT NULL,
      replacement_workspace_root TEXT,
      create_command_id TEXT NOT NULL,
      tombstone_command_id TEXT NOT NULL,
      expected_message_count INTEGER NOT NULL,
      expected_activity_count INTEGER NOT NULL,
      expected_record_fingerprint TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN (
        'intent',
        'creating',
        'importing',
        'verifying',
        'tombstoning',
        'reconciling',
        'manual',
        'retired'
      )),
      thread_evidence_json TEXT,
      attachment_evidence_json TEXT,
      index_evidence_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      retry_after TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX import_replacement_intents_identity_idx
    ON import_replacement_intents (
      source,
      source_path,
      COALESCE(native_session_id, ''),
      COALESCE(provider_instance_id, ''),
      source_version,
      replacement_version,
      replacement_thread_id
    )
  `
})
