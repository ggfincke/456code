// apps/server/src/persistence/Migrations/065_CheckpointRevertProviderGeneration.ts
// adds exact provider generation identity to checkpoint revert journals

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  // null identifies legacy journals that cannot safely select a provider runtime
  yield* sql`
    ALTER TABLE checkpoint_revert_operations
    ADD COLUMN provider_session_generation INTEGER
      CHECK (provider_session_generation IS NULL OR provider_session_generation >= 1)
  `
})
