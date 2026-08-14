// apps/server/src/persistence/Migrations/062_CheckpointCaptureIdentity.ts
// persists exact checkpoint repository identity for reads and restores

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  // nullable fields preserve the distinction between capture evidence and
  // legacy rows whose repository identity cannot be reconstructed safely
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN checkpoint_repository_common_dir TEXT
  `

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN checkpoint_commit_oid TEXT
  `

  // turn zero has no projection_turns row, so checkpoint identity owns a small
  // projection keyed by the same thread/turn-count boundary as every other ref
  yield* sql`
    CREATE TABLE projection_checkpoint_identities (
      thread_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER NOT NULL CHECK (checkpoint_turn_count >= 0),
      checkpoint_ref TEXT NOT NULL,
      checkpoint_capture_root TEXT NULL,
      checkpoint_repository_common_dir TEXT NULL,
      checkpoint_commit_oid TEXT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_turn_count)
    )
  `

  // retain only evidence already recorded by migration 055; OID/common-dir
  // remain NULL so this does not guess stronger identity for historical rows
  yield* sql`
    INSERT INTO projection_checkpoint_identities (
      thread_id,
      checkpoint_turn_count,
      checkpoint_ref,
      checkpoint_capture_root,
      checkpoint_repository_common_dir,
      checkpoint_commit_oid,
      captured_at
    )
    SELECT
      thread_id,
      checkpoint_turn_count,
      checkpoint_ref,
      checkpoint_capture_root,
      NULL,
      NULL,
      completed_at
    FROM projection_turns
    WHERE checkpoint_turn_count IS NOT NULL
      AND checkpoint_ref IS NOT NULL
      AND completed_at IS NOT NULL
  `

  // cwd remains the exact selected restore target and the existing common-dir
  // column becomes its verified anchor; these additions retain capture evidence
  yield* sql`
    ALTER TABLE checkpoint_revert_operations
    ADD COLUMN checkpoint_capture_root TEXT
  `

  yield* sql`
    ALTER TABLE checkpoint_revert_operations
    ADD COLUMN checkpoint_commit_oid TEXT
  `
})
