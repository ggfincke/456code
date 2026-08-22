// tests/apps/server/persistence/Migrations/070_NativeArchitectureViews.test.ts
// verifies immutable planned-impact storage and fenced admission constraints

// @effect-diagnostics preferSchemaOverJson:off

import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { expect } from 'vite-plus/test'

import { runMigrations } from '../../../../../apps/server/src/persistence/Migrations.ts'
import migration070 from '../../../../../apps/server/src/persistence/Migrations/070_NativeArchitectureViews.ts'
import * as NodeSqliteClient from '../../../../../apps/server/src/persistence/NodeSqliteClient.ts'

const layer = it.layer(NodeSqliteClient.layerMemory())

layer('070_NativeArchitectureViews', (it) =>
{
  it.effect('installs exact foreign keys, additive artifact columns, and immutable rows', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      yield* runMigrations({ toMigrationInclusive: 70 })
      yield* migration070

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'architecture_planned_impact_publications',
            'architecture_planned_impact_projections',
            'proposal_revision_planned_impacts',
            'architecture_analysis_admissions'
          )
        ORDER BY name
      `
      expect(tables.map((row) => row.name)).toEqual([
        'architecture_analysis_admissions',
        'architecture_planned_impact_projections',
        'architecture_planned_impact_publications',
        'proposal_revision_planned_impacts',
      ])

      for (const table of ['proposal_generations', 'diff_analysis_generations'])
      {
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(${sql.unsafe(table)})
        `
        expect(columns.map((column) => column.name)).toContain('impact_projection_path')
      }
      const proposalGenerationColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(proposal_generations)
      `
      expect(proposalGenerationColumns.map((column) => column.name)).toContain(
        'architecture_admission_key',
      )
      const diffGenerationColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(diff_analysis_generations)
      `
      expect(diffGenerationColumns.map((column) => column.name)).toContain(
        'implementation_changed_file_count',
      )

      const legacyDiffRows = yield* sql<{
        readonly implementationChangedFileCount: number | null
      }>`
        SELECT implementation_changed_file_count AS "implementationChangedFileCount"
        FROM diff_analysis_generations
      `
      expect(legacyDiffRows.every((row) => row.implementationChangedFileCount === null)).toBe(true)

      const invalidChangedFileCount = yield* sql`
        INSERT INTO diff_analysis_generations (
          diff_analysis_id,
          environment_id,
          repository_key,
          base_tree_oid,
          head_tree_oid,
          base_analyzer_ref,
          head_analyzer_ref,
          analyzer_version,
          analysis_policy_version,
          config_digest,
          scope_digest,
          tsconfig_digest,
          source_descriptor_json,
          state,
          artifact_root,
          implementation_changed_file_count,
          artifact_byte_length,
          created_at,
          updated_at,
          last_accessed_at
        )
        VALUES (
          'diff-analysis-invalid-changed-file-count',
          'environment-migration-070',
          'repository-migration-070',
          ${'1'.repeat(40)},
          ${'2'.repeat(40)},
          'base',
          'head',
          'analyzer',
          'diff-analysis-v1',
          'config',
          'scope',
          'tsconfig',
          '{"sourceKind":"tree-pair","cwd":"/repo","baseTreeOid":"1111111111111111111111111111111111111111","headTreeOid":"2222222222222222222222222222222222222222"}',
          'queued',
          '/tmp/diff-analysis-invalid-changed-file-count',
          -1,
          0,
          '2026-08-20T12:00:00.000Z',
          '2026-08-20T12:00:00.000Z',
          '2026-08-20T12:00:00.000Z'
        )
      `.pipe(Effect.flip)
      expect(invalidChangedFileCount).toMatchObject({ _tag: 'SqlError' })

      const publicationId = 'planned-impact-migration-070'
      yield* sql`
        INSERT INTO architecture_planned_impact_publications (
          publication_id,
          environment_id,
          project_id,
          source_thread_id,
          turn_id,
          provider_session_id,
          provider_instance_id,
          plan_kind,
          plan_identity_key,
          plan_id,
          publication_revision,
          content_digest,
          canonical_payload_json,
          created_at
        )
        VALUES (
          ${publicationId},
          'environment-migration-070',
          'project-migration-070',
          'thread-migration-070',
          'turn-migration-070',
          'provider-session-migration-070',
          'codex',
          'plan',
          'plan:plan-migration-070',
          'plan-migration-070',
          1,
          ${'a'.repeat(64)},
          '{"version":1}',
          '2026-08-20T12:00:00.000Z'
        )
      `
      yield* sql`
        INSERT INTO architecture_planned_impact_projections (
          projection_id,
          publication_id,
          publication_revision,
          projection_revision,
          materialization,
          projection_json,
          projection_digest,
          created_at
        )
        VALUES (
          'planned-projection-migration-070',
          ${publicationId},
          1,
          1,
          'provisional',
          '{"version":1}',
          ${'b'.repeat(64)},
          '2026-08-20T12:00:00.000Z'
        )
      `
      yield* sql`
        INSERT INTO architecture_analysis_admissions (
          admission_id,
          kind,
          admission_key,
          target_json,
          state,
          created_at,
          updated_at
        )
        VALUES (
          'architecture-admission-migration-070',
          'planned-anchor',
          'planned-anchor:migration-070',
          '{"_tag":"planned-anchor","version":1}',
          'queued',
          '2026-08-20T12:00:00.000Z',
          '2026-08-20T12:00:00.000Z'
        )
      `

      const immutableFailure = yield* sql`
        UPDATE architecture_planned_impact_publications
        SET content_digest = ${'c'.repeat(64)}
        WHERE publication_id = ${publicationId}
      `.pipe(Effect.flip)
      expect(immutableFailure).toMatchObject({ _tag: 'SqlError' })
      const unchanged = yield* sql<{ readonly contentDigest: string }>`
        SELECT content_digest AS "contentDigest"
        FROM architecture_planned_impact_publications
        WHERE publication_id = ${publicationId}
      `
      expect(unchanged).toEqual([{ contentDigest: 'a'.repeat(64) }])

      const mismatchedProjection = yield* sql`
        INSERT INTO architecture_planned_impact_projections (
          projection_id,
          publication_id,
          publication_revision,
          projection_revision,
          materialization,
          projection_json,
          projection_digest,
          created_at
        )
        VALUES (
          'planned-projection-mismatched-revision',
          ${publicationId},
          2,
          2,
          'provisional',
          '{"version":1}',
          ${'d'.repeat(64)},
          '2026-08-20T12:00:01.000Z'
        )
      `.pipe(Effect.flip)
      expect(mismatchedProjection).toMatchObject({ _tag: 'SqlError' })

      const oversizedProjection = yield* sql`
        INSERT INTO architecture_planned_impact_projections (
          projection_id,
          publication_id,
          publication_revision,
          projection_revision,
          materialization,
          projection_json,
          projection_digest,
          created_at
        )
        VALUES (
          'planned-projection-oversized',
          ${publicationId},
          1,
          2,
          'provisional',
          ${JSON.stringify({ payload: 'x'.repeat(2_097_153) })},
          ${'d'.repeat(64)},
          '2026-08-20T12:00:01.000Z'
        )
      `.pipe(Effect.flip)
      expect(oversizedProjection).toMatchObject({ _tag: 'SqlError' })

      const invalidLease = yield* sql`
        INSERT INTO architecture_analysis_admissions (
          admission_id,
          kind,
          admission_key,
          target_json,
          state,
          created_at,
          updated_at
        )
        VALUES (
          'architecture-admission-invalid-lease',
          'proposal-verified',
          'proposal-verified:invalid-lease',
          '{"_tag":"proposal-verified","version":1}',
          'leased',
          '2026-08-20T12:00:00.000Z',
          '2026-08-20T12:00:00.000Z'
        )
      `.pipe(Effect.flip)
      expect(invalidLease).toMatchObject({ _tag: 'SqlError' })

      const mutatedAdmissionIdentity = yield* sql`
        UPDATE architecture_analysis_admissions
        SET admission_key = 'planned-anchor:migration-070-mutated'
        WHERE admission_id = 'architecture-admission-migration-070'
      `.pipe(Effect.flip)
      expect(mutatedAdmissionIdentity).toMatchObject({ _tag: 'SqlError' })

      const mismatchedAdmissionKind = yield* sql`
        INSERT INTO architecture_analysis_admissions (
          admission_id,
          kind,
          admission_key,
          target_json,
          state,
          created_at,
          updated_at
        )
        VALUES (
          'architecture-admission-mismatched-kind',
          'planned-anchor',
          'planned-anchor:mismatched-kind',
          '{"_tag":"proposal-verified","version":1}',
          'queued',
          '2026-08-20T12:00:00.000Z',
          '2026-08-20T12:00:00.000Z'
        )
      `.pipe(Effect.flip)
      expect(mismatchedAdmissionKind).toMatchObject({ _tag: 'SqlError' })

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_planned_impact_publications_active',
            'idx_planned_impact_projections_latest',
            'idx_proposal_revision_planned_impacts_publication',
            'idx_architecture_analysis_admissions_due',
            'idx_architecture_analysis_admissions_expired_lease',
            'idx_architecture_analysis_admissions_completed_proposal',
            'idx_proposal_generations_architecture_admission'
          )
        ORDER BY name
      `
      expect(indexes).toHaveLength(7)
    }),
  )
})
