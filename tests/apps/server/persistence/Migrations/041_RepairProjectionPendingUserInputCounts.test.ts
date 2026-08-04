// tests/apps/server/persistence/Migrations/041_RepairProjectionPendingUserInputCounts.test.ts
// verifies repair of stale pending-input counts from newer provider errors

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('041_RepairProjectionPendingUserInputCounts', (it) =>
{
  it.effect('clears counts for non-hyphenated unknown-request variants', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient

      yield* runMigrations({ toMigrationInclusive: 40 })
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          pending_user_input_count
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-07-31T00:00:00.000Z',
          '2026-07-31T00:00:00.000Z',
          3
        )
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'request-space',
            'thread-1',
            'turn-1',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-space"}',
            1,
            '2026-07-31T00:00:01.000Z'
          ),
          (
            'failure-space',
            'thread-1',
            'turn-1',
            'error',
            'provider.user-input.respond.failed',
            'Provider user input response failed',
            '{"requestId":"input-space","detail":"Unknown pending user input request: input-space"}',
            2,
            '2026-07-31T00:00:02.000Z'
          ),
          (
            'request-codex',
            'thread-1',
            'turn-1',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-codex"}',
            3,
            '2026-07-31T00:00:03.000Z'
          ),
          (
            'failure-codex',
            'thread-1',
            'turn-1',
            'error',
            'provider.user-input.respond.failed',
            'Provider user input response failed',
            '{"requestId":"input-codex","detail":"Unknown pending Codex user input request: input-codex"}',
            4,
            '2026-07-31T00:00:04.000Z'
          ),
          (
            'request-live',
            'thread-1',
            'turn-1',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-live"}',
            5,
            '2026-07-31T00:00:05.000Z'
          ),
          (
            'failure-live',
            'thread-1',
            'turn-1',
            'error',
            'provider.user-input.respond.failed',
            'Provider user input response failed',
            '{"requestId":"input-live","detail":"Provider connection failed"}',
            6,
            '2026-07-31T00:00:06.000Z'
          )
      `

      yield* runMigrations({ toMigrationInclusive: 41 })

      const rows = yield* sql<{ readonly pendingUserInputCount: number }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `
      assert.deepStrictEqual(rows, [{ pendingUserInputCount: 1 }])
    }),
  )
})
