// tests/apps/server/persistence/Migrations/069_HealOrchestratePlanRespondFailure.test.ts
// verifies split-brain approved plans revert without touching later approves

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration069 from '../../../../../apps/server/src/persistence/Migrations/069_HealOrchestratePlanRespondFailure.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('069_HealOrchestratePlanRespondFailure', (it) =>
{
  it.effect('reverts a legacy approved plan and preserves a later approve', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP TABLE IF EXISTS projection_thread_activities`
      yield* sql`DROP TABLE IF EXISTS projection_thread_orchestrate_plans`
      yield* sql`
        CREATE TABLE projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE projection_thread_orchestrate_plans (
          thread_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, run_id, revision)
        )
      `
      yield* sql`
        INSERT INTO projection_thread_orchestrate_plans (
          thread_id,
          run_id,
          revision,
          status,
          updated_at
        )
        VALUES
          (
            '6d34962e-b6b1-46bf-adb4-8ef9dde32cf2',
            'cartographer-current-scope-20260813',
            1,
            'approved',
            '2026-08-13T17:42:59.386Z'
          ),
          (
            'thread-later-approve',
            'run-later',
            1,
            'approved',
            '2026-08-13T18:00:00.000Z'
          )
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          kind,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-legacy',
            '6d34962e-b6b1-46bf-adb4-8ef9dde32cf2',
            'provider.orchestrate-plan.respond.failed',
            '{"detail":"No active provider session is bound to this thread."}',
            '2026-08-13T17:42:59.386Z'
          ),
          (
            'activity-stale',
            'thread-later-approve',
            'provider.orchestrate-plan.respond.failed',
            '{"detail":"No active provider session is bound to this thread."}',
            '2026-08-13T17:42:59.386Z'
          )
      `

      yield* Migration069

      const plans = yield* sql<{
        readonly threadId: string
        readonly status: string
      }>`
        SELECT thread_id AS "threadId", status
        FROM projection_thread_orchestrate_plans
        ORDER BY thread_id
      `
      assert.deepStrictEqual(plans, [
        { threadId: '6d34962e-b6b1-46bf-adb4-8ef9dde32cf2', status: 'pending' },
        { threadId: 'thread-later-approve', status: 'approved' },
      ])
    }),
  )

  it.effect('reverts a tagged approved plan without touching a later approve', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP TABLE IF EXISTS projection_thread_activities`
      yield* sql`DROP TABLE IF EXISTS projection_thread_orchestrate_plans`
      yield* sql`
        CREATE TABLE projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE projection_thread_orchestrate_plans (
          thread_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, run_id, revision)
        )
      `
      yield* sql`
        INSERT INTO projection_thread_orchestrate_plans (
          thread_id,
          run_id,
          revision,
          status,
          updated_at
        )
        VALUES
          (
            'thread-tagged',
            'run-tagged',
            2,
            'approved',
            '2026-08-13T17:42:59.386Z'
          ),
          (
            'thread-tagged-later',
            'run-later',
            1,
            'approved',
            '2026-08-13T18:00:00.000Z'
          )
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          kind,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-tagged',
            'thread-tagged',
            'provider.orchestrate-plan.respond.failed',
            '{"detail":"simulated envelope delivery failure","runId":"run-tagged","revision":2}',
            '2026-08-13T17:42:59.386Z'
          ),
          (
            'activity-stale-tagged',
            'thread-tagged-later',
            'provider.orchestrate-plan.respond.failed',
            '{"detail":"simulated envelope delivery failure","runId":"run-later","revision":1}',
            '2026-08-13T17:42:59.386Z'
          )
      `

      yield* Migration069

      const plans = yield* sql<{
        readonly threadId: string
        readonly status: string
      }>`
        SELECT thread_id AS "threadId", status
        FROM projection_thread_orchestrate_plans
        ORDER BY thread_id
      `
      assert.deepStrictEqual(plans, [
        { threadId: 'thread-tagged', status: 'pending' },
        { threadId: 'thread-tagged-later', status: 'approved' },
      ])
    }),
  )
})
