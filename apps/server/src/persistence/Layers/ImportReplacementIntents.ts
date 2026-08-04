// apps/server/src/persistence/Layers/ImportReplacementIntents.ts
// persists crash-safe active import replacement intents

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import { toPersistenceSqlError } from '../Errors.ts'
import {
  ImportReplacementAttachmentEvidence,
  ImportReplacementCasTransition,
  ImportReplacementIndexEvidence,
  ImportReplacementIntent,
  ImportReplacementIntentRepository,
  type ImportReplacementIntentRepositoryShape,
  ImportReplacementSourceIdentity,
  ImportReplacementThreadEvidence,
} from '../Services/ImportReplacementIntents.ts'

const ImportReplacementIntentSqlRow = Schema.Struct({
  ...ImportReplacementIntent.fields,
  threadEvidence: Schema.NullOr(Schema.fromJsonString(ImportReplacementThreadEvidence)),
  attachmentEvidence: Schema.NullOr(Schema.fromJsonString(ImportReplacementAttachmentEvidence)),
  indexEvidence: Schema.NullOr(Schema.fromJsonString(ImportReplacementIndexEvidence)),
})

const IntentKeyRow = Schema.Struct({ intentKey: Schema.String })
const encodeThreadEvidence = Schema.encodeSync(
  Schema.fromJsonString(Schema.toEncoded(ImportReplacementThreadEvidence)),
)
const encodeAttachmentEvidence = Schema.encodeSync(
  Schema.fromJsonString(Schema.toEncoded(ImportReplacementAttachmentEvidence)),
)
const encodeIndexEvidence = Schema.encodeSync(
  Schema.fromJsonString(Schema.toEncoded(ImportReplacementIndexEvidence)),
)

const selectColumns = `
  intent_key AS "intentKey",
  source,
  source_path AS "sourcePath",
  native_session_id AS "nativeSessionId",
  provider_instance_id AS "providerInstanceId",
  original_workspace_root AS "originalWorkspaceRoot",
  source_version AS "sourceVersion",
  replacement_version AS "replacementVersion",
  source_thread_id AS "sourceThreadId",
  source_project_id AS "sourceProjectId",
  replacement_thread_id AS "replacementThreadId",
  replacement_project_id AS "replacementProjectId",
  replacement_workspace_root AS "replacementWorkspaceRoot",
  create_command_id AS "createCommandId",
  tombstone_command_id AS "tombstoneCommandId",
  expected_message_count AS "expectedMessageCount",
  expected_activity_count AS "expectedActivityCount",
  expected_record_fingerprint AS "expectedRecordFingerprint",
  phase,
  thread_evidence_json AS "threadEvidence",
  attachment_evidence_json AS "attachmentEvidence",
  index_evidence_json AS "indexEvidence",
  attempt_count AS "attemptCount",
  last_error AS "lastError",
  retry_after AS "retryAfter",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  retired_at AS "retiredAt"
`

