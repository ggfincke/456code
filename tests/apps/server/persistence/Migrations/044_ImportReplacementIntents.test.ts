// tests/apps/server/persistence/Migrations/044_ImportReplacementIntents.test.ts
// verifies durable import replacement intent schema constraints

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('044_ImportReplacementIntents', (it) =>
{
  it.effect('enforces phase check and normalized unique identity index', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 44 })

      const invalidPhase = yield* Effect.exit(sql`
        INSERT INTO import_replacement_intents (
          intent_key, source, source_path, source_version, replacement_version,
          source_thread_id, source_project_id, replacement_thread_id, replacement_project_id,
          create_command_id, tombstone_command_id, expected_message_count,
          expected_activity_count, expected_record_fingerprint, phase, created_at, updated_at
        )
        VALUES (
          'intent-invalid-phase', 'codex-cli', '/tmp/a.jsonl', 'v1', 'r1',
          'source', 'project', 'replacement', 'project',
          'create', 'tombstone', 1, 0, 'fp', 'bogus',
          '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
        )
      `)
      assert.isTrue(invalidPhase._tag === 'Failure')

      yield* sql`
        INSERT INTO import_replacement_intents (
          intent_key, source, source_path, source_version, replacement_version,
          source_thread_id, source_project_id, replacement_thread_id, replacement_project_id,
          create_command_id, tombstone_command_id, expected_message_count,
          expected_activity_count, expected_record_fingerprint, phase, created_at, updated_at
        )
        VALUES (
          'intent-1', 'codex-cli', '/tmp/a.jsonl', 'v1', 'r1',
          'source', 'project', 'replacement', 'project',
          'create', 'tombstone', 1, 0, 'fp', 'manual',
          '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
        )
      `
      const duplicateIdentity = yield* Effect.exit(sql`
        INSERT INTO import_replacement_intents (
          intent_key, source, source_path, source_version, replacement_version,
          source_thread_id, source_project_id, replacement_thread_id, replacement_project_id,
          create_command_id, tombstone_command_id, expected_message_count,
          expected_activity_count, expected_record_fingerprint, phase, created_at, updated_at
        )
        VALUES (
          'intent-2', 'codex-cli', '/tmp/a.jsonl', 'v1', 'r1',
          'source', 'project', 'replacement', 'project',
          'create-2', 'tombstone-2', 1, 0, 'fp', 'retired',
          '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
        )
      `)
      assert.isTrue(duplicateIdentity._tag === 'Failure')
    }),
  )
})
