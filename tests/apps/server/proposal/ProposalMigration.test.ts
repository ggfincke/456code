// tests/apps/server/proposal/ProposalMigration.test.ts
// verifies proposal storage installs cleanly on a brand-new database

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../../../../apps/server/src/persistence/Migrations.ts'
import * as NodeSqliteClient from '../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))

layer('037_Proposals', (it) =>
{
  it.effect('creates immutable revision and content-addressed blob tables from empty state', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient

      const executed = yield* runMigrations({ toMigrationInclusive: 43 })
      const tableRows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'proposals',
            'proposal_revisions',
            'proposal_blobs',
            'proposal_generations',
            'proposal_implementation_attempts',
            'proposal_retained_ref_attempts'
          )
        ORDER BY name
      `
      const revisionIndexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'proposal_revisions'
      `
      const revisionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(proposal_revisions)
      `

      assert.deepStrictEqual(
        tableRows.map((row) => row.name),
        [
          'proposal_blobs',
          'proposal_generations',
          'proposal_implementation_attempts',
          'proposal_retained_ref_attempts',
          'proposal_revisions',
          'proposals',
        ],
      )
      assert.isTrue(
        revisionIndexes.some((row) => row.name === 'idx_proposal_revisions_proposal_revision'),
      )
      assert.isTrue(revisionColumns.some((row) => row.name === 'narrative_sha256'))
      assert.isTrue(revisionColumns.some((row) => row.name === 'narrative_byte_length'))
      const retainedRefAttemptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(proposal_retained_ref_attempts)
      `
      assert.deepStrictEqual(
        retainedRefAttemptColumns.map((row) => row.name),
        ['ref_token', 'git_common_dir', 'base_ref', 'proposed_ref', 'created_at', 'durable_at'],
      )
      const invalidToken = yield* Effect.exit(sql`
        INSERT INTO proposal_retained_ref_attempts (
          ref_token,
          git_common_dir,
          base_ref,
          proposed_ref,
          created_at
        ) VALUES ('short', '/tmp/repo/.git', 'refs/t3/proposals/short/base', 'refs/t3/proposals/short/proposed', '2026-01-01T00:00:00.000Z')
      `)
      const tokenA = 'a'.repeat(64)
      const tokenB = 'b'.repeat(64)
      const mismatchedPair = yield* Effect.exit(sql`
        INSERT INTO proposal_retained_ref_attempts (
          ref_token,
          git_common_dir,
          base_ref,
          proposed_ref,
          created_at
        ) VALUES (${tokenA}, '/tmp/repo/.git', ${`refs/t3/proposals/${tokenB}/base`}, ${`refs/t3/proposals/${tokenA}/proposed`}, '2026-01-01T00:00:00.000Z')
      `)
      assert.isTrue(Exit.isFailure(invalidToken))
      assert.isTrue(Exit.isFailure(mismatchedPair))
      assert.deepStrictEqual(executed.at(-1), [43, 'ProposalRetainedRefAttempts'])
    }),
  )
})
