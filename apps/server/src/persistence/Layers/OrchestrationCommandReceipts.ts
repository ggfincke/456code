// apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts
// assemble orchestration command receipts Effect layer

import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { toPersistenceSqlError } from '../Errors.ts'

import {
  GetByCommandIdInput,
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from '../Services/OrchestrationCommandReceipts.ts'

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error,
          error_code
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error},
          ${receipt.errorCode}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
          aggregate_id = excluded.aggregate_id,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error,
          error_code = excluded.error_code
      `,
  })

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error,
          error_code AS "errorCode"
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  })

  const upsert: OrchestrationCommandReceiptRepositoryShape['upsert'] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError('OrchestrationCommandReceiptRepository.upsert:query')),
    )

  const getByCommandId: OrchestrationCommandReceiptRepositoryShape['getByCommandId'] = (input) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError('OrchestrationCommandReceiptRepository.getByCommandId:query'),
      ),
    )

  return {
    upsert,
    getByCommandId,
  } satisfies OrchestrationCommandReceiptRepositoryShape
})

export const OrchestrationCommandReceiptRepositoryLive = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
)
