// apps/server/src/persistence/Migrations/052_ProjectionThreadsInteractionOrchestrate.ts
// adds the orchestration modifier to projected threads

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN interaction_orchestrate INTEGER NOT NULL DEFAULT 0
  `
})
