// apps/server/src/persistence/Migrations/072_ProjectionThreadsPinnedAt.ts
// adds the nullable pin timestamp to projected threads

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `

  if (!columns.some((column) => column.name === 'pinned_at'))
  {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pinned_at TEXT
    `
  }
})
