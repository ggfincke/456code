// apps/server/src/persistence/Migrations/053_ProposalOrchestratePlanLinks.ts
// links immutable proposal revisions to exact orchestrate-plan revisions

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposal_orchestrate_plan_links (
      proposal_id TEXT NOT NULL,
      proposal_revision INTEGER NOT NULL CHECK(proposal_revision >= 1),
      source_thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      orchestrate_revision INTEGER NOT NULL CHECK(orchestrate_revision >= 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY(proposal_id, proposal_revision),
      UNIQUE(source_thread_id, run_id, orchestrate_revision),
      FOREIGN KEY(proposal_id, proposal_revision)
        REFERENCES proposal_revisions(proposal_id, revision)
        ON DELETE CASCADE
    )
  `
})
