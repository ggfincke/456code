// apps/server/src/persistence/Migrations/039_ProposalImplementationAttempts.ts
// records exact proposal revisions consumed by implementation turns

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposal_implementation_attempts (
      attempt_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL REFERENCES proposal_revisions(revision_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      source_thread_id TEXT NOT NULL,
      implementation_thread_id TEXT NOT NULL,
      implementation_turn_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      baseline_tree_oid TEXT NOT NULL,
      actual_tree_oid TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('pending', 'matched', 'partial', 'divergent')),
      matched_operation_count INTEGER NOT NULL DEFAULT 0 CHECK(matched_operation_count >= 0),
      intended_operation_count INTEGER NOT NULL CHECK(intended_operation_count >= 0),
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposal_attempts_implementation_thread
    ON proposal_implementation_attempts(implementation_thread_id, created_at DESC)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_attempts_implementation_turn
    ON proposal_implementation_attempts(implementation_thread_id, implementation_turn_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposal_attempts_plan
    ON proposal_implementation_attempts(source_thread_id, plan_id, created_at DESC)
  `;
});
