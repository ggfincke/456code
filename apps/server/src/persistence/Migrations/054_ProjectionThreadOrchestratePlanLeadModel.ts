// apps/server/src/persistence/Migrations/054_ProjectionThreadOrchestratePlanLeadModel.ts
// records the lead session's model selection on each orchestrate plan revision

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  // nullable with no default and no backfill: the revisions written before this
  // column existed carry no lead binding in their source events either, so a
  // projection rebuild reproduces NULL for them regardless
  yield* sql`
    ALTER TABLE projection_thread_orchestrate_plans
    ADD COLUMN lead_model_selection_json TEXT
  `
})
