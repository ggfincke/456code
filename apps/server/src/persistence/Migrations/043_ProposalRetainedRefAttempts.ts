// apps/server/src/persistence/Migrations/043_ProposalRetainedRefAttempts.ts
// installs durable ownership inventory for proposal retained Git refs

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposal_retained_ref_attempts (
      ref_token TEXT PRIMARY KEY
        CHECK(length(ref_token) = 64 AND ref_token NOT GLOB '*[^0-9a-f]*'),
      git_common_dir TEXT NOT NULL CHECK(length(git_common_dir) > 0),
      base_ref TEXT NOT NULL,
      proposed_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      durable_at TEXT,
      CHECK(base_ref = 'refs/t3/proposals/' || ref_token || '/base'),
      CHECK(proposed_ref = 'refs/t3/proposals/' || ref_token || '/proposed')
    )
  `
})
