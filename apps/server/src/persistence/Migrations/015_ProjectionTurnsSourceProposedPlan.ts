// apps/server/src/persistence/Migrations/015_ProjectionTurnsSourceProposedPlan.ts
// apply persistence migration 015 projection turns source proposed plan

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN source_proposed_plan_thread_id TEXT
  `

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN source_proposed_plan_id TEXT
  `
})
