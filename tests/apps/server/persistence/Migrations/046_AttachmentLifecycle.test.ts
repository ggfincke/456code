// tests/apps/server/persistence/Migrations/046_AttachmentLifecycle.test.ts
// verifies durable attachment lifecycle schema installation

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('046_AttachmentLifecycle', (it) =>
{
  it.effect('installs staging and cleanup tables with enforced lifecycle states', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 45 })
      yield* runMigrations({ toMigrationInclusive: 46 })

      const invalid = yield* Effect.exit(sql`
        INSERT INTO attachment_staging (
          staging_key,
          command_id,
          thread_id,
          message_id,
          attachment_index,
          attachment_id,
          staging_relative_path,
          relative_path,
          mime_type,
          byte_count,
          content_digest,
          state,
          created_at,
          updated_at
        )
        VALUES (
          'key', 'command', 'thread', 'message', 0, 'attachment',
          '.staging/key/attachment.png', 'attachment.png', 'image/png', 1, 'digest',
          'invalid', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
        )
      `)
      assert.isTrue(invalid._tag === 'Failure')
    }),
  )
})
