// apps/server/src/persistence/Migrations/064_ProjectionThreadArchiveGeneration.ts
// adds the monotonic archive lifecycle generation to projected threads

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  // legacy rows begin at generation zero; only a new archive event advances it
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN archive_generation INTEGER NOT NULL DEFAULT 0
      CHECK(archive_generation >= 0)
  `
})
