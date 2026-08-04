// apps/server/src/persistence/Migrations/012_ProjectionThreadsInteractionMode.ts
// apply persistence migration 012 projection threads interaction mode

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'
  `
})
