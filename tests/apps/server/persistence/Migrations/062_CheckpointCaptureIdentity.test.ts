// tests/apps/server/persistence/Migrations/062_CheckpointCaptureIdentity.test.ts
// verifies checkpoint identity backfill remains evidence-preserving and non-guessing

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import Migration062 from '../../../../../apps/server/src/persistence/Migrations/062_CheckpointCaptureIdentity.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('062_CheckpointCaptureIdentity', (it) =>
{
  it.effect('retains recorded roots, leaves unknown proof null, and supports turn zero', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE projection_turns (
          thread_id TEXT NOT NULL,
          checkpoint_turn_count INTEGER,
          checkpoint_ref TEXT,
          checkpoint_capture_root TEXT,
          completed_at TEXT
        )
      `
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_capture_root,
          completed_at
        )
        VALUES (
          'thread-legacy',
          1,
          'refs/t3/checkpoint/thread-legacy/1',
          '/recorded/worktree',
          '2026-08-01T00:00:00.000Z'
        )
      `
      yield* sql`
        CREATE TABLE checkpoint_revert_operations (
          operation_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          repository_common_dir TEXT
        )
      `
      yield* sql`
        INSERT INTO checkpoint_revert_operations (
          operation_id,
          cwd,
          repository_common_dir
        )
        VALUES (
          'legacy-revert',
          '/selected/restore-root',
          '/selected/repository/.git'
        )
      `

      yield* Migration062

      const turnColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`
      assert.deepStrictEqual(
        turnColumns
          .map((column) => column.name)
          .filter((name) =>
            ['checkpoint_repository_common_dir', 'checkpoint_commit_oid'].includes(name),
          ),
        ['checkpoint_repository_common_dir', 'checkpoint_commit_oid'],
      )
      const legacyIdentity = yield* sql<{
        readonly checkpointCaptureRoot: string | null
        readonly checkpointRepositoryCommonDir: string | null
        readonly checkpointCommitOid: string | null
      }>`
        SELECT
          checkpoint_capture_root AS "checkpointCaptureRoot",
          checkpoint_repository_common_dir AS "checkpointRepositoryCommonDir",
          checkpoint_commit_oid AS "checkpointCommitOid"
        FROM projection_checkpoint_identities
        WHERE thread_id = 'thread-legacy' AND checkpoint_turn_count = 1
      `
      assert.deepStrictEqual(legacyIdentity, [
        {
          checkpointCaptureRoot: '/recorded/worktree',
          checkpointRepositoryCommonDir: null,
          checkpointCommitOid: null,
        },
      ])

      yield* sql`
        INSERT INTO projection_checkpoint_identities (
          thread_id,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_capture_root,
          checkpoint_repository_common_dir,
          checkpoint_commit_oid,
          captured_at
        )
        VALUES (
          'thread-new',
          0,
          'refs/t3/checkpoint/thread-new/0',
          '/capture/worktree',
          '/capture/repository/.git',
          '0123456789abcdef0123456789abcdef01234567',
          '2026-08-02T00:00:00.000Z'
        )
      `
      const turnZero = yield* sql<{
        readonly checkpointTurnCount: number
        readonly checkpointCommitOid: string
      }>`
        SELECT
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_commit_oid AS "checkpointCommitOid"
        FROM projection_checkpoint_identities
        WHERE thread_id = 'thread-new'
      `
      assert.deepStrictEqual(turnZero, [
        {
          checkpointTurnCount: 0,
          checkpointCommitOid: '0123456789abcdef0123456789abcdef01234567',
        },
      ])

      const legacyJournal = yield* sql<{
        readonly cwd: string
        readonly repositoryCommonDir: string | null
        readonly checkpointCaptureRoot: string | null
        readonly checkpointCommitOid: string | null
      }>`
        SELECT
          cwd,
          repository_common_dir AS "repositoryCommonDir",
          checkpoint_capture_root AS "checkpointCaptureRoot",
          checkpoint_commit_oid AS "checkpointCommitOid"
        FROM checkpoint_revert_operations
        WHERE operation_id = 'legacy-revert'
      `
      assert.deepStrictEqual(legacyJournal, [
        {
          cwd: '/selected/restore-root',
          repositoryCommonDir: '/selected/repository/.git',
          checkpointCaptureRoot: null,
          checkpointCommitOid: null,
        },
      ])
    }),
  )
})
