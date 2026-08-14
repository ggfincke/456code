// tests/apps/server/persistence/Migrations/053_ProposalOrchestratePlanLinks.test.ts
// verifies immutable proposal links do not depend on rebuildable projections

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('053_ProposalOrchestratePlanLinks', (it) =>
{
  it.effect('enforces exact-link uniqueness and only references immutable proposal revisions', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 52 })
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 53 }), [
        [53, 'ProposalOrchestratePlanLinks'],
      ])
      const foreignKeys = yield* sql<{ readonly table: string }>`
        PRAGMA foreign_key_list(proposal_orchestrate_plan_links)
      `
      assert.deepStrictEqual(
        new Set(foreignKeys.map((foreignKey) => foreignKey.table)),
        new Set(['proposal_revisions']),
      )

      yield* sql`
        INSERT INTO proposals (
          proposal_id,
          environment_id,
          project_id,
          source_thread_id,
          producer_session_id,
          producer_instance_id,
          repository_identity_json,
          worktree_root_path,
          worktree_git_dir,
          worktree_git_common_dir,
          created_at,
          updated_at
        )
        VALUES (
          'proposal-link-migration',
          'environment-link-migration',
          'project-link-migration',
          'thread-link-migration',
          'session-link-migration',
          'provider-link-migration',
          '{}',
          '/tmp/worktree',
          '/tmp/worktree/.git',
          '/tmp/worktree/.git',
          '2026-08-07T12:00:00.000Z',
          '2026-08-07T12:00:00.000Z'
        )
      `
      yield* sql`
        INSERT INTO proposal_blobs (sha256, content, byte_length, created_at)
        VALUES (
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          X'',
          0,
          '2026-08-07T12:00:00.000Z'
        )
      `
      for (const revision of [1, 2])
      {
        yield* sql`
          INSERT INTO proposal_revisions (
            revision_id,
            proposal_id,
            revision,
            head_commit_oid,
            base_tree_oid,
            base_retained_ref,
            base_file_count,
            base_byte_count,
            snapshot_policy_json,
            proposed_tree_oid,
            proposed_retained_ref,
            manifest_json,
            manifest_sha256,
            diff_sha256,
            diff_byte_length,
            created_at
          )
          VALUES (
            ${`revision-link-migration-${revision}`},
            'proposal-link-migration',
            ${revision},
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            ${`refs/base/${revision}`},
            0,
            0,
            '{}',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            ${`refs/proposed/${revision}`},
            '{}',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            0,
            '2026-08-07T12:00:00.000Z'
          )
        `
      }

      // no projection row exists for this target; the durable link remains valid independently
      yield* sql`
        INSERT INTO proposal_orchestrate_plan_links (
          proposal_id,
          proposal_revision,
          source_thread_id,
          run_id,
          orchestrate_revision,
          created_at
        )
        VALUES (
          'proposal-link-migration',
          1,
          'thread-link-migration',
          'run-link-migration',
          4,
          '2026-08-07T12:01:00.000Z'
        )
      `
      const duplicateTarget = yield* Effect.exit(sql`
        INSERT INTO proposal_orchestrate_plan_links (
          proposal_id,
          proposal_revision,
          source_thread_id,
          run_id,
          orchestrate_revision,
          created_at
        )
        VALUES (
          'proposal-link-migration',
          2,
          'thread-link-migration',
          'run-link-migration',
          4,
          '2026-08-07T12:02:00.000Z'
        )
      `)
      assert.strictEqual(duplicateTarget._tag, 'Failure')

      yield* sql`
        DELETE FROM proposal_revisions
        WHERE proposal_id = 'proposal-link-migration'
          AND revision = 1
      `
      const links = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM proposal_orchestrate_plan_links
      `
      assert.strictEqual(links[0]?.count, 0)
    }),
  )
})
