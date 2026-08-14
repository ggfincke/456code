// apps/server/src/persistence/Migrations/055_ProjectionThreadsOrchestrateIntegration.ts
// records the orchestrate run's integration tree on threads and the capture tree on turns

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  // the thread shell is the only row the sidebar reads, so the run's integration
  // target has to live here or the sidebar keeps showing nothing for a thread
  // whose work went into a run worktree
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN orchestrate_run_worktree_path TEXT
  `

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN orchestrate_run_branch TEXT
  `

  // a checkpoint that does not say which tree it snapshotted cannot be diffed or
  // reverted safely; NULL means "captured before this column existed", which
  // every consumer must read as today's behaviour and never as a mismatch
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN checkpoint_capture_root TEXT
  `
})