const makeImportReplacementIntentRepository = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const getRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ImportReplacementIntentSqlRow,
    execute: (intentKey) =>
      sql.unsafe(`SELECT ${selectColumns} FROM import_replacement_intents WHERE intent_key = ?`, [
        intentKey,
      ]),
  })
  const findOpenRow = SqlSchema.findOneOption({
    Request: ImportReplacementSourceIdentity,
    Result: ImportReplacementIntentSqlRow,
    execute: (identity) =>
      sql.unsafe(
        `SELECT ${selectColumns} FROM import_replacement_intents
       WHERE source = ? AND source_path = ?
         AND native_session_id IS ? AND provider_instance_id IS ? AND phase <> 'retired'
       ORDER BY created_at ASC LIMIT 1`,
        [
          identity.source,
          identity.sourcePath,
          identity.nativeSessionId,
          identity.providerInstanceId,
        ],
      ),
  })
  const listOpenRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ImportReplacementIntentSqlRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${selectColumns} FROM import_replacement_intents WHERE phase <> 'retired' ORDER BY created_at ASC, intent_key ASC`,
      ),
  })
  const insertRow = SqlSchema.void({
    Request: ImportReplacementIntent,
    execute: (row) => sql`
      INSERT INTO import_replacement_intents (
        intent_key, source, source_path, native_session_id, provider_instance_id,
        original_workspace_root, source_version, replacement_version, source_thread_id,
        source_project_id, replacement_thread_id, replacement_project_id,
        replacement_workspace_root, create_command_id, tombstone_command_id,
        expected_message_count, expected_activity_count, expected_record_fingerprint, phase,
        thread_evidence_json, attachment_evidence_json, index_evidence_json, attempt_count,
        last_error, retry_after, created_at, updated_at, retired_at
      ) VALUES (
        ${row.intentKey}, ${row.source}, ${row.sourcePath}, ${row.nativeSessionId},
        ${row.providerInstanceId}, ${row.originalWorkspaceRoot}, ${row.sourceVersion},
        ${row.replacementVersion}, ${row.sourceThreadId}, ${row.sourceProjectId},
        ${row.replacementThreadId}, ${row.replacementProjectId}, ${row.replacementWorkspaceRoot},
        ${row.createCommandId}, ${row.tombstoneCommandId}, ${row.expectedMessageCount},
        ${row.expectedActivityCount}, ${row.expectedRecordFingerprint}, ${row.phase},
        ${row.threadEvidence === null ? null : encodeThreadEvidence(row.threadEvidence)},
        ${row.attachmentEvidence === null ? null : encodeAttachmentEvidence(row.attachmentEvidence)},
        ${row.indexEvidence === null ? null : encodeIndexEvidence(row.indexEvidence)},
        ${row.attemptCount}, ${row.lastError}, ${row.retryAfter}, ${row.createdAt}, ${row.updatedAt},
        ${row.retiredAt}
      ) ON CONFLICT (intent_key) DO NOTHING
    `,
  })
  const transitionRow = SqlSchema.findOneOption({
    Request: ImportReplacementCasTransition,
    Result: IntentKeyRow,
    execute: (transition) => sql`
      UPDATE import_replacement_intents SET
        phase = ${transition.nextPhase},
        thread_evidence_json = ${transition.threadEvidence === null ? null : encodeThreadEvidence(transition.threadEvidence)},
        attachment_evidence_json = ${transition.attachmentEvidence === null ? null : encodeAttachmentEvidence(transition.attachmentEvidence)},
        index_evidence_json = ${transition.indexEvidence === null ? null : encodeIndexEvidence(transition.indexEvidence)},
        attempt_count = ${transition.attemptCount},
        last_error = ${transition.lastError},
        retry_after = ${transition.retryAfter},
        updated_at = ${transition.updatedAt}
      WHERE intent_key = ${transition.intentKey} AND phase = ${transition.expectedPhase}
      RETURNING intent_key AS "intentKey"
    `,
  })
  const retireRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      intentKey: Schema.String,
      expectedPhase: ImportReplacementCasTransition.fields.expectedPhase,
      retiredAt: Schema.String,
    }),
    Result: IntentKeyRow,
    execute: (input) => sql`
      UPDATE import_replacement_intents SET
        phase = 'retired', updated_at = ${input.retiredAt}, retired_at = ${input.retiredAt},
        retry_after = NULL, last_error = NULL
      WHERE intent_key = ${input.intentKey} AND phase = ${input.expectedPhase}
      RETURNING intent_key AS "intentKey"
    `,
  })

  const getByIntentKey: ImportReplacementIntentRepositoryShape['getByIntentKey'] = (intentKey) =>
    getRow(intentKey).pipe(
      Effect.mapError(
        toPersistenceSqlError('ImportReplacementIntentRepository.getByIntentKey:query'),
      ),
    )
  const findOpenBySourceIdentity: ImportReplacementIntentRepositoryShape['findOpenBySourceIdentity'] =
    (identity) =>
      findOpenRow(identity).pipe(
        Effect.mapError(
          toPersistenceSqlError('ImportReplacementIntentRepository.findOpenBySourceIdentity:query'),
        ),
      )
  const insertIfAbsent: ImportReplacementIntentRepositoryShape['insertIfAbsent'] = (intent) =>
    insertRow(intent).pipe(
      Effect.flatMap(() => getByIntentKey(intent.intentKey)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.die(
              new Error(`Inserted import replacement intent '${intent.intentKey}' was not found`),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError(
        toPersistenceSqlError('ImportReplacementIntentRepository.insertIfAbsent:query'),
      ),
    )
  const casTransition: ImportReplacementIntentRepositoryShape['casTransition'] = (transition) =>
    transitionRow(transition).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlError('ImportReplacementIntentRepository.casTransition:query'),
      ),
    )
  const listOpen: ImportReplacementIntentRepositoryShape['listOpen'] = () =>
    listOpenRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError('ImportReplacementIntentRepository.listOpen:query')),
    )
  const retire: ImportReplacementIntentRepositoryShape['retire'] = (input) =>
    retireRow(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(toPersistenceSqlError('ImportReplacementIntentRepository.retire:query')),
    )

  return {
    getByIntentKey,
    findOpenBySourceIdentity,
    insertIfAbsent,
    casTransition,
    listOpen,
    retire,
  } satisfies ImportReplacementIntentRepositoryShape
})

export const ImportReplacementIntentRepositoryLive = Layer.effect(
  ImportReplacementIntentRepository,
  makeImportReplacementIntentRepository,
)
