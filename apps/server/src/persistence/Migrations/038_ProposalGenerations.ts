// apps/server/src/persistence/Migrations/038_ProposalGenerations.ts
// stores bounded cartographer analysis jobs and authenticated artifacts

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposal_generations (
      generation_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL REFERENCES proposal_revisions(revision_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      thread_id TEXT NOT NULL,
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
      authority TEXT NOT NULL CHECK(authority IN ('authoritative', 'estimated')),
      workspace_snapshot_tree_oid TEXT NOT NULL,
      analyzer_version TEXT NOT NULL,
      artifact_root TEXT NOT NULL,
      base_graph_path TEXT,
      proposed_graph_path TEXT,
      impact_path TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposal_generations_revision_created
    ON proposal_generations(revision_id, created_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposal_generations_thread_state
    ON proposal_generations(thread_id, state, created_at DESC)
  `;
});
