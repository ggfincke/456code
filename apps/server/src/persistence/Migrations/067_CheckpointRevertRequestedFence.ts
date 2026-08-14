// apps/server/src/persistence/Migrations/067_CheckpointRevertRequestedFence.ts
// reserves checkpoint reverts before side effects and persists their replay barriers

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE checkpoint_revert_operations_next (
      operation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      target_turn_count INTEGER NOT NULL CHECK (target_turn_count >= 0),
      request_source_sequence INTEGER NOT NULL CHECK (request_source_sequence >= 0),
      provider_inbox_high_water INTEGER NOT NULL CHECK (provider_inbox_high_water >= 0),
      target_tree TEXT NULL,
      cwd TEXT NULL,
      checkpoint_capture_root TEXT NULL,
      repository_common_dir TEXT NULL,
      checkpoint_commit_oid TEXT NULL,
      stage_path TEXT NULL,
      phase TEXT NOT NULL CHECK (phase IN (
        'requested',
        'admitted',
        'target-staged',
        'restore-ready',
        'provider-pending',
        'provider-outcome-recorded',
        'restore-started',
        'filesystem-restored',
        'projection-finalized',
        'cleanup-pending',
        'completed',
        'aborted',
        'manual-required'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT NULL,
      provider_kind TEXT NULL CHECK (
        provider_kind IS NULL
        OR (
          length(provider_kind) BETWEEN 1 AND 64
          AND substr(provider_kind, 1, 1) GLOB '[A-Za-z]'
          AND provider_kind NOT GLOB '*[^A-Za-z0-9_-]*'
        )
      ),
      provider_instance_id TEXT NULL,
      provider_session_id TEXT NULL,
      provider_thread_id TEXT NULL,
      provider_session_generation INTEGER NULL CHECK (
        provider_session_generation IS NULL OR provider_session_generation >= 1
      ),
      provider_outcome TEXT NULL CHECK (
        provider_outcome IS NULL
        OR provider_outcome IN ('exact', 'known-unsupported', 'manual-unknown')
      ),
      provider_outcome_json TEXT NULL,
      projection_status TEXT NULL,
      stale_refs_json TEXT NULL,
      cleanup_status TEXT NULL,
      manual_resume_phase TEXT NULL CHECK (
        manual_resume_phase IS NULL
        OR manual_resume_phase IN (
          'admitted',
          'target-staged',
          'restore-ready',
          'provider-pending',
          'provider-outcome-recorded',
          'restore-started',
          'filesystem-restored',
          'projection-finalized',
          'cleanup-pending'
        )
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (phase = 'requested' AND cwd IS NULL)
        OR phase = 'aborted'
        OR (phase NOT IN ('requested', 'aborted') AND cwd IS NOT NULL)
      )
    )
  `

  // pre-fence nonterminal rows may already have changed the filesystem before
  // provider rollback. Their old phase cannot be translated into the new
  // provider-first order, so preserve the evidence and fail closed.
  yield* sql`
    INSERT INTO checkpoint_revert_operations_next (
      operation_id,
      thread_id,
      target_ref,
      target_turn_count,
      request_source_sequence,
      provider_inbox_high_water,
      target_tree,
      cwd,
      checkpoint_capture_root,
      repository_common_dir,
      checkpoint_commit_oid,
      stage_path,
      phase,
      attempt_count,
      last_error,
      provider_kind,
      provider_instance_id,
      provider_session_id,
      provider_thread_id,
      provider_session_generation,
      provider_outcome,
      provider_outcome_json,
      projection_status,
      stale_refs_json,
      cleanup_status,
      manual_resume_phase,
      created_at,
      updated_at
    )
    SELECT
      operation_id,
      thread_id,
      target_ref,
      target_turn_count,
      0,
      0,
      target_tree,
      cwd,
      checkpoint_capture_root,
      repository_common_dir,
      checkpoint_commit_oid,
      stage_path,
      CASE
        WHEN phase IN ('completed', 'aborted', 'manual-required') THEN phase
        ELSE 'manual-required'
      END,
      attempt_count,
      CASE
        WHEN phase IN ('completed', 'aborted', 'manual-required') THEN last_error
        ELSE trim(
          coalesce(last_error || ' ', '') ||
          'This checkpoint revert predates the transactional request fence and provider-first restore order; automatic resume is refused.'
        )
      END,
      NULL,
      provider_instance_id,
      provider_session_id,
      provider_thread_id,
      provider_session_generation,
      provider_outcome,
      provider_outcome_json,
      projection_status,
      stale_refs_json,
      cleanup_status,
      NULL,
      created_at,
      updated_at
    FROM checkpoint_revert_operations
  `

  yield* sql`DROP INDEX checkpoint_revert_operations_one_active_per_thread`
  yield* sql`DROP TABLE checkpoint_revert_operations`
  yield* sql`ALTER TABLE checkpoint_revert_operations_next RENAME TO checkpoint_revert_operations`
  yield* sql`
    CREATE UNIQUE INDEX checkpoint_revert_operations_one_active_per_thread
    ON checkpoint_revert_operations(thread_id)
    WHERE phase NOT IN ('completed', 'aborted')
  `
})
