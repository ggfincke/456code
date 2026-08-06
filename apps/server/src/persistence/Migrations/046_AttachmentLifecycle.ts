// apps/server/src/persistence/Migrations/046_AttachmentLifecycle.ts
// installs durable attachment staging and cleanup intent storage

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS attachment_staging (
      staging_key TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      attachment_index INTEGER NOT NULL CHECK(attachment_index >= 0),
      attachment_id TEXT NOT NULL,
      staging_relative_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL CHECK(byte_count >= 0),
      content_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('staged', 'owned', 'cleanup_pending')),
      owner_sequence INTEGER NULL CHECK(owner_sequence IS NULL OR owner_sequence >= 0),
      owner_event_type TEXT NULL,
      cleanup_reason TEXT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
      next_attempt_at TEXT NULL,
      last_error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(command_id, message_id, attachment_index),
      UNIQUE(relative_path)
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_attachment_staging_command
    ON attachment_staging(command_id, state)
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS attachment_cleanup (
      cleanup_key TEXT PRIMARY KEY,
      staging_key TEXT NULL REFERENCES attachment_staging(staging_key),
      target_kind TEXT NOT NULL CHECK(target_kind IN ('path', 'thread')),
      relative_path TEXT NULL,
      staging_relative_path TEXT NULL,
      thread_id TEXT NULL,
      thread_segment TEXT NULL,
      reason TEXT NOT NULL,
      source_sequence INTEGER NULL CHECK(source_sequence IS NULL OR source_sequence >= 0),
      state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'complete', 'poison', 'manual')),
      lease_expires_at TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at TEXT NULL,
      last_error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (target_kind = 'path' AND (relative_path IS NOT NULL OR staging_relative_path IS NOT NULL))
        OR
        (target_kind = 'thread' AND thread_id IS NOT NULL AND thread_segment IS NOT NULL)
      )
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_due
    ON attachment_cleanup(state, next_attempt_at, lease_expires_at, created_at)
  `
})
