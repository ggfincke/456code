// apps/server/src/persistence/Migrations/050_AttachmentLifecycleGenerations.ts
// fences attachment cleanup work to the staged file generation it claimed

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE attachment_staging
    ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)
  `

  yield* sql`
    ALTER TABLE attachment_cleanup
    ADD COLUMN staging_generation INTEGER NULL
      CHECK(staging_generation IS NULL OR staging_generation >= 0)
  `

  yield* sql`
    UPDATE attachment_cleanup
    SET staging_generation = 0
    WHERE staging_key IS NOT NULL
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_attachment_staging_thread
    ON attachment_staging(thread_id, created_at, staging_key)
  `
})
