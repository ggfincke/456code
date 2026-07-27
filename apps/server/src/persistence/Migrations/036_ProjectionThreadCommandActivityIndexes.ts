// apps/server/src/persistence/Migrations/036_ProjectionThreadCommandActivityIndexes.ts
// indexes the bounded command read-model activity projection

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_command_window
    ON projection_thread_activities(
      thread_id,
      CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN sequence ELSE NULL END,
      created_at,
      CASE WHEN sequence IS NULL THEN 1 ELSE 0 END,
      sequence,
      CASE
        WHEN substr(kind, -8) = '.started' OR kind = 'tool.started' THEN 0
        WHEN substr(kind, -10) = '.completed' OR substr(kind, -9) = '.resolved' THEN 2
        ELSE 1
      END,
      activity_id
    )
    WHERE json_valid(payload_json) = 0
      OR COALESCE(json_extract(payload_json, '$.type'), '') <> 'import.continuation'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_command_relevant
    ON projection_thread_activities(thread_id)
    WHERE kind IN (
      'approval.requested',
      'approval.resolved',
      'user-input.requested',
      'user-input.resolved',
      'provider.approval.respond.failed',
      'provider.user-input.respond.failed'
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_import_continuation
    ON projection_thread_activities(
      thread_id,
      CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN sequence ELSE NULL END,
      created_at,
      CASE WHEN sequence IS NULL THEN 1 ELSE 0 END,
      sequence,
      CASE
        WHEN substr(kind, -8) = '.started' OR kind = 'tool.started' THEN 0
        WHEN substr(kind, -10) = '.completed' OR substr(kind, -9) = '.resolved' THEN 2
        ELSE 1
      END,
      activity_id
    )
    WHERE json_valid(payload_json) = 1
      AND json_extract(payload_json, '$.type') = 'import.continuation'
  `;
});
