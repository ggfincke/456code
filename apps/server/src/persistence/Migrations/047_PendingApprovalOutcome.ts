// apps/server/src/persistence/Migrations/047_PendingApprovalOutcome.ts
// adds durable provider approval outcome lifecycle fields

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_pending_approvals)
  `
  const columnNames = new Set(columns.map((column) => column.name))

  if (!columnNames.has('outcome_status'))
  {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN outcome_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (outcome_status IN ('pending', 'responding', 'accepted', 'stale-terminal', 'unknown'))
    `
  }
  if (!columnNames.has('outcome_requested_decision'))
  {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN outcome_requested_decision TEXT NULL
    `
  }
  if (!columnNames.has('outcome_decision'))
  {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN outcome_decision TEXT NULL
    `
  }
  if (!columnNames.has('outcome_detail'))
  {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN outcome_detail TEXT NULL
    `
  }
  if (!columnNames.has('outcome_action_id'))
  {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN outcome_action_id TEXT NULL
    `
  }
  if (!columnNames.has('outcome_acceptance_evidence'))
  {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN outcome_acceptance_evidence TEXT NULL
    `
  }
  if (!columnNames.has('outcome_updated_at'))
  {
    yield* sql`
      ALTER TABLE projection_pending_approvals
      ADD COLUMN outcome_updated_at TEXT NULL
    `
  }

  // derive the outcome from the legacy status rather than defaulting every
  // row to 'pending': a row already resolved before the upgrade would
  // otherwise resurface as an actionable pending approval that no card can
  // answer, and the projection cursor is past its events so nothing corrects it
  yield* sql`
    UPDATE projection_pending_approvals
    SET
      outcome_status = CASE WHEN status = 'resolved' THEN 'accepted' ELSE 'pending' END,
      outcome_decision = CASE WHEN status = 'resolved' THEN decision ELSE outcome_decision END,
      outcome_updated_at = CASE
        WHEN status = 'resolved' THEN COALESCE(resolved_at, created_at)
        ELSE outcome_updated_at
      END
    WHERE outcome_status IS NULL
       OR outcome_status NOT IN ('pending', 'responding', 'accepted', 'stale-terminal', 'unknown')
       OR (status = 'resolved' AND outcome_status = 'pending')
  `
})
