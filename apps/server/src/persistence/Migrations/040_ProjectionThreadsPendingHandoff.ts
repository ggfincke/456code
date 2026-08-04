// apps/server/src/persistence/Migrations/040_ProjectionThreadsPendingHandoff.ts
// adds pending provider handoff state to the thread projection

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `

  if (!columns.some((column) => column.name === 'pending_handoff_json'))
  {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_handoff_json TEXT
    `
  }
})
