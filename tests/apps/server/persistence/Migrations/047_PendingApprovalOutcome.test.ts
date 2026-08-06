// tests/apps/server/persistence/Migrations/047_PendingApprovalOutcome.test.ts
// verifies durable pending approval outcome columns and constraints

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration005 from '../../../../../apps/server/src/persistence/Migrations/005_Projections.ts'
import Migration047 from '../../../../../apps/server/src/persistence/Migrations/047_PendingApprovalOutcome.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('047_PendingApprovalOutcome', (it) =>
{
  it.effect('adds outcome columns, backfills rows, and enforces status values', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* Migration005
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES (
          'approval-existing',
          'thread-1',
          'turn-1',
          'pending',
          NULL,
          '2026-08-02T00:00:00.000Z',
          NULL
        )
      `

      yield* Migration047

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_pending_approvals)
      `
      const names = new Set(columns.map((column) => column.name))
      assert.deepStrictEqual(
        [
          'outcome_status',
          'outcome_requested_decision',
          'outcome_decision',
          'outcome_detail',
          'outcome_action_id',
          'outcome_acceptance_evidence',
          'outcome_updated_at',
        ].filter((name) => names.has(name)),
        [
          'outcome_status',
          'outcome_requested_decision',
          'outcome_decision',
          'outcome_detail',
          'outcome_action_id',
          'outcome_acceptance_evidence',
          'outcome_updated_at',
        ],
      )

      const rows = yield* sql<{ readonly status: string }>`
        SELECT outcome_status AS "status"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-existing'
      `
      assert.deepStrictEqual(rows, [{ status: 'pending' }])

      const invalid = yield* Effect.exit(sql`
        UPDATE projection_pending_approvals
        SET outcome_status = 'invalid'
        WHERE request_id = 'approval-existing'
      `)
      assert.strictEqual(invalid._tag, 'Failure')
    }),
  )
})
