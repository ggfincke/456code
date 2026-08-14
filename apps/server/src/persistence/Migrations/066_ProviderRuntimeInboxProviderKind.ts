// apps/server/src/persistence/Migrations/066_ProviderRuntimeInboxProviderKind.ts
// persists immutable provider kinds for durable provider session generations

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TRIGGER provider_runtime_inbox_sessions_provider_kind_immutable
    BEFORE UPDATE OF provider_kind ON provider_runtime_inbox_sessions
    FOR EACH ROW
    WHEN NEW.provider_kind IS NOT OLD.provider_kind
    BEGIN
      SELECT RAISE(ABORT, 'provider runtime inbox session provider kind is immutable');
    END
  `
})
