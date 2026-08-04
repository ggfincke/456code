// apps/server/src/persistence/Migrations/049_OrchestrationCommandReceiptErrorCode.ts
// preserve typed invariant codes in rejected command receipts

import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as Effect from 'effect/Effect'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN error_code TEXT
  `
})
