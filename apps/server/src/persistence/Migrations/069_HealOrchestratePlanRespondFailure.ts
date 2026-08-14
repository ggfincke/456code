// apps/server/src/persistence/Migrations/069_HealOrchestratePlanRespondFailure.ts
// frees split-brain approved plans after a failed envelope and indexes that activity

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_command_relevant`
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_command_relevant
    ON projection_thread_activities(thread_id)
    WHERE kind IN (
      'approval.requested',
      'approval.resolved',
      'user-input.requested',
      'user-input.resolved',
      'provider.approval.respond.failed',
      'provider.user-input.respond.failed',
      'provider.orchestrate-plan.respond.failed'
    )
  `

  // tagged failures pin runId+revision; leave later successful approves alone
  yield* sql`
    UPDATE projection_thread_orchestrate_plans AS plans
    SET status = 'pending'
    WHERE plans.status IN ('approved', 'rejected')
      AND EXISTS (
        SELECT 1
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = plans.thread_id
          AND activity.kind = 'provider.orchestrate-plan.respond.failed'
          AND json_valid(activity.payload_json) = 1
          AND typeof(json_extract(activity.payload_json, '$.runId')) = 'text'
          AND length(json_extract(activity.payload_json, '$.runId')) > 0
          AND json_extract(activity.payload_json, '$.runId') = plans.run_id
          AND json_extract(activity.payload_json, '$.revision') = plans.revision
          AND plans.updated_at <= activity.created_at
      )
  `

  // legacy detail-only failures occupy the newest approved/rejected stamp
  yield* sql`
    UPDATE projection_thread_orchestrate_plans
    SET status = 'pending'
    WHERE rowid IN (
      SELECT plans.rowid
      FROM projection_thread_orchestrate_plans AS plans
      INNER JOIN projection_thread_activities AS activity
        ON activity.thread_id = plans.thread_id
        AND activity.kind = 'provider.orchestrate-plan.respond.failed'
      WHERE plans.status IN ('approved', 'rejected')
        AND plans.updated_at <= activity.created_at
        AND (
          json_valid(activity.payload_json) = 0
          OR typeof(json_extract(activity.payload_json, '$.runId')) <> 'text'
          OR length(COALESCE(json_extract(activity.payload_json, '$.runId'), '')) = 0
        )
        AND plans.rowid = (
          SELECT newest.rowid
          FROM projection_thread_orchestrate_plans AS newest
          WHERE newest.thread_id = plans.thread_id
            AND newest.status IN ('approved', 'rejected')
            AND newest.updated_at <= activity.created_at
          ORDER BY newest.updated_at DESC, newest.revision DESC
          LIMIT 1
        )
    )
  `
})
