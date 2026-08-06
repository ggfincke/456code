// apps/server/src/persistence/Migrations/042_ProjectionThreadsProviderSwitch.ts
// adds provider switch lifecycle state to the thread projection

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `

  if (!columns.some((column) => column.name === 'provider_switch_json'))
  {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN provider_switch_json TEXT
    `
  }
})
