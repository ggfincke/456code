// tests/apps/server/persistence/Migrations/019_029_ProjectionIndexes.test.ts
// verify projection snapshot lookup and thread-detail ordering indexes

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('019_029_ProjectionIndexes', (it) =>
{
  it.effect('creates projection lookup and thread-detail ordering indexes', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient

      yield* runMigrations({ toMigrationInclusive: 19 })

      const projectIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_projects)
      `
      assert.ok(
        projectIndexes.some(
          (index) => index.name === 'idx_projection_projects_workspace_root_deleted_at',
        ),
      )
      const projectIndexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_projects_workspace_root_deleted_at')
      `
      assert.deepStrictEqual(
        projectIndexColumns.map((column) => column.name),
        ['workspace_root', 'deleted_at'],
      )

      const threadIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `
      assert.ok(
        threadIndexes.some(
          (index) => index.name === 'idx_projection_threads_project_deleted_created',
        ),
      )
      const threadIndexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_threads_project_deleted_created')
      `
      assert.deepStrictEqual(
        threadIndexColumns.map((column) => column.name),
        ['project_id', 'deleted_at', 'created_at'],
      )

      yield* runMigrations({ toMigrationInclusive: 29 })

      const activityIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `
      assert.ok(
        activityIndexes.some(
          (index) => index.name === 'idx_projection_thread_activities_thread_sequence_created_id',
        ),
      )
      const activityIndexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_activities_thread_sequence_created_id')
      `
      assert.deepStrictEqual(
        activityIndexColumns.map((column) => column.name),
        ['thread_id', 'sequence', 'created_at', 'activity_id'],
      )

      const messageIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_messages)
      `
      assert.ok(
        messageIndexes.some(
          (index) => index.name === 'idx_projection_thread_messages_thread_created_id',
        ),
      )
      const messageIndexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_messages_thread_created_id')
      `
      assert.deepStrictEqual(
        messageIndexColumns.map((column) => column.name),
        ['thread_id', 'created_at', 'message_id'],
      )
    }),
  )
})
