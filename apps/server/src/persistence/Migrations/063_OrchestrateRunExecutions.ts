// apps/server/src/persistence/Migrations/063_OrchestrateRunExecutions.ts
// persists authoritative orchestrate run execution identity and immutable job evidence

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  // the plan event sequence is exact source evidence. historical rows are
  // backfilled only from their matching immutable event, never inferred from
  // a current thread or broker record
  yield* sql`
    ALTER TABLE projection_thread_orchestrate_plans
    ADD COLUMN source_sequence INTEGER
  `

  yield* sql`
    UPDATE projection_thread_orchestrate_plans AS plans
    SET source_sequence = (
      SELECT events.sequence
      FROM orchestration_events AS events
      WHERE events.aggregate_kind = 'thread'
        AND events.stream_id = plans.thread_id
        AND events.event_type = 'thread.orchestrate-plan-upserted'
        AND json_valid(events.payload_json) = 1
        AND json_extract(events.payload_json, '$.plan.runId') = plans.run_id
        AND json_extract(events.payload_json, '$.plan.revision') = plans.revision
      ORDER BY events.sequence DESC
      LIMIT 1
    )
  `

  yield* sql`
    CREATE TABLE projection_orchestrate_runs (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      current_plan_revision INTEGER NOT NULL CHECK (current_plan_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, run_id)
    )
  `

  yield* sql`
    CREATE TABLE projection_orchestrate_run_executions (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0),
      source_turn_id TEXT NOT NULL,
      source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
      repository_root TEXT NOT NULL,
      repository_common_dir TEXT NOT NULL,
      base_oid TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (
        lifecycle IN ('active', 'completed', 'failed', 'cancelled', 'superseded')
      ),
      availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
      integration_root TEXT,
      integration_common_dir TEXT,
      integration_branch TEXT,
      integration_oid TEXT,
      observed_head_oid TEXT,
      final_head_oid TEXT,
      close_reason TEXT,
      is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
      admitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      PRIMARY KEY (thread_id, run_id, plan_revision),
      FOREIGN KEY (thread_id, run_id)
        REFERENCES projection_orchestrate_runs(thread_id, run_id),
      CHECK (
        availability = 'unavailable'
        OR (integration_root IS NOT NULL AND integration_common_dir IS NOT NULL)
      ),
      CHECK (
        (lifecycle = 'active' AND terminal_at IS NULL AND final_head_oid IS NULL)
        OR (lifecycle <> 'active' AND terminal_at IS NOT NULL)
      ),
      CHECK (lifecycle <> 'completed' OR final_head_oid IS NOT NULL),
      CHECK (final_head_oid IS NULL OR final_head_oid = observed_head_oid)
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX projection_orchestrate_run_executions_current_thread
    ON projection_orchestrate_run_executions(thread_id)
    WHERE is_current = 1
  `

  yield* sql`
    CREATE INDEX projection_orchestrate_run_executions_run_history
    ON projection_orchestrate_run_executions(thread_id, run_id, plan_revision DESC)
  `

  yield* sql`
    CREATE TABLE projection_orchestrate_execution_jobs (
      job_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0),
      status TEXT NOT NULL CHECK (
        status IN ('completed', 'failed', 'rejected', 'cancelled')
      ),
      request_run_id TEXT NOT NULL,
      request_repository_root TEXT NOT NULL,
      result_repository_root TEXT,
      repository_common_dir TEXT NOT NULL,
      base_oid TEXT NOT NULL,
      head_oid TEXT,
      worktree_root TEXT,
      branch TEXT,
      bound_at TEXT NOT NULL,
      FOREIGN KEY (thread_id, run_id, plan_revision)
        REFERENCES projection_orchestrate_run_executions(
          thread_id,
          run_id,
          plan_revision
        )
    )
  `

  yield* sql`
    CREATE INDEX projection_orchestrate_execution_jobs_execution
    ON projection_orchestrate_execution_jobs(thread_id, run_id, plan_revision, job_id)
  `

  // captured source/repository/base identity is immutable. once lifecycle
  // leaves active, every result/evidence field freezes together; later path
  // pruning may change only availability/current bookkeeping and updated_at
  yield* sql`
    CREATE TRIGGER projection_orchestrate_execution_identity_immutable
    BEFORE UPDATE ON projection_orchestrate_run_executions
    WHEN OLD.thread_id IS NOT NEW.thread_id
      OR OLD.run_id IS NOT NEW.run_id
      OR OLD.plan_revision IS NOT NEW.plan_revision
      OR OLD.source_turn_id IS NOT NEW.source_turn_id
      OR OLD.source_sequence IS NOT NEW.source_sequence
      OR OLD.repository_root IS NOT NEW.repository_root
      OR OLD.repository_common_dir IS NOT NEW.repository_common_dir
      OR OLD.base_oid IS NOT NEW.base_oid
      OR OLD.admitted_at IS NOT NEW.admitted_at
      OR (
        OLD.lifecycle <> 'active'
        AND (
          OLD.lifecycle IS NOT NEW.lifecycle
          OR OLD.integration_root IS NOT NEW.integration_root
          OR OLD.integration_common_dir IS NOT NEW.integration_common_dir
          OR OLD.integration_branch IS NOT NEW.integration_branch
          OR OLD.integration_oid IS NOT NEW.integration_oid
          OR OLD.observed_head_oid IS NOT NEW.observed_head_oid
          OR OLD.final_head_oid IS NOT NEW.final_head_oid
          OR OLD.close_reason IS NOT NEW.close_reason
          OR OLD.terminal_at IS NOT NEW.terminal_at
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'orchestrate execution identity is immutable');
    END
  `

  yield* sql`
    CREATE TRIGGER projection_orchestrate_execution_job_immutable
    BEFORE UPDATE ON projection_orchestrate_execution_jobs
    BEGIN
      SELECT RAISE(ABORT, 'orchestrate execution job evidence is immutable');
    END
  `
})
