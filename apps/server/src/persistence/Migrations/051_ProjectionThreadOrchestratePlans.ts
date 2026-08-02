// apps/server/src/persistence/Migrations/051_ProjectionThreadOrchestratePlans.ts
// creates durable orchestrate plan revision projection storage

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_orchestrate_plans (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      turn_id TEXT,
      workflow TEXT NOT NULL,
      task TEXT NOT NULL,
      stages_json TEXT NOT NULL,
      total_workers INTEGER NOT NULL,
      max_workers INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, run_id, revision)
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_orchestrate_plans_thread_created
    ON projection_thread_orchestrate_plans(thread_id, created_at)
  `
})
