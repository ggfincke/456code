// tests/apps/server/persistence/Migrations/049_OrchestrationCommandReceiptErrorCode.test.ts
// verifies typed rejection codes survive command receipt schema upgrades

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration002 from '../../../../../apps/server/src/persistence/Migrations/002_OrchestrationCommandReceipts.ts'
import Migration049 from '../../../../../apps/server/src/persistence/Migrations/049_OrchestrationCommandReceiptErrorCode.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('049_OrchestrationCommandReceiptErrorCode', (it) =>
{
  it.effect('adds a nullable error code without changing existing receipts', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* Migration002
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES (
          'command-existing',
          'thread',
          'thread-existing',
          '2026-08-02T00:00:00.000Z',
          0,
          'rejected',
          'existing rejection'
        )
      `

      yield* Migration049

      const rows = yield* sql<{
        readonly commandId: string
        readonly error: string | null
        readonly errorCode: string | null
      }>`
        SELECT
          command_id AS "commandId",
          error,
          error_code AS "errorCode"
        FROM orchestration_command_receipts
        WHERE command_id = 'command-existing'
      `
      assert.deepStrictEqual(rows, [
        {
          commandId: 'command-existing',
          error: 'existing rejection',
          errorCode: null,
        },
      ])

      yield* sql`
        UPDATE orchestration_command_receipts
        SET error_code = 'turn-start-during-switch'
        WHERE command_id = 'command-existing'
      `
      const codedRows = yield* sql<{ readonly errorCode: string | null }>`
        SELECT error_code AS "errorCode"
        FROM orchestration_command_receipts
        WHERE command_id = 'command-existing'
      `
      assert.deepStrictEqual(codedRows, [{ errorCode: 'turn-start-during-switch' }])
    }),
  )
})
