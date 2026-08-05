// apps/server/src/persistence/Migrations/018_ProjectionThreadsArchivedAtIndex.ts
// apply persistence migration 018 projection threads archived at index

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_at
    ON projection_threads(project_id, archived_at)
  `
})
