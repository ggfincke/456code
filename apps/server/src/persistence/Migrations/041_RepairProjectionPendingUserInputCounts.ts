// apps/server/src/persistence/Migrations/041_RepairProjectionPendingUserInputCounts.ts
// repairs stale pending-input counts for current provider error variants

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET pending_user_input_count = COALESCE((
      WITH latest_user_input_states AS (
        SELECT
          latest.request_id,
          latest.kind,
          latest.detail
        FROM (
          SELECT
            json_extract(activity.payload_json, '$.requestId') AS request_id,
            activity.kind,
            lower(COALESCE(json_extract(activity.payload_json, '$.detail'), '')) AS detail,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS row_number
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = projection_threads.thread_id
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
            AND activity.kind IN (
              'user-input.requested',
              'user-input.resolved',
              'provider.user-input.respond.failed'
            )
        ) AS latest
        WHERE latest.row_number = 1
      )
      SELECT COUNT(*)
      FROM latest_user_input_states
      WHERE latest_user_input_states.kind = 'user-input.requested'
        OR (
          latest_user_input_states.kind = 'provider.user-input.respond.failed'
          AND latest_user_input_states.detail NOT LIKE '%stale pending user-input request%'
          AND latest_user_input_states.detail NOT LIKE '%unknown pending user-input request%'
          AND latest_user_input_states.detail NOT LIKE '%unknown pending user input request%'
          AND latest_user_input_states.detail NOT LIKE '%unknown pending codex user input request%'
        )
    ), 0)
  `;
});
