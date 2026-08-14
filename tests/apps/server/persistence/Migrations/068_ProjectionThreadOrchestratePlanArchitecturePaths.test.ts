// tests/apps/server/persistence/Migrations/068_ProjectionThreadOrchestratePlanArchitecturePaths.test.ts
// verifies standing-atlas path lists survive projection rebuild from upsert events

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration068 from '../../../../../apps/server/src/persistence/Migrations/068_ProjectionThreadOrchestratePlanArchitecturePaths.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('068_ProjectionThreadOrchestratePlanArchitecturePaths', (it) =>
{
  it.effect('adds a nullable column and backfills only exact array payloads', () =>
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
        VALUES
          ('thread-1', 'run-1', 2),
          ('thread-legacy', 'run-legacy', 1)
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
          '{"threadId":"thread-1","plan":{"runId":"run-1","revision":2,"architecturePaths":["src/api.ts","apps/web"]}}'
        )
      `

      yield* Migration068

      const plans = yield* sql<{
        readonly threadId: string
        readonly architecturePathsJson: string | null
      }>`
        SELECT
          thread_id AS "threadId",
          architecture_paths_json AS "architecturePathsJson"
        FROM projection_thread_orchestrate_plans
        ORDER BY thread_id
      `
      assert.deepStrictEqual(plans, [
        { threadId: 'thread-1', architecturePathsJson: '["src/api.ts","apps/web"]' },
        { threadId: 'thread-legacy', architecturePathsJson: null },
      ])
    }),
  )
})
