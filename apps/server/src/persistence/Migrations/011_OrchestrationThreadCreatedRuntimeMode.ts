// apps/server/src/persistence/Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts
// apply persistence migration 011 orchestration thread created runtime mode

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.runtimeMode', 'full-access')
    WHERE event_type = 'thread.created'
      AND json_type(payload_json, '$.runtimeMode') IS NULL
  `
})
