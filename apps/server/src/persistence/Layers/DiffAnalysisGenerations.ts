// apps/server/src/persistence/Layers/DiffAnalysisGenerations.ts
// assembles diff analysis generation persistence

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import { PersistenceSqlError, toPersistenceSqlOrDecodeError } from '../Errors.ts'
import {
  DiffAnalysisCacheIdentity,
  DiffAnalysisGenerationConditionalDeleteInput,
  DiffAnalysisGenerationCutoffInput,
  DiffAnalysisGenerationIdInput,
  DiffAnalysisGenerationRecord,
  DiffAnalysisGenerationRepository,
  DiffAnalysisGenerationRepositoryInput,
  DiffAnalysisGenerationRetryInput,
  DiffAnalysisGenerationTouchInput,
  DiffAnalysisGenerationUpdate,
  type DiffAnalysisGenerationRepositoryShape,
} from '../Services/DiffAnalysisGenerations.ts'

const DiffAnalysisGenerationDbRow = DiffAnalysisGenerationRecord.mapFields(
  Struct.assign({ source: Schema.fromJsonString(DiffAnalysisGenerationRecord.fields.source) }),
)

const generationColumns = `
  diff_analysis_id AS "diffAnalysisId",
  environment_id AS "environmentId",
  repository_key AS "repositoryKey",
  base_tree_oid AS "baseTreeOid",
  head_tree_oid AS "headTreeOid",
  base_analyzer_ref AS "baseAnalyzerRef",
  head_analyzer_ref AS "headAnalyzerRef",
  analyzer_version AS "analyzerVersion",
  analysis_policy_version AS "analysisPolicyVersion",
  config_digest AS "configDigest",
  scope_digest AS "scopeDigest",
  tsconfig_digest AS "tsconfigDigest",
  source_descriptor_json AS "source",
  state,
  artifact_root AS "artifactRoot",
  head_root_path AS "headRootPath",
  base_graph_path AS "baseGraphPath",
  head_graph_path AS "headGraphPath",
  impact_path AS "impactPath",
  artifact_byte_length AS "artifactByteLength",
  error_code AS "errorCode",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  last_accessed_at AS "lastAccessedAt"
`

