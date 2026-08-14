// tests/apps/server/persistence/Migrations/066_ProviderRuntimeInboxProviderKind.test.ts
// verifies provider-kind session identity remains immutable

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration061 from '../../../../../apps/server/src/persistence/Migrations/061_ProviderRuntimeInbox.ts'
import Migration066 from '../../../../../apps/server/src/persistence/Migrations/066_ProviderRuntimeInboxProviderKind.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('066_ProviderRuntimeInboxProviderKind', (it) =>
{
  it.effect('freezes the exact provider kind established by the initial inbox schema', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* Migration061

      yield* sql`
        INSERT INTO provider_runtime_inbox_sessions (
          provider_kind,
          provider_instance_id,
          thread_id,
          session_generation,
          status,
          created_at,
          updated_at
        )
        VALUES ('codex', 'codex-work', 'thread-exact', 1, 'open', '2026-01-01', '2026-01-01')
      `

      yield* Migration066

      const changed = yield* Effect.exit(sql`
        UPDATE provider_runtime_inbox_sessions
        SET provider_kind = 'cursor'
        WHERE thread_id = 'thread-exact'
      `)
      assert.isTrue(changed._tag === 'Failure')

      const invalid = yield* Effect.exit(sql`
        INSERT INTO provider_runtime_inbox_sessions (
          provider_instance_id,
          thread_id,
          session_generation,
          status,
          provider_kind,
          created_at,
          updated_at
        )
        VALUES ('bad-instance', 'thread-invalid', 1, 'open', 'not valid', '2026-01-01', '2026-01-01')
      `)
      assert.isTrue(invalid._tag === 'Failure')
    }),
  )
})
