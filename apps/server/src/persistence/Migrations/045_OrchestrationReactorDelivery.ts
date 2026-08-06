// apps/server/src/persistence/Migrations/045_OrchestrationReactorDelivery.ts
// adds durable reactor progress and action delivery records

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_reactor_progress (
      reactor_id TEXT PRIMARY KEY,
      operation_version INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('shadow', 'durable', 'paused')),
      cursor_sequence INTEGER NOT NULL DEFAULT 0,
      shadow_cursor_sequence INTEGER NOT NULL DEFAULT 0,
      high_water_sequence INTEGER,
      blocked_sequence INTEGER,
      active_owner_id TEXT,
      owner_epoch INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_reactor_actions (
      action_id TEXT PRIMARY KEY,
      reactor_id TEXT NOT NULL REFERENCES orchestration_reactor_progress(reactor_id),
      source_sequence INTEGER NOT NULL,
      source_event_id TEXT NOT NULL,
      output_index INTEGER NOT NULL CHECK (output_index >= 0),
      effect_kind TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      operation_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'shadow',
          'pending',
          'leased',
          'succeeded',
          'retryable',
          'unknown',
          'poison',
          'manual',
          'resolved'
        )
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_epoch INTEGER,
      lease_expires_at TEXT,
      outcome_json TEXT,
      last_error TEXT,
      resolved_by TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (
        reactor_id,
        source_sequence,
        output_index,
        effect_kind,
        target_kind,
        target_id,
        operation_version
      )
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_reactor_actions_claim
    ON orchestration_reactor_actions(
      reactor_id,
      status,
      available_at,
      source_sequence,
      output_index
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_reactor_actions_source
    ON orchestration_reactor_actions(reactor_id, source_sequence, output_index)
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_reactor_actions_lease_expiry
    ON orchestration_reactor_actions(reactor_id, lease_expires_at)
  `
})
