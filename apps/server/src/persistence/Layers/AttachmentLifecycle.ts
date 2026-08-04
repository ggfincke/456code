// apps/server/src/persistence/Layers/AttachmentLifecycle.ts
// persists attachment ownership transitions and cleanup work

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import { toPersistenceSqlError } from '../Errors.ts'
import {
  AttachmentCleanup,
  AttachmentLifecycleRepository,
  type AttachmentLifecycleRepositoryShape,
  AttachmentStaging,
  AttachmentStagingConflictError,
  ClaimDueInput,
} from '../Services/AttachmentLifecycle.ts'

const CommandLookupInput = Schema.Struct({ commandId: Schema.String })
const StagingLookupInput = Schema.Struct({ stagingKey: Schema.String })
const RelativePathLookupInput = Schema.Struct({ relativePath: Schema.String })
const ThreadLookupInput = Schema.Struct({ threadId: Schema.String })

const stagingColumns = `
  staging_key AS "stagingKey",
  command_id AS "commandId",
  thread_id AS "threadId",
  message_id AS "messageId",
  attachment_index AS "attachmentIndex",
  attachment_id AS "attachmentId",
  staging_relative_path AS "stagingRelativePath",
  relative_path AS "relativePath",
  mime_type AS "mimeType",
  byte_count AS "byteCount",
  content_digest AS "contentDigest",
  state,
  generation,
  owner_sequence AS "ownerSequence",
  owner_event_type AS "ownerEventType",
  cleanup_reason AS "cleanupReason",
  retry_count AS "retryCount",
  next_attempt_at AS "nextAttemptAt",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const cleanupColumns = `
  cleanup_key AS "cleanupKey",
  staging_key AS "stagingKey",
  target_kind AS "targetKind",
  relative_path AS "relativePath",
  staging_relative_path AS "stagingRelativePath",
  thread_id AS "threadId",
  thread_segment AS "threadSegment",
  reason,
  source_sequence AS "sourceSequence",
  staging_generation AS "stagingGeneration",
  state,
  lease_expires_at AS "leaseExpiresAt",
  attempt_count AS "attemptCount",
  next_attempt_at AS "nextAttemptAt",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const isAttachmentStagingConflictError = Schema.is(AttachmentStagingConflictError)

