// apps/server/src/persistence/Migrations/009_ProviderSessionRuntimeMode.ts
// apply persistence migration 009 provider session runtime mode

import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as Effect from 'effect/Effect'

export default Effect.asVoid(SqlClient.SqlClient)
