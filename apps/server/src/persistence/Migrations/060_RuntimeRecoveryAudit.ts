// apps/server/src/persistence/Migrations/060_RuntimeRecoveryAudit.ts
// adds immutable audit records for explicit runtime recovery actions

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE runtime_recovery_audit (
      audit_id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL CHECK (
        subject_kind IN ('reactor-action', 'checkpoint-revert')
      ),
      subject_id TEXT NOT NULL,
      reactor_id TEXT NULL,
      operation_version INTEGER NULL CHECK (operation_version >= 0),
      actor_session_id TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      effect_kind TEXT NOT NULL,
      recovery_action TEXT NOT NULL,
      before_state_json TEXT NOT NULL,
      after_state_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (
        (
          subject_kind = 'reactor-action'
          AND reactor_id IS NOT NULL
          AND operation_version IS NOT NULL
        )
        OR (
          subject_kind = 'checkpoint-revert'
          AND reactor_id IS NULL
          AND operation_version IS NULL
        )
      )
    )
  `

  yield* sql`
    CREATE INDEX runtime_recovery_audit_subject_history
    ON runtime_recovery_audit(subject_kind, subject_id, created_at, audit_id)
  `

  yield* sql`
    CREATE INDEX runtime_recovery_audit_actor_history
    ON runtime_recovery_audit(actor_session_id, created_at, audit_id)
  `

  yield* sql`
    CREATE INDEX runtime_recovery_audit_reactor_history
    ON runtime_recovery_audit(reactor_id, operation_version, created_at, audit_id)
    WHERE subject_kind = 'reactor-action'
  `

  yield* sql`
    CREATE TRIGGER runtime_recovery_audit_deny_update
    BEFORE UPDATE ON runtime_recovery_audit
    BEGIN
      SELECT RAISE(ABORT, 'runtime recovery audit rows are immutable');
    END
  `

  yield* sql`
    CREATE TRIGGER runtime_recovery_audit_deny_delete
    BEFORE DELETE ON runtime_recovery_audit
    BEGIN
      SELECT RAISE(ABORT, 'runtime recovery audit rows are immutable');
    END
  `
})