const makeDiffAnalysisGenerationRepository = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const insert = SqlSchema.findOneOption({
    Request: DiffAnalysisGenerationDbRow,
    Result: DiffAnalysisGenerationDbRow,
    execute: (row) =>
      sql.unsafe(
        `
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
            head_root_path,
            base_graph_path,
            head_graph_path,
            impact_path,
            artifact_byte_length,
            error_code,
            created_at,
            updated_at,
            last_accessed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
          RETURNING ${generationColumns}
        `,
        [
          row.diffAnalysisId,
          row.environmentId,
          row.repositoryKey,
          row.baseTreeOid,
          row.headTreeOid,
          row.baseAnalyzerRef,
          row.headAnalyzerRef,
          row.analyzerVersion,
          row.analysisPolicyVersion,
          row.configDigest,
          row.scopeDigest,
          row.tsconfigDigest,
          row.source,
          row.state,
          row.artifactRoot,
          row.headRootPath,
          row.baseGraphPath,
          row.headGraphPath,
          row.impactPath,
          row.artifactByteLength,
          row.errorCode,
          row.createdAt,
          row.updatedAt,
          row.lastAccessedAt,
        ],
      ),
  })

  const findByIdentity = SqlSchema.findOneOption({
    Request: DiffAnalysisCacheIdentity,
    Result: DiffAnalysisGenerationDbRow,
    execute: (identity) =>
      sql.unsafe(
        `
          SELECT ${generationColumns}
          FROM diff_analysis_generations
          WHERE environment_id = ?
            AND repository_key = ?
            AND base_tree_oid = ?
            AND head_tree_oid = ?
            AND analyzer_version = ?
            AND analysis_policy_version = ?
            AND config_digest = ?
            AND scope_digest = ?
            AND tsconfig_digest = ?
        `,
        [
          identity.environmentId,
          identity.repositoryKey,
          identity.baseTreeOid,
          identity.headTreeOid,
          identity.analyzerVersion,
          identity.analysisPolicyVersion,
          identity.configDigest,
          identity.scopeDigest,
          identity.tsconfigDigest,
        ],
      ),
  })

  const findById = SqlSchema.findOneOption({
    Request: DiffAnalysisGenerationIdInput,
    Result: DiffAnalysisGenerationDbRow,
    execute: ({ diffAnalysisId }) =>
      sql.unsafe(
        `SELECT ${generationColumns} FROM diff_analysis_generations WHERE diff_analysis_id = ?`,
        [diffAnalysisId],
      ),
  })

  const updateRow = SqlSchema.findOneOption({
    Request: DiffAnalysisGenerationUpdate,
    Result: DiffAnalysisGenerationDbRow,
    execute: (row) =>
      sql.unsafe(
        `
          UPDATE diff_analysis_generations
          SET
            state = ?,
            head_root_path = ?,
            base_graph_path = ?,
            head_graph_path = ?,
            impact_path = ?,
            artifact_byte_length = ?,
            error_code = ?,
            updated_at = CASE
              WHEN updated_at < ? THEN ?
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
            END
          WHERE diff_analysis_id = ?
          RETURNING ${generationColumns}
        `,
        [
          row.state,
          row.headRootPath,
          row.baseGraphPath,
          row.headGraphPath,
          row.impactPath,
          row.artifactByteLength,
          row.errorCode,
          row.updatedAt,
          row.updatedAt,
          row.diffAnalysisId,
        ],
      ),
  })

  const touchRow = SqlSchema.findOneOption({
    Request: DiffAnalysisGenerationTouchInput,
    Result: Schema.Struct({ lastAccessedAt: Schema.String }),
    execute: ({ diffAnalysisId, lastAccessedAt }) => sql`
      UPDATE diff_analysis_generations
      SET last_accessed_at = CASE
        WHEN last_accessed_at < ${lastAccessedAt} THEN ${lastAccessedAt}
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_accessed_at, '+0.001 seconds')
      END
      WHERE diff_analysis_id = ${diffAnalysisId}
      RETURNING last_accessed_at AS "lastAccessedAt"
    `,
  })

  const retryTerminalRow = SqlSchema.findOneOption({
    Request: DiffAnalysisGenerationRetryInput,
    Result: DiffAnalysisGenerationDbRow,
    execute: ({ diffAnalysisId, updatedAt }) =>
      sql.unsafe(
        `
        UPDATE diff_analysis_generations
        SET
          state = 'queued',
          head_root_path = NULL,
          base_graph_path = NULL,
          head_graph_path = NULL,
          impact_path = NULL,
          artifact_byte_length = 0,
          error_code = NULL,
          updated_at = CASE
            WHEN updated_at < ? THEN ?
            ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
          END,
          last_accessed_at = CASE
            WHEN last_accessed_at < ? THEN ?
            ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_accessed_at, '+0.001 seconds')
          END
        WHERE diff_analysis_id = ?
          AND state IN ('failed', 'cancelled', 'abandoned')
        RETURNING ${generationColumns}
      `,
        [updatedAt, updatedAt, updatedAt, updatedAt, diffAnalysisId],
      ),
  })

  const abandonActiveRows = SqlSchema.findAll({
    Request: Schema.Struct({ updatedAt: Schema.String }),
    Result: DiffAnalysisGenerationDbRow,
    execute: ({ updatedAt }) =>
      sql.unsafe(
        `
          UPDATE diff_analysis_generations
          SET
            state = 'abandoned',
            error_code = 'server-restarted',
            updated_at = CASE
              WHEN updated_at < ? THEN ?
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
            END
          WHERE state IN ('queued', 'preparing', 'analyzing')
          RETURNING ${generationColumns}
        `,
        [updatedAt, updatedAt],
      ),
  })

  const listTerminalRows = SqlSchema.findAll({
    Request: DiffAnalysisGenerationCutoffInput,
    Result: DiffAnalysisGenerationDbRow,
    execute: ({ cutoff }) =>
      sql.unsafe(
        `
        SELECT ${generationColumns}
        FROM diff_analysis_generations
        WHERE state IN ('failed', 'cancelled', 'abandoned')
          AND updated_at < ?
        ORDER BY updated_at, diff_analysis_id
      `,
        [cutoff],
      ),
  })

  const listReadyByRepository = SqlSchema.findAll({
    Request: DiffAnalysisGenerationRepositoryInput,
    Result: DiffAnalysisGenerationDbRow,
    execute: ({ environmentId, repositoryKey }) =>
      sql.unsafe(
        `
        SELECT ${generationColumns}
        FROM diff_analysis_generations
        WHERE environment_id = ? AND repository_key = ? AND state = 'ready'
        ORDER BY last_accessed_at, diff_analysis_id
      `,
        [environmentId, repositoryKey],
      ),
  })

  const listReadyGlobal = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DiffAnalysisGenerationDbRow,
    execute: () =>
      sql.unsafe(`
      SELECT ${generationColumns}
      FROM diff_analysis_generations
      WHERE state = 'ready'
      ORDER BY last_accessed_at, diff_analysis_id
    `),
  })

  const listIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DiffAnalysisGenerationIdInput,
    execute: () => sql`
      SELECT diff_analysis_id AS "diffAnalysisId"
      FROM diff_analysis_generations
    `,
  })

  const deleteUnchangedRow = SqlSchema.findAll({
    Request: DiffAnalysisGenerationConditionalDeleteInput,
    Result: Schema.Struct({ diffAnalysisId: DiffAnalysisGenerationIdInput.fields.diffAnalysisId }),
    execute: ({ diffAnalysisId, state, updatedAt, lastAccessedAt }) => sql`
      DELETE FROM diff_analysis_generations
      WHERE diff_analysis_id = ${diffAnalysisId}
        AND state = ${state}
        AND updated_at = ${updatedAt}
        AND last_accessed_at = ${lastAccessedAt}
      RETURNING diff_analysis_id AS "diffAnalysisId"
    `,
  })

  const admit: DiffAnalysisGenerationRepositoryShape['admit'] = (row) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const inserted = yield* insert(row)
          if (Option.isSome(inserted)) return { row: inserted.value, inserted: true }
          const existing = yield* findByIdentity(row)
          if (Option.isSome(existing)) return { row: existing.value, inserted: false }
          return yield* new PersistenceSqlError({
            operation: 'DiffAnalysisGenerationRepository.admit:refetch',
            detail: 'A conflicting row could not be fetched by its full cache identity.',
          })
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'DiffAnalysisGenerationRepository.admit:query',
            'DiffAnalysisGenerationRepository.admit:decodeRow',
          ),
        ),
      )

  const getById: DiffAnalysisGenerationRepositoryShape['getById'] = (input) =>
    findById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.getById:query',
          'DiffAnalysisGenerationRepository.getById:decodeRow',
        ),
      ),
    )

  // target-identity lookup; the read RPC resolves a source to its cache identity
  // rather than requiring a previously issued analysis id
  const getByIdentity: DiffAnalysisGenerationRepositoryShape['getByIdentity'] = (identity) =>
    findByIdentity(identity).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.getByIdentity:query',
          'DiffAnalysisGenerationRepository.getByIdentity:decodeRow',
        ),
      ),
    )

  const update: DiffAnalysisGenerationRepositoryShape['update'] = (input) =>
    updateRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.update:query',
          'DiffAnalysisGenerationRepository.update:decodeRow',
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PersistenceSqlError({
                operation: 'DiffAnalysisGenerationRepository.update:notFound',
                detail: 'The diff analysis row disappeared before its lifecycle could advance.',
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    )

  const touch: DiffAnalysisGenerationRepositoryShape['touch'] = (input) =>
    touchRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.touch:query',
          'DiffAnalysisGenerationRepository.touch:encodeRequest',
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PersistenceSqlError({
                operation: 'DiffAnalysisGenerationRepository.touch:notFound',
                detail: 'The diff analysis row disappeared before its access could be recorded.',
              }),
            ),
          onSome: (row) => Effect.succeed(row.lastAccessedAt),
        }),
      ),
    )

  const retryTerminal: DiffAnalysisGenerationRepositoryShape['retryTerminal'] = (input) =>
    retryTerminalRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.retryTerminal:query',
          'DiffAnalysisGenerationRepository.retryTerminal:decodeRow',
        ),
      ),
    )

  const abandonActive: DiffAnalysisGenerationRepositoryShape['abandonActive'] = (updatedAt) =>
    abandonActiveRows({ updatedAt }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.abandonActive:query',
          'DiffAnalysisGenerationRepository.abandonActive:decodeRows',
        ),
      ),
    )

  const listTerminalBefore: DiffAnalysisGenerationRepositoryShape['listTerminalBefore'] = (input) =>
    listTerminalRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.listTerminalBefore:query',
          'DiffAnalysisGenerationRepository.listTerminalBefore:decodeRows',
        ),
      ),
    )

  const listReadyByRepositoryLru: DiffAnalysisGenerationRepositoryShape['listReadyByRepositoryLru'] =
    (input) =>
      listReadyByRepository(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            'DiffAnalysisGenerationRepository.listReadyByRepositoryLru:query',
            'DiffAnalysisGenerationRepository.listReadyByRepositoryLru:decodeRows',
          ),
        ),
      )

  const listReadyGlobalLru: DiffAnalysisGenerationRepositoryShape['listReadyGlobalLru'] = () =>
    listReadyGlobal().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.listReadyGlobalLru:query',
          'DiffAnalysisGenerationRepository.listReadyGlobalLru:decodeRows',
        ),
      ),
    )

  const listAllIds: DiffAnalysisGenerationRepositoryShape['listAllIds'] = () =>
    listIds().pipe(
      Effect.map((rows) => rows.map((row) => row.diffAnalysisId)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.listAllIds:query',
          'DiffAnalysisGenerationRepository.listAllIds:decodeRows',
        ),
      ),
    )

  const deleteIfUnchanged: DiffAnalysisGenerationRepositoryShape['deleteIfUnchanged'] = (input) =>
    deleteUnchangedRow(input).pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          'DiffAnalysisGenerationRepository.deleteIfUnchanged:query',
          'DiffAnalysisGenerationRepository.deleteIfUnchanged:decodeRow',
        ),
      ),
    )

  return DiffAnalysisGenerationRepository.of({
    admit,
    getById,
    getByIdentity,
    update,
    touch,
    retryTerminal,
    abandonActive,
    listTerminalBefore,
    listReadyByRepositoryLru,
    listReadyGlobalLru,
    listAllIds,
    deleteIfUnchanged,
  })
})

export const DiffAnalysisGenerationRepositoryLive = Layer.effect(
  DiffAnalysisGenerationRepository,
  makeDiffAnalysisGenerationRepository,
)
