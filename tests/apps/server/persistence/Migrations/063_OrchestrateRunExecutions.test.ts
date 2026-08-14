// tests/apps/server/persistence/Migrations/063_OrchestrateRunExecutions.test.ts
// verifies exact run execution provenance and terminal evidence remain immutable

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration063 from '../../../../../apps/server/src/persistence/Migrations/063_OrchestrateRunExecutions.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('063_OrchestrateRunExecutions', (it) =>
{
  it.effect(
    'backfills only exact plan events and freezes terminal evidence while allowing prune state',
    () =>
      Effect.gen(function* ()
      {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
        CREATE TABLE projection_thread_orchestrate_plans (
          thread_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          PRIMARY KEY (thread_id, run_id, revision)
        )
      `
        yield* sql`
        CREATE TABLE orchestration_events (
          sequence INTEGER PRIMARY KEY,
          aggregate_kind TEXT NOT NULL,
          stream_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `
        yield* sql`
        INSERT INTO projection_thread_orchestrate_plans (thread_id, run_id, revision)
        VALUES ('thread-1', 'run-1', 2), ('thread-legacy', 'run-legacy', 1)
      `
        yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          aggregate_kind,
          stream_id,
          event_type,
          payload_json
        )
        VALUES (
          41,
          'thread',
          'thread-1',
          'thread.orchestrate-plan-upserted',
          '{"threadId":"thread-1","plan":{"runId":"run-1","revision":2}}'
        )
      `

        yield* Migration063

        const plans = yield* sql<{
          readonly threadId: string
          readonly sourceSequence: number | null
        }>`
        SELECT
          thread_id AS "threadId",
          source_sequence AS "sourceSequence"
        FROM projection_thread_orchestrate_plans
        ORDER BY thread_id
      `
        assert.deepStrictEqual(plans, [
          { threadId: 'thread-1', sourceSequence: 41 },
          { threadId: 'thread-legacy', sourceSequence: null },
        ])

        yield* sql`
        INSERT INTO projection_orchestrate_runs (
          thread_id,
          run_id,
          current_plan_revision,
          created_at,
          updated_at
        )
        VALUES ('thread-1', 'run-1', 2, '2026-08-09T00:00:00.000Z', '2026-08-09T00:01:00.000Z')
      `
        yield* sql`
        INSERT INTO projection_orchestrate_run_executions (
          thread_id,
          run_id,
          plan_revision,
          source_turn_id,
          source_sequence,
          repository_root,
          repository_common_dir,
          base_oid,
          lifecycle,
          availability,
          integration_root,
          integration_common_dir,
          integration_branch,
          integration_oid,
          observed_head_oid,
          final_head_oid,
          close_reason,
          is_current,
          admitted_at,
          updated_at,
          terminal_at
        )
        VALUES (
          'thread-1',
          'run-1',
          2,
          'turn-1',
          41,
          '/repo',
          '/repo/.git',
          'base-oid',
          'completed',
          'available',
          '/repo/worktrees/run-1',
          '/repo/.git',
          'run-1',
          'head-oid',
          'head-oid',
          'head-oid',
          'completed',
          1,
          '2026-08-09T00:00:00.000Z',
          '2026-08-09T00:01:00.000Z',
          '2026-08-09T00:01:00.000Z'
        )
      `

        const staleTerminalUpdate = yield* sql`
        UPDATE projection_orchestrate_run_executions
        SET
          observed_head_oid = 'stale-head',
          final_head_oid = 'stale-head',
          close_reason = 'stale completion',
          terminal_at = '2026-08-09T00:02:00.000Z'
        WHERE thread_id = 'thread-1' AND run_id = 'run-1' AND plan_revision = 2
      `.pipe(Effect.result)
        assert.isTrue(Result.isFailure(staleTerminalUpdate))

        yield* sql`
        UPDATE projection_orchestrate_run_executions
        SET availability = 'unavailable', is_current = 0, updated_at = '2026-08-09T00:03:00.000Z'
        WHERE thread_id = 'thread-1' AND run_id = 'run-1' AND plan_revision = 2
      `
        const retained = yield* sql<{
          readonly lifecycle: string
          readonly availability: string
          readonly observedHeadOid: string
          readonly finalHeadOid: string
          readonly terminalAt: string
          readonly current: number
        }>`
        SELECT
          lifecycle,
          availability,
          observed_head_oid AS "observedHeadOid",
          final_head_oid AS "finalHeadOid",
          terminal_at AS "terminalAt",
          is_current AS "current"
        FROM projection_orchestrate_run_executions
        WHERE thread_id = 'thread-1' AND run_id = 'run-1' AND plan_revision = 2
      `
        assert.deepStrictEqual(retained, [
          {
            lifecycle: 'completed',
            availability: 'unavailable',
            observedHeadOid: 'head-oid',
            finalHeadOid: 'head-oid',
            terminalAt: '2026-08-09T00:01:00.000Z',
            current: 0,
          },
        ])
      }),
  )
})
