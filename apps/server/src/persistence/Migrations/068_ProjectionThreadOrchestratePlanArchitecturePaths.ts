// apps/server/src/persistence/Migrations/068_ProjectionThreadOrchestratePlanArchitecturePaths.ts
// persists standing-atlas scope paths on each orchestrate plan revision

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE projection_thread_orchestrate_plans
    ADD COLUMN architecture_paths_json TEXT
  `

  // older rows can recover paths from the immutable upsert event; missing or
  // non-array payloads stay NULL so the plan card omits the scope strip
  yield* sql`
    UPDATE projection_thread_orchestrate_plans AS plans
    SET architecture_paths_json = (
      SELECT json(json_extract(events.payload_json, '$.plan.architecturePaths'))
      FROM orchestration_events AS events
      WHERE events.aggregate_kind = 'thread'
        AND events.stream_id = plans.thread_id
        AND events.event_type = 'thread.orchestrate-plan-upserted'
        AND json_valid(events.payload_json) = 1
        AND json_type(events.payload_json, '$.plan.architecturePaths') = 'array'
        AND json_extract(events.payload_json, '$.plan.runId') = plans.run_id
        AND json_extract(events.payload_json, '$.plan.revision') = plans.revision
      ORDER BY events.sequence DESC
      LIMIT 1
    )
  `
})