const makeAttachmentLifecycleRepository = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const findByStagingKey = SqlSchema.findOneOption({
    Request: StagingLookupInput,
    Result: AttachmentStaging,
    execute: ({ stagingKey }) =>
      sql.unsafe(`SELECT ${stagingColumns} FROM attachment_staging WHERE staging_key = ?`, [
        stagingKey,
      ]),
  })

  const findByCommandId = SqlSchema.findAll({
    Request: CommandLookupInput,
    Result: AttachmentStaging,
    execute: ({ commandId }) =>
      sql.unsafe(
        `SELECT ${stagingColumns} FROM attachment_staging WHERE command_id = ? ORDER BY attachment_index ASC`,
        [commandId],
      ),
  })

  const findByRelativePath = SqlSchema.findOneOption({
    Request: RelativePathLookupInput,
    Result: AttachmentStaging,
    execute: ({ relativePath }) =>
      sql.unsafe(`SELECT ${stagingColumns} FROM attachment_staging WHERE relative_path = ?`, [
        relativePath,
      ]),
  })

  const findByThreadId = SqlSchema.findAll({
    Request: ThreadLookupInput,
    Result: AttachmentStaging,
    execute: ({ threadId }) =>
      sql.unsafe(
        `SELECT ${stagingColumns} FROM attachment_staging WHERE thread_id = ? ORDER BY created_at, staging_key`,
        [threadId],
      ),
  })

  const listStaging = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AttachmentStaging,
    execute: () =>
      sql.unsafe(
        `SELECT ${stagingColumns} FROM attachment_staging ORDER BY created_at, staging_key`,
      ),
  })

  const listCleanup = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AttachmentCleanup,
    execute: () =>
      sql.unsafe(
        `SELECT ${cleanupColumns} FROM attachment_cleanup ORDER BY created_at, cleanup_key`,
      ),
  })

  const claimDueRows = SqlSchema.findAll({
    Request: ClaimDueInput,
    Result: AttachmentCleanup,
    execute: ({ now, leaseExpiresAt, limit }) =>
      sql.unsafe(
        `
          UPDATE attachment_cleanup
          SET
            state = 'running',
            lease_expires_at = ?,
            updated_at = ?
          WHERE cleanup_key IN (
            SELECT cleanup_key
            FROM attachment_cleanup
            WHERE (
              (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR
              (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            )
            ORDER BY created_at, cleanup_key
            LIMIT ?
          )
          RETURNING ${cleanupColumns}
        `,
        [leaseExpiresAt, now, now, now, limit],
      ),
  })

  const stage: AttachmentLifecycleRepositoryShape['stage'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          yield* sql`
            UPDATE attachment_staging
            SET updated_at = updated_at
            WHERE staging_key = ${input.stagingKey}
          `
          const before = yield* findByStagingKey({ stagingKey: input.stagingKey })
          if (Option.isSome(before))
          {
            const row = before.value
            const matches =
              row.commandId === input.commandId &&
              row.threadId === input.threadId &&
              row.messageId === input.messageId &&
              row.attachmentIndex === input.attachmentIndex &&
              row.attachmentId === input.attachmentId &&
              row.stagingRelativePath === input.stagingRelativePath &&
              row.relativePath === input.relativePath &&
              row.mimeType === input.mimeType &&
              row.byteCount === input.byteCount &&
              row.contentDigest === input.contentDigest
            if (!matches)
            {
              return yield* new AttachmentStagingConflictError({
                stagingKey: input.stagingKey,
                detail: 'The command attachment identity or content does not match its staged row.',
              })
            }
            if (row.state === 'cleanup_pending')
            {
              yield* sql`
                UPDATE attachment_staging
                SET
                  state = 'staged',
                  generation = generation + 1,
                  cleanup_reason = NULL,
                  retry_count = retry_count + 1,
                  next_attempt_at = NULL,
                  last_error = NULL,
                  updated_at = ${input.now}
                WHERE staging_key = ${input.stagingKey}
                  AND state = 'cleanup_pending'
              `
              yield* sql`
                UPDATE attachment_cleanup
                SET
                  state = 'complete',
                  lease_expires_at = NULL,
                  next_attempt_at = NULL,
                  last_error = NULL,
                  updated_at = ${input.now}
                WHERE staging_key = ${input.stagingKey}
                  AND staging_generation IS ${row.generation}
                  AND state IN ('pending', 'running')
              `
            }
          }
          else
          {
            yield* sql`
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
                ${input.stagingKey},
                ${input.commandId},
                ${input.threadId},
                ${input.messageId},
                ${input.attachmentIndex},
                ${input.attachmentId},
                ${input.stagingRelativePath},
                ${input.relativePath},
                ${input.mimeType},
                ${input.byteCount},
                ${input.contentDigest},
                'staged',
                ${input.now},
                ${input.now}
              )
            `
          }

          const staged = yield* findByStagingKey({ stagingKey: input.stagingKey })
          if (Option.isNone(staged))
          {
            return yield* Effect.die(new Error('attachment staging insert returned no row'))
          }
          return staged.value
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isAttachmentStagingConflictError(cause)
            ? cause
            : toPersistenceSqlError('AttachmentLifecycleRepository.stage:transaction')(cause),
        ),
      )

  const markPromoted: AttachmentLifecycleRepositoryShape['markPromoted'] = (input) =>
    sql`
      UPDATE attachment_staging
      SET updated_at = ${input.now}
      WHERE staging_key = ${input.stagingKey}
        AND state = 'staged'
    `.pipe(Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.markPromoted')))

  const associateAccepted: AttachmentLifecycleRepositoryShape['associateAccepted'] = (input) =>
    sql`
      UPDATE attachment_staging
      SET
        state = 'owned',
        owner_sequence = ${input.ownerSequence},
        owner_event_type = ${input.ownerEventType},
        cleanup_reason = NULL,
        next_attempt_at = NULL,
        last_error = NULL,
        updated_at = ${input.now}
      WHERE command_id = ${input.commandId}
        AND state = 'staged'
    `.pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.associateAccepted')),
    )

  const markDispatchFailure: AttachmentLifecycleRepositoryShape['markDispatchFailure'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          yield* sql`
            UPDATE attachment_staging
            SET
              state = 'cleanup_pending',
              cleanup_reason = ${input.reason},
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = ${input.now}
            WHERE command_id = ${input.commandId}
              AND state = 'staged'
          `
          yield* sql`
            INSERT INTO attachment_cleanup (
              cleanup_key,
              staging_key,
              target_kind,
              relative_path,
              staging_relative_path,
              reason,
              staging_generation,
              state,
              created_at,
              updated_at
            )
            SELECT
              'attachment:' || staging_key,
              staging_key,
              'path',
              relative_path,
              staging_relative_path,
              ${input.reason},
              generation,
              'pending',
              ${input.now},
              ${input.now}
            FROM attachment_staging
            WHERE command_id = ${input.commandId}
              AND state = 'cleanup_pending'
            ON CONFLICT(cleanup_key) DO UPDATE SET
              reason = excluded.reason,
              staging_generation = excluded.staging_generation,
              state = CASE
                WHEN attachment_cleanup.state = 'running' THEN attachment_cleanup.state
                ELSE 'pending'
              END,
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = excluded.updated_at
          `
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError('AttachmentLifecycleRepository.markDispatchFailure:transaction'),
        ),
      )

  const enqueuePathCleanup: AttachmentLifecycleRepositoryShape['enqueuePathCleanup'] = (input) =>
    sql`
      INSERT INTO attachment_cleanup (
        cleanup_key,
        staging_key,
        target_kind,
        relative_path,
        staging_relative_path,
        reason,
        source_sequence,
        staging_generation,
        state,
        created_at,
        updated_at
      )
      VALUES (
        ${input.cleanupKey},
        ${input.stagingKey},
        'path',
        ${input.relativePath},
        ${input.stagingRelativePath},
        ${input.reason},
        ${input.sourceSequence},
        (
          SELECT generation
          FROM attachment_staging
          WHERE staging_key = ${input.stagingKey}
        ),
        'pending',
        ${input.now},
        ${input.now}
      )
      ON CONFLICT(cleanup_key) DO UPDATE SET
        staging_key = excluded.staging_key,
        relative_path = excluded.relative_path,
        staging_relative_path = excluded.staging_relative_path,
        reason = excluded.reason,
        source_sequence = excluded.source_sequence,
        staging_generation = excluded.staging_generation,
        state = CASE
          WHEN attachment_cleanup.state = 'running' THEN attachment_cleanup.state
          ELSE 'pending'
        END,
        attempt_count = 0,
        next_attempt_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE excluded.staging_key IS NOT NULL
        AND attachment_cleanup.staging_generation IS NOT excluded.staging_generation
    `.pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.enqueuePathCleanup')),
    )

  const enqueueThreadCleanup: AttachmentLifecycleRepositoryShape['enqueueThreadCleanup'] = (
    input,
  ) =>
    sql`
      INSERT INTO attachment_cleanup (
        cleanup_key,
        target_kind,
        thread_id,
        thread_segment,
        reason,
        source_sequence,
        state,
        created_at,
        updated_at
      )
      VALUES (
        ${input.cleanupKey},
        'thread',
        ${input.threadId},
        ${input.threadSegment},
        ${input.reason},
        ${input.sourceSequence},
        'pending',
        ${input.now},
        ${input.now}
      )
      ON CONFLICT(cleanup_key) DO NOTHING
    `.pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.enqueueThreadCleanup')),
    )

  const claimDue: AttachmentLifecycleRepositoryShape['claimDue'] = (input) =>
    claimDueRows(input).pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.claimDue')),
    )

  const complete: AttachmentLifecycleRepositoryShape['complete'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          yield* sql`
            UPDATE attachment_staging
            SET next_attempt_at = NULL, last_error = NULL, updated_at = ${input.now}
            WHERE staging_key = (
              SELECT staging_key
              FROM attachment_cleanup
              WHERE cleanup_key = ${input.cleanupKey}
                AND staging_generation IS ${input.stagingGeneration}
                AND state = 'running'
            )
              AND generation = ${input.stagingGeneration}
          `
          yield* sql`
            UPDATE attachment_cleanup
            SET state = 'complete', lease_expires_at = NULL, updated_at = ${input.now}
            WHERE cleanup_key = ${input.cleanupKey}
              AND staging_generation IS ${input.stagingGeneration}
              AND state = 'running'
          `
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.complete')))

  const retry: AttachmentLifecycleRepositoryShape['retry'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          yield* sql`
            UPDATE attachment_staging
            SET
              retry_count = retry_count + 1,
              next_attempt_at = ${input.nextAttemptAt},
              last_error = ${input.error},
              updated_at = ${input.now}
            WHERE staging_key = (
              SELECT staging_key
              FROM attachment_cleanup
              WHERE cleanup_key = ${input.cleanupKey}
                AND staging_generation IS ${input.stagingGeneration}
                AND state = 'running'
            )
              AND generation = ${input.stagingGeneration}
          `
          yield* sql`
            UPDATE attachment_cleanup
            SET
              state = 'pending',
              lease_expires_at = NULL,
              attempt_count = attempt_count + 1,
              next_attempt_at = ${input.nextAttemptAt},
              last_error = ${input.error},
              updated_at = ${input.now}
            WHERE cleanup_key = ${input.cleanupKey}
              AND staging_generation IS ${input.stagingGeneration}
              AND (
                staging_key IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM attachment_staging
                  WHERE attachment_staging.staging_key = attachment_cleanup.staging_key
                    AND attachment_staging.generation = ${input.stagingGeneration}
                )
              )
              AND state = 'running'
          `
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.retry')))

  const poison: AttachmentLifecycleRepositoryShape['poison'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          yield* sql`
            UPDATE attachment_staging
            SET
              retry_count = retry_count + 1,
              next_attempt_at = NULL,
              last_error = ${input.error},
              updated_at = ${input.now}
            WHERE staging_key = (
              SELECT staging_key
              FROM attachment_cleanup
              WHERE cleanup_key = ${input.cleanupKey}
                AND staging_generation IS ${input.stagingGeneration}
                AND state = 'running'
            )
              AND generation = ${input.stagingGeneration}
          `
          yield* sql`
            UPDATE attachment_cleanup
            SET
              state = 'poison',
              lease_expires_at = NULL,
              attempt_count = attempt_count + 1,
              last_error = ${input.error},
              updated_at = ${input.now}
            WHERE cleanup_key = ${input.cleanupKey}
              AND staging_generation IS ${input.stagingGeneration}
              AND (
                staging_key IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM attachment_staging
                  WHERE attachment_staging.staging_key = attachment_cleanup.staging_key
                    AND attachment_staging.generation = ${input.stagingGeneration}
                )
              )
              AND state = 'running'
          `
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.poison')))

  const listDiagnostics: AttachmentLifecycleRepositoryShape['listDiagnostics'] = () =>
    Effect.all({
      staging: listStaging(undefined),
      cleanup: listCleanup(undefined),
    }).pipe(
      Effect.map((rows) => rows),
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.listDiagnostics')),
    )

  const getByRelativePath: AttachmentLifecycleRepositoryShape['getByRelativePath'] = (
    relativePath,
  ) =>
    findByRelativePath({ relativePath }).pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.getByRelativePath')),
    )

  const getByThreadId: AttachmentLifecycleRepositoryShape['getByThreadId'] = (threadId) =>
    findByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.getByThreadId')),
    )

  const getByCommandId: AttachmentLifecycleRepositoryShape['getByCommandId'] = (commandId) =>
    findByCommandId({ commandId }).pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.getByCommandId')),
    )

  const getByStagingKey: AttachmentLifecycleRepositoryShape['getByStagingKey'] = (stagingKey) =>
    findByStagingKey({ stagingKey }).pipe(
      Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.getByStagingKey')),
    )

  return {
    stage,
    markPromoted,
    associateAccepted,
    markDispatchFailure,
    enqueuePathCleanup,
    enqueueThreadCleanup,
    claimDue,
    complete,
    retry,
    poison,
    listStaging: () =>
      listStaging(undefined).pipe(
        Effect.mapError(toPersistenceSqlError('AttachmentLifecycleRepository.listStaging')),
      ),
    listDiagnostics,
    getByCommandId,
    getByStagingKey,
    getByRelativePath,
    getByThreadId,
  } satisfies AttachmentLifecycleRepositoryShape
})

export const AttachmentLifecycleRepositoryLive = Layer.effect(
  AttachmentLifecycleRepository,
  makeAttachmentLifecycleRepository,
)
