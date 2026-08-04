// apps/server/src/persistence/Migrations/048_CheckpointRevertOperations.ts
// adds the durable checkpoint revert operation journal

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE checkpoint_revert_operations (
      operation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      target_turn_count INTEGER NOT NULL CHECK (target_turn_count >= 0),
      target_tree TEXT NULL,
      cwd TEXT NOT NULL,
      repository_common_dir TEXT NULL,
      stage_path TEXT NULL,
      phase TEXT NOT NULL CHECK (phase IN (
        'admitted',
        'target-staged',
        'restore-ready',
        'restore-started',
        'filesystem-restored',
        'provider-pending',
        'provider-outcome-recorded',
        'projection-finalized',
        'cleanup-pending',
        'completed',
        'aborted',
        'manual-required'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT NULL,
      provider_instance_id TEXT NULL,
      provider_session_id TEXT NULL,
      provider_thread_id TEXT NULL,
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
          'restore-started',
          'filesystem-restored',
          'provider-pending',
          'provider-outcome-recorded',
          'projection-finalized',
          'cleanup-pending'
        )
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX checkpoint_revert_operations_one_active_per_thread
    ON checkpoint_revert_operations(thread_id)
    WHERE phase NOT IN ('completed', 'aborted')
  `
})
