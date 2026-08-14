// apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts
// persists canonical provider events and atomically checkpoints durable consumers

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import { PersistenceSqlError } from '../Errors.ts'
import {
  ProviderRuntimeInbox,
  ProviderRuntimeInboxAdmissionError,
  ProviderRuntimeInboxAdmissionState,
  ProviderRuntimeInboxAppendResult,
  ProviderRuntimeInboxBuffer,
  ProviderRuntimeInboxDiagnostics,
  ProviderRuntimeInboxRecord,
  ProviderRuntimeInboxSession,
  type ProviderRuntimeInboxShape,
} from '../Services/ProviderRuntimeInbox.ts'

const ChangedRow = Schema.Struct({ changed: Schema.Number })
const SequenceRow = Schema.Struct({ sequence: Schema.Number })
const DrainedRow = Schema.Struct({ drained: Schema.Number })
const DiagnosticsRow = Schema.Struct({
  admissionMode: Schema.Literals(['required', 'fenced']),
  lastSequence: Schema.Number,
  retainedRecordCount: Schema.Number,
  backlogCount: Schema.Number,
  oldestPendingReceivedAt: Schema.NullOr(Schema.String),
  ingestionCursorSequence: Schema.NullOr(Schema.Number),
  checkpointCursorSequence: Schema.NullOr(Schema.Number),
})
const isAdmissionError = Schema.is(ProviderRuntimeInboxAdmissionError)

const toSqlError =
  (operation: string) =>
  (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({ operation, cause })

const mapInboxError =
  (operation: string) =>
  (cause: unknown): PersistenceSqlError | ProviderRuntimeInboxAdmissionError =>
    isAdmissionError(cause) ? cause : toSqlError(operation)(cause)

const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const wakeups = yield* PubSub.sliding<number>(1)

  const readAdmissionState = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProviderRuntimeInboxAdmissionState,
    execute: () => sql`
      SELECT
        admission_mode AS mode,
        next_sequence AS "nextSequence",
        active_owner_id AS "activeOwnerId",
        owner_generation AS "ownerGeneration",
        high_water_sequence AS "highWaterSequence",
        updated_at AS "updatedAt"
      FROM provider_runtime_inbox_control
      WHERE singleton_id = 1
    `,
  })

  const readConsumersDrainedThrough = SqlSchema.findOne({
    Request: Schema.Number,
    Result: DrainedRow,
    execute: (throughSequence) => sql`
      SELECT NOT EXISTS (
        SELECT required_consumer.consumer_id
        FROM (
          SELECT 'provider-runtime-ingestion' AS consumer_id
          UNION ALL
          SELECT 'provider-runtime-checkpoint'
        ) AS required_consumer
        LEFT JOIN orchestration_reactor_progress AS progress
          ON progress.reactor_id = required_consumer.consumer_id
        WHERE progress.cursor_sequence IS NULL
          OR progress.cursor_sequence < ${throughSequence}
      ) AS drained
    `,
  })

  const claimAdmissionOwner: ProviderRuntimeInboxShape['claimAdmissionOwner'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const previous = yield* readAdmissionState(undefined)
          const sameOwner = previous.activeOwnerId === input.ownerId
          const highWaterSequence = previous.highWaterSequence ?? previous.nextSequence - 1
          const consumersDrained =
            highWaterSequence === 0 ||
            (yield* readConsumersDrainedThrough(highWaterSequence)).drained === 1
          const nextMode = sameOwner ? previous.mode : consumersDrained ? 'required' : 'fenced'
          yield* sql`
            UPDATE provider_runtime_inbox_control
            SET
              owner_generation = ${
                sameOwner ? previous.ownerGeneration : previous.ownerGeneration + 1
              },
              admission_mode = ${nextMode},
              high_water_sequence = ${nextMode === 'required' ? null : highWaterSequence},
              active_owner_id = ${input.ownerId},
              updated_at = ${input.now}
            WHERE singleton_id = 1
          `
          return yield* readAdmissionState(undefined)
        }),
      )
      .pipe(Effect.mapError(toSqlError('ProviderRuntimeInbox.claimAdmissionOwner')))

  const getAdmissionState: ProviderRuntimeInboxShape['getAdmissionState'] = readAdmissionState(
    undefined,
  ).pipe(Effect.mapError(toSqlError('ProviderRuntimeInbox.getAdmissionState')))

  const setAdmissionMode: ProviderRuntimeInboxShape['setAdmissionMode'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const updated = yield* SqlSchema.findOneOption({
            Request: Schema.Void,
            Result: ChangedRow,
            execute: () => sql`
              UPDATE provider_runtime_inbox_control
              SET
                admission_mode = ${input.mode},
                high_water_sequence = COALESCE(
                  ${input.highWaterSequence ?? null},
                  next_sequence - 1
                ),
                updated_at = ${input.now}
              WHERE singleton_id = 1
                AND active_owner_id = ${input.ownerId}
                AND owner_generation = ${input.ownerGeneration}
              RETURNING 1 AS changed
            `,
          })(undefined)
          if (Option.isNone(updated))
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'owner-fenced',
              detail: 'the admission owner generation is no longer current',
            })
          }
          return yield* readAdmissionState(undefined)
        }),
      )
      .pipe(Effect.mapError(mapInboxError('ProviderRuntimeInbox.setAdmissionMode')))

  const resumeAdmissionAfterHandoff: ProviderRuntimeInboxShape['resumeAdmissionAfterHandoff'] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const current = yield* readAdmissionState(undefined)
          if (
            current.activeOwnerId !== input.ownerId ||
            current.ownerGeneration !== input.ownerGeneration
          )
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'owner-fenced',
              detail: 'the admission owner generation is no longer current',
            })
          }
          if (current.mode === 'required')
          {
            return current
          }
          const highWaterSequence = current.highWaterSequence ?? current.nextSequence - 1
          const consumersDrained = yield* readConsumersDrainedThrough(highWaterSequence)
          if (consumersDrained.drained !== 1)
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'handoff-incomplete',
              detail: `durable consumers have not both reached admission high-water ${highWaterSequence}`,
            })
          }
          yield* sql`
              UPDATE provider_runtime_inbox_control
              SET
                admission_mode = 'required',
                high_water_sequence = NULL,
                updated_at = ${input.now}
              WHERE singleton_id = 1
                AND active_owner_id = ${input.ownerId}
                AND owner_generation = ${input.ownerGeneration}
                AND admission_mode = 'fenced'
            `
          return yield* readAdmissionState(undefined)
        }),
      )
      .pipe(Effect.mapError(mapInboxError('ProviderRuntimeInbox.resumeAdmissionAfterHandoff')))

  const readCurrentSession = SqlSchema.findOneOption({
    Request: Schema.Struct({
      providerInstanceId: Schema.String,
      threadId: Schema.String,
    }),
    Result: ProviderRuntimeInboxSession,
    execute: (input) => sql`
      SELECT
        provider_kind AS provider,
        provider_instance_id AS "providerInstanceId",
        thread_id AS "threadId",
        session_generation AS "sessionGeneration",
        status,
        opened_sequence AS "openedSequence",
        closed_sequence AS "closedSequence",
        consumers_completed_at AS "consumersCompletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_runtime_inbox_sessions
      WHERE provider_instance_id = ${input.providerInstanceId}
        AND thread_id = ${input.threadId}
        AND status = 'open'
      LIMIT 1
    `,
  })

  const readSession = SqlSchema.findOneOption({
    Request: Schema.Struct({
      providerInstanceId: Schema.String,
      threadId: Schema.String,
      sessionGeneration: Schema.Number,
    }),
    Result: ProviderRuntimeInboxSession,
    execute: (input) => sql`
      SELECT
        provider_kind AS provider,
        provider_instance_id AS "providerInstanceId",
        thread_id AS "threadId",
        session_generation AS "sessionGeneration",
        status,
        opened_sequence AS "openedSequence",
        closed_sequence AS "closedSequence",
        consumers_completed_at AS "consumersCompletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_runtime_inbox_sessions
      WHERE provider_instance_id = ${input.providerInstanceId}
        AND thread_id = ${input.threadId}
        AND session_generation = ${input.sessionGeneration}
      LIMIT 1
    `,
  })

  const createSession = (input: {
    readonly provider: string
    readonly providerInstanceId: string
    readonly threadId: string
    readonly now: string
  }) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: ProviderRuntimeInboxSession,
      execute: () => sql`
        INSERT INTO provider_runtime_inbox_sessions (
          provider_kind,
          provider_instance_id,
          thread_id,
          session_generation,
          status,
          created_at,
          updated_at
        )
        SELECT
          ${input.provider},
          ${input.providerInstanceId},
          ${input.threadId},
          COALESCE(MAX(session_generation), 0) + 1,
          'open',
          ${input.now},
          ${input.now}
        FROM provider_runtime_inbox_sessions
        WHERE provider_instance_id = ${input.providerInstanceId}
          AND thread_id = ${input.threadId}
        RETURNING
          provider_kind AS provider,
          provider_instance_id AS "providerInstanceId",
          thread_id AS "threadId",
          session_generation AS "sessionGeneration",
          status,
          opened_sequence AS "openedSequence",
          closed_sequence AS "closedSequence",
          consumers_completed_at AS "consumersCompletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
    })(undefined)

  const getOrCreateSession = Effect.fn('ProviderRuntimeInbox.getOrCreateSession')(
    function* (input: {
      readonly provider: string
      readonly providerInstanceId: string
      readonly threadId: string
      readonly now: string
    })
    {
      const current = yield* readCurrentSession(input)
      if (Option.isNone(current))
      {
        return yield* createSession(input)
      }
      if (current.value.provider !== input.provider)
      {
        return yield* new ProviderRuntimeInboxAdmissionError({
          reason: 'session-provider-mismatch',
          detail: `the open provider session belongs to '${current.value.provider}', not '${input.provider}'`,
        })
      }
      return current.value
    },
  )

  const beginSession: ProviderRuntimeInboxShape['beginSession'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const admission = yield* readAdmissionState(undefined)
          if (
            admission.activeOwnerId !== input.ownerId ||
            admission.ownerGeneration !== input.ownerGeneration
          )
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'owner-fenced',
              detail: 'the admission owner generation is no longer current',
            })
          }
          if (admission.mode !== 'required')
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'fenced',
              detail: `admission is fenced at sequence ${admission.highWaterSequence ?? admission.nextSequence - 1}`,
            })
          }
          return yield* getOrCreateSession(input)
        }),
      )
      .pipe(Effect.mapError(mapInboxError('ProviderRuntimeInbox.beginSession')))

  const getCurrentSession: ProviderRuntimeInboxShape['getCurrentSession'] = (input) =>
    readCurrentSession(input).pipe(
      Effect.mapError(toSqlError('ProviderRuntimeInbox.getCurrentSession')),
    )

  const getSession: ProviderRuntimeInboxShape['getSession'] = (identity) =>
    readSession(identity).pipe(
      Effect.map(Option.filter((session) => session.provider === identity.provider)),
      Effect.mapError(toSqlError('ProviderRuntimeInbox.getSession')),
    )

  const listOpenSessionsQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: ProviderRuntimeInboxSession,
    execute: (providerInstanceId) => sql`
      SELECT
        provider_kind AS provider,
        provider_instance_id AS "providerInstanceId",
        thread_id AS "threadId",
        session_generation AS "sessionGeneration",
        status,
        opened_sequence AS "openedSequence",
        closed_sequence AS "closedSequence",
        consumers_completed_at AS "consumersCompletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_runtime_inbox_sessions
      WHERE provider_instance_id = ${providerInstanceId}
        AND status = 'open'
      ORDER BY thread_id ASC, session_generation ASC
    `,
  })

  const listOpenSessions: ProviderRuntimeInboxShape['listOpenSessions'] = (providerInstanceId) =>
    listOpenSessionsQuery(providerInstanceId).pipe(
      Effect.mapError(toSqlError('ProviderRuntimeInbox.listOpenSessions')),
    )

  const listAllOpenSessionsQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderRuntimeInboxSession,
    execute: () => sql`
      SELECT
        provider_kind AS provider,
        provider_instance_id AS "providerInstanceId",
        thread_id AS "threadId",
        session_generation AS "sessionGeneration",
        status,
        opened_sequence AS "openedSequence",
        closed_sequence AS "closedSequence",
        consumers_completed_at AS "consumersCompletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_runtime_inbox_sessions
      WHERE status = 'open'
      ORDER BY provider_instance_id ASC, thread_id ASC, session_generation ASC
    `,
  })

  const listAllOpenSessions: ProviderRuntimeInboxShape['listAllOpenSessions'] = () =>
    listAllOpenSessionsQuery().pipe(
      Effect.mapError(toSqlError('ProviderRuntimeInbox.listAllOpenSessions')),
    )

  const matchesCurrentSession: ProviderRuntimeInboxShape['matchesCurrentSession'] = (identity) =>
    readCurrentSession(identity).pipe(
      Effect.map(
        Option.match({
          onNone: () => false,
          onSome: (session) =>
            session.provider === identity.provider &&
            session.sessionGeneration === identity.sessionGeneration,
        }),
      ),
      Effect.mapError(toSqlError('ProviderRuntimeInbox.matchesCurrentSession')),
    )

  const readRecord = SqlSchema.findOneOption({
    Request: Schema.Struct({ sequence: Schema.Number }),
    Result: ProviderRuntimeInboxRecord,
    execute: ({ sequence }) => sql`
      SELECT
        session.provider_kind AS provider,
        inbox.sequence,
        inbox.provider_instance_id AS "providerInstanceId",
        inbox.thread_id AS "threadId",
        inbox.session_generation AS "sessionGeneration",
        inbox.source_event_id AS "sourceEventId",
        inbox.event_type AS "eventType",
        inbox.event_created_at AS "eventCreatedAt",
        inbox.received_at AS "receivedAt",
        inbox.event_json AS "eventJson",
        inbox.event_digest AS "eventDigest"
      FROM provider_runtime_inbox AS inbox
      INNER JOIN provider_runtime_inbox_sessions AS session
        ON session.provider_instance_id = inbox.provider_instance_id
        AND session.thread_id = inbox.thread_id
        AND session.session_generation = inbox.session_generation
      WHERE inbox.sequence = ${sequence}
    `,
  })

  const readDuplicate = SqlSchema.findOneOption({
    Request: Schema.Struct({
      providerInstanceId: Schema.String,
      threadId: Schema.String,
      sessionGeneration: Schema.Number,
      sourceEventId: Schema.String,
    }),
    Result: ProviderRuntimeInboxRecord,
    execute: (input) => sql`
      SELECT
        session.provider_kind AS provider,
        inbox.sequence,
        inbox.provider_instance_id AS "providerInstanceId",
        inbox.thread_id AS "threadId",
        inbox.session_generation AS "sessionGeneration",
        inbox.source_event_id AS "sourceEventId",
        inbox.event_type AS "eventType",
        inbox.event_created_at AS "eventCreatedAt",
        inbox.received_at AS "receivedAt",
        inbox.event_json AS "eventJson",
        inbox.event_digest AS "eventDigest"
      FROM provider_runtime_inbox AS inbox
      INNER JOIN provider_runtime_inbox_sessions AS session
        ON session.provider_instance_id = inbox.provider_instance_id
        AND session.thread_id = inbox.thread_id
        AND session.session_generation = inbox.session_generation
      WHERE inbox.provider_instance_id = ${input.providerInstanceId}
        AND inbox.thread_id = ${input.threadId}
        AND inbox.session_generation = ${input.sessionGeneration}
        AND inbox.source_event_id = ${input.sourceEventId}
    `,
  })

  const append: ProviderRuntimeInboxShape['append'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const admission = yield* readAdmissionState(undefined)
          if (
            admission.activeOwnerId !== input.ownerId ||
            admission.ownerGeneration !== input.ownerGeneration
          )
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'owner-fenced',
              detail: 'the admission owner generation is no longer current',
              sourceEventId: input.sourceEventId,
            })
          }
          if (admission.mode !== 'required')
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'fenced',
              detail: `admission is fenced at sequence ${admission.highWaterSequence ?? admission.nextSequence - 1}`,
              sourceEventId: input.sourceEventId,
            })
          }

          const sessionOption = yield* readSession(input)
          if (Option.isNone(sessionOption))
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'session-missing',
              detail: `provider session generation ${input.sessionGeneration} is not registered`,
              sourceEventId: input.sourceEventId,
            })
          }
          const session = sessionOption.value
          const duplicate = yield* readDuplicate({
            ...input,
            sessionGeneration: session.sessionGeneration,
          })
          if (Option.isSome(duplicate))
          {
            if (
              duplicate.value.eventDigest !== input.eventDigest ||
              duplicate.value.eventJson !== input.eventJson ||
              duplicate.value.eventType !== input.eventType ||
              duplicate.value.eventCreatedAt !== input.eventCreatedAt
            )
            {
              return yield* new ProviderRuntimeInboxAdmissionError({
                reason: 'event-collision',
                detail: `source event '${input.sourceEventId}' changed within provider session generation ${session.sessionGeneration}`,
                sourceEventId: input.sourceEventId,
              })
            }
          }
          if (session.status === 'closed')
          {
            if (input.eventType !== 'session.exited')
            {
              return yield* new ProviderRuntimeInboxAdmissionError({
                reason: 'session-closed',
                detail: `provider session generation ${session.sessionGeneration} is already terminal`,
                sourceEventId: input.sourceEventId,
              })
            }
            if (Option.isSome(duplicate))
            {
              return ProviderRuntimeInboxAppendResult.make({
                record: duplicate.value,
                duplicate: true,
                terminalAlreadyClosed: true,
              })
            }
            if (session.closedSequence === null)
            {
              return yield* new PersistenceSqlError({
                operation: 'ProviderRuntimeInbox.append:missingClosedSequence',
              })
            }
            const terminalRecord = yield* readRecord({ sequence: session.closedSequence })
            if (
              Option.isNone(terminalRecord) ||
              terminalRecord.value.provider !== session.provider ||
              terminalRecord.value.providerInstanceId !== session.providerInstanceId ||
              terminalRecord.value.threadId !== session.threadId ||
              terminalRecord.value.sessionGeneration !== session.sessionGeneration ||
              terminalRecord.value.eventType !== 'session.exited'
            )
            {
              return yield* new PersistenceSqlError({
                operation: 'ProviderRuntimeInbox.append:missingTerminalRecord',
              })
            }
            return ProviderRuntimeInboxAppendResult.make({
              record: terminalRecord.value,
              duplicate: true,
              terminalAlreadyClosed: true,
            })
          }
          if (session.provider !== input.provider)
          {
            return yield* new ProviderRuntimeInboxAdmissionError({
              reason: 'session-provider-mismatch',
              detail: `provider session generation ${session.sessionGeneration} belongs to '${session.provider}', not '${input.provider}'`,
              sourceEventId: input.sourceEventId,
            })
          }
          if (Option.isSome(duplicate))
          {
            return ProviderRuntimeInboxAppendResult.make({
              record: duplicate.value,
              duplicate: true,
              terminalAlreadyClosed: false,
            })
          }

          const sequence = admission.nextSequence
          yield* sql`
            INSERT INTO provider_runtime_inbox (
              sequence,
              provider_instance_id,
              thread_id,
              session_generation,
              source_event_id,
              event_type,
              event_created_at,
              received_at,
              event_json,
              event_digest
            )
            VALUES (
              ${sequence},
              ${input.providerInstanceId},
              ${input.threadId},
              ${session.sessionGeneration},
              ${input.sourceEventId},
              ${input.eventType},
              ${input.eventCreatedAt},
              ${input.receivedAt},
              ${input.eventJson},
              ${input.eventDigest}
            )
          `
          yield* sql`
            UPDATE provider_runtime_inbox_control
            SET next_sequence = ${sequence + 1}, updated_at = ${input.receivedAt}
            WHERE singleton_id = 1
              AND active_owner_id = ${input.ownerId}
              AND owner_generation = ${input.ownerGeneration}
              AND next_sequence = ${sequence}
          `
          yield* sql`
            UPDATE provider_runtime_inbox_sessions
            SET
              opened_sequence = COALESCE(opened_sequence, ${sequence}),
              status = CASE WHEN ${input.eventType} = 'session.exited' THEN 'closed' ELSE status END,
              closed_sequence = CASE
                WHEN ${input.eventType} = 'session.exited' THEN ${sequence}
                ELSE closed_sequence
              END,
              updated_at = ${input.receivedAt}
            WHERE provider_instance_id = ${input.providerInstanceId}
              AND thread_id = ${input.threadId}
              AND session_generation = ${session.sessionGeneration}
          `
          const record = yield* readRecord({ sequence })
          if (Option.isNone(record))
          {
            return yield* new PersistenceSqlError({
              operation: 'ProviderRuntimeInbox.append:missingRecord',
            })
          }
          return ProviderRuntimeInboxAppendResult.make({
            record: record.value,
            duplicate: false,
            terminalAlreadyClosed: false,
          })
        }),
      )
      .pipe(
        Effect.tap((result) =>
          result.duplicate ? Effect.void : PubSub.publish(wakeups, result.record.sequence),
        ),
        Effect.mapError(mapInboxError('ProviderRuntimeInbox.append')),
      )

  const get: ProviderRuntimeInboxShape['get'] = (sequence) =>
    readRecord({ sequence }).pipe(Effect.mapError(toSqlError('ProviderRuntimeInbox.get')))

  const readPageQuery = SqlSchema.findAll({
    Request: Schema.Struct({ afterSequence: Schema.Number, limit: Schema.Number }),
    Result: ProviderRuntimeInboxRecord,
    execute: (input) => sql`
      SELECT
        session.provider_kind AS provider,
        inbox.sequence,
        inbox.provider_instance_id AS "providerInstanceId",
        inbox.thread_id AS "threadId",
        inbox.session_generation AS "sessionGeneration",
        inbox.source_event_id AS "sourceEventId",
        inbox.event_type AS "eventType",
        inbox.event_created_at AS "eventCreatedAt",
        inbox.received_at AS "receivedAt",
        inbox.event_json AS "eventJson",
        inbox.event_digest AS "eventDigest"
      FROM provider_runtime_inbox AS inbox
      INNER JOIN provider_runtime_inbox_sessions AS session
        ON session.provider_instance_id = inbox.provider_instance_id
        AND session.thread_id = inbox.thread_id
        AND session.session_generation = inbox.session_generation
      WHERE inbox.sequence > ${input.afterSequence}
      ORDER BY inbox.sequence ASC
      LIMIT ${input.limit}
    `,
  })

  const readPage: ProviderRuntimeInboxShape['readPage'] = (input) =>
    readPageQuery(input).pipe(Effect.mapError(toSqlError('ProviderRuntimeInbox.readPage')))

  const readBuffer = SqlSchema.findOneOption({
    Request: Schema.Struct({ consumerId: Schema.String }),
    Result: ProviderRuntimeInboxBuffer,
    execute: ({ consumerId }) => sql`
      SELECT
        consumer_id AS "consumerId",
        state_version AS "stateVersion",
        through_sequence AS "throughSequence",
        state_json AS "stateJson",
        updated_at AS "updatedAt"
      FROM provider_runtime_inbox_buffers
      WHERE consumer_id = ${consumerId}
    `,
  })

  const getBuffer: ProviderRuntimeInboxShape['getBuffer'] = (consumerId) =>
    readBuffer({ consumerId }).pipe(Effect.mapError(toSqlError('ProviderRuntimeInbox.getBuffer')))

  const readDiagnostics = SqlSchema.findOne({
    Request: Schema.Void,
    Result: DiagnosticsRow,
    execute: () => sql`
      WITH consumer_progress AS (
        SELECT
          MAX(
            CASE
              WHEN reactor_id = 'provider-runtime-ingestion' THEN cursor_sequence
              ELSE NULL
            END
          ) AS ingestion_cursor_sequence,
          MAX(
            CASE
              WHEN reactor_id = 'provider-runtime-checkpoint' THEN cursor_sequence
              ELSE NULL
            END
          ) AS checkpoint_cursor_sequence
        FROM orchestration_reactor_progress
        WHERE reactor_id IN (
          'provider-runtime-ingestion',
          'provider-runtime-checkpoint'
        )
      )
      SELECT
        control.admission_mode AS "admissionMode",
        control.next_sequence - 1 AS "lastSequence",
        COUNT(inbox.sequence) AS "retainedRecordCount",
        COALESCE(
          SUM(
            CASE
              WHEN inbox.sequence > MIN(
                COALESCE(progress.ingestion_cursor_sequence, 0),
                COALESCE(progress.checkpoint_cursor_sequence, 0)
              ) THEN 1
              ELSE 0
            END
          ),
          0
        ) AS "backlogCount",
        MIN(
          CASE
            WHEN inbox.sequence > MIN(
              COALESCE(progress.ingestion_cursor_sequence, 0),
              COALESCE(progress.checkpoint_cursor_sequence, 0)
            ) THEN inbox.received_at
            ELSE NULL
          END
        ) AS "oldestPendingReceivedAt",
        progress.ingestion_cursor_sequence AS "ingestionCursorSequence",
        progress.checkpoint_cursor_sequence AS "checkpointCursorSequence"
      FROM provider_runtime_inbox_control AS control
      CROSS JOIN consumer_progress AS progress
      LEFT JOIN provider_runtime_inbox AS inbox ON TRUE
      WHERE control.singleton_id = 1
      GROUP BY control.singleton_id
    `,
  })

  const getDiagnostics: ProviderRuntimeInboxShape['getDiagnostics'] = readDiagnostics(
    undefined,
  ).pipe(
    Effect.map((row) =>
    {
      const ingestionCursorSequence = row.ingestionCursorSequence ?? 0
      const checkpointCursorSequence = row.checkpointCursorSequence ?? 0
      return ProviderRuntimeInboxDiagnostics.make({
        admissionMode: row.admissionMode,
        lastSequence: row.lastSequence,
        retainedRecordCount: row.retainedRecordCount,
        backlogCount: row.backlogCount,
        oldestPendingReceivedAt: row.oldestPendingReceivedAt,
        consumers: [
          {
            consumerId: 'provider-runtime-ingestion',
            cursorSequence: ingestionCursorSequence,
            lag: Math.max(0, row.lastSequence - ingestionCursorSequence),
          },
          {
            consumerId: 'provider-runtime-checkpoint',
            cursorSequence: checkpointCursorSequence,
            lag: Math.max(0, row.lastSequence - checkpointCursorSequence),
          },
        ],
      })
    }),
    Effect.mapError(toSqlError('ProviderRuntimeInbox.getDiagnostics')),
  )

  const completeConsumerEvent: ProviderRuntimeInboxShape['completeConsumerEvent'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const action = yield* SqlSchema.findOneOption({
            Request: Schema.Void,
            Result: ChangedRow,
            execute: () => sql`
              UPDATE orchestration_reactor_actions
              SET
                status = 'succeeded',
                lease_owner = NULL,
                lease_expires_at = NULL,
                outcome_json = ${input.outcomeJson ?? null},
                last_error = NULL,
                updated_at = ${input.now},
                completed_at = ${input.now}
              WHERE action_id = ${input.actionId}
                AND reactor_id = ${input.consumerId}
                AND source_sequence = ${input.record.sequence}
                AND status = 'leased'
                AND lease_owner = ${input.ownerId}
                AND lease_epoch = ${input.leaseEpoch}
                AND EXISTS (
                  SELECT 1
                  FROM orchestration_reactor_progress AS progress
                  WHERE progress.reactor_id = ${input.consumerId}
                    AND progress.active_owner_id = ${input.ownerId}
                    AND progress.cursor_sequence = ${input.record.sequence - 1}
                    AND (
                      progress.high_water_sequence IS NULL
                      OR ${input.record.sequence} <= progress.high_water_sequence
                    )
                )
                AND (
                  EXISTS (
                    SELECT 1
                    FROM provider_runtime_inbox_buffers AS buffer
                    WHERE buffer.consumer_id = ${input.consumerId}
                      AND buffer.through_sequence = ${input.record.sequence - 1}
                  )
                  OR (
                    ${input.record.sequence} = 1
                    AND NOT EXISTS (
                      SELECT 1
                      FROM provider_runtime_inbox_buffers AS buffer
                      WHERE buffer.consumer_id = ${input.consumerId}
                    )
                  )
                )
              RETURNING 1 AS changed
            `,
          })(undefined)
          if (Option.isNone(action))
          {
            return false
          }

          const buffer = yield* SqlSchema.findOneOption({
            Request: Schema.Void,
            Result: ChangedRow,
            execute: () => sql`
              INSERT INTO provider_runtime_inbox_buffers (
                consumer_id,
                state_version,
                through_sequence,
                state_json,
                updated_at
              )
              VALUES (
                ${input.consumerId},
                ${input.stateVersion},
                ${input.record.sequence},
                ${input.stateJson},
                ${input.now}
              )
              ON CONFLICT (consumer_id) DO UPDATE SET
                state_version = excluded.state_version,
                through_sequence = excluded.through_sequence,
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
              WHERE provider_runtime_inbox_buffers.through_sequence = ${input.record.sequence - 1}
              RETURNING 1 AS changed
            `,
          })(undefined)
          if (Option.isNone(buffer))
          {
            return yield* new PersistenceSqlError({
              operation: 'ProviderRuntimeInbox.completeConsumerEvent:bufferFence',
            })
          }

          yield* sql`
            INSERT INTO provider_runtime_inbox_consumer_sessions (
              consumer_id,
              provider_instance_id,
              thread_id,
              session_generation,
              through_sequence,
              buffer_terminal,
              updated_at
            )
            VALUES (
              ${input.consumerId},
              ${input.record.providerInstanceId},
              ${input.record.threadId},
              ${input.record.sessionGeneration},
              ${input.record.sequence},
              ${input.sessionBufferTerminal ? 1 : 0},
              ${input.now}
            )
            ON CONFLICT (
              consumer_id,
              provider_instance_id,
              thread_id,
              session_generation
            ) DO UPDATE SET
              through_sequence = excluded.through_sequence,
              buffer_terminal = excluded.buffer_terminal,
              updated_at = excluded.updated_at
          `

          const cursor = yield* SqlSchema.findOneOption({
            Request: Schema.Void,
            Result: ChangedRow,
            execute: () => sql`
              UPDATE orchestration_reactor_progress
              SET
                cursor_sequence = ${input.record.sequence},
                blocked_sequence = NULL,
                last_error = NULL,
                updated_at = ${input.now}
              WHERE reactor_id = ${input.consumerId}
                AND mode = 'durable'
                AND active_owner_id = ${input.ownerId}
                AND cursor_sequence = ${input.record.sequence - 1}
                AND (
                  high_water_sequence IS NULL
                  OR ${input.record.sequence} <= high_water_sequence
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_reactor_actions AS action
                  WHERE action.reactor_id = ${input.consumerId}
                    AND action.source_sequence = ${input.record.sequence}
                    AND action.status NOT IN ('succeeded', 'resolved')
                )
              RETURNING 1 AS changed
            `,
          })(undefined)
          if (Option.isNone(cursor))
          {
            return yield* new PersistenceSqlError({
              operation: 'ProviderRuntimeInbox.completeConsumerEvent:cursorFence',
            })
          }
          yield* sql`
            UPDATE provider_runtime_inbox_sessions AS session
            SET
              consumers_completed_at = COALESCE(session.consumers_completed_at, ${input.now}),
              updated_at = ${input.now}
            WHERE session.provider_instance_id = ${input.record.providerInstanceId}
              AND session.thread_id = ${input.record.threadId}
              AND session.session_generation = ${input.record.sessionGeneration}
              AND session.status = 'closed'
              AND session.consumers_completed_at IS NULL
              AND NOT EXISTS (
                SELECT required_consumer.consumer_id
                FROM (
                  SELECT 'provider-runtime-ingestion' AS consumer_id
                  UNION ALL
                  SELECT 'provider-runtime-checkpoint'
                ) AS required_consumer
                LEFT JOIN provider_runtime_inbox_consumer_sessions AS consumer_session
                  ON consumer_session.consumer_id = required_consumer.consumer_id
                  AND consumer_session.provider_instance_id = session.provider_instance_id
                  AND consumer_session.thread_id = session.thread_id
                  AND consumer_session.session_generation = session.session_generation
                WHERE consumer_session.buffer_terminal IS NULL
                  OR consumer_session.buffer_terminal <> 1
                  OR consumer_session.through_sequence < session.closed_sequence
              )
          `
          return true
        }),
      )
      .pipe(Effect.mapError(toSqlError('ProviderRuntimeInbox.completeConsumerEvent')))

  const pruneCompleted: ProviderRuntimeInboxShape['pruneCompleted'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const rows = yield* SqlSchema.findAll({
            Request: Schema.Void,
            Result: SequenceRow,
            execute: () => sql`
              DELETE FROM provider_runtime_inbox
              WHERE EXISTS (
                SELECT 1
                FROM provider_runtime_inbox_sessions AS session
                WHERE session.provider_instance_id = provider_runtime_inbox.provider_instance_id
                  AND session.thread_id = provider_runtime_inbox.thread_id
                  AND session.session_generation = provider_runtime_inbox.session_generation
                  AND session.status = 'closed'
                  AND session.consumers_completed_at IS NOT NULL
                  AND session.consumers_completed_at <= ${input.completedBefore}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM (
                  SELECT 'provider-runtime-ingestion' AS consumer_id
                  UNION ALL
                  SELECT 'provider-runtime-checkpoint'
                ) AS required_consumer
                LEFT JOIN orchestration_reactor_progress AS progress
                  ON progress.reactor_id = required_consumer.consumer_id
                LEFT JOIN provider_runtime_inbox_consumer_sessions AS consumer_session
                  ON consumer_session.consumer_id = required_consumer.consumer_id
                  AND consumer_session.provider_instance_id = provider_runtime_inbox.provider_instance_id
                  AND consumer_session.thread_id = provider_runtime_inbox.thread_id
                  AND consumer_session.session_generation = provider_runtime_inbox.session_generation
                WHERE progress.cursor_sequence IS NULL
                  OR progress.cursor_sequence < provider_runtime_inbox.sequence
                  OR consumer_session.buffer_terminal IS NULL
                  OR consumer_session.buffer_terminal <> 1
                  OR consumer_session.through_sequence < provider_runtime_inbox.sequence
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_reactor_actions AS action
                WHERE action.source_sequence = provider_runtime_inbox.sequence
                  AND action.reactor_id IN (
                    'provider-runtime-ingestion',
                    'provider-runtime-checkpoint'
                  )
                  AND action.status NOT IN ('succeeded', 'resolved')
                )
              RETURNING sequence
            `,
          })(undefined)
          // discard consumer payloads but retain the newest session row as a generation tombstone
          yield* sql`
            DELETE FROM provider_runtime_inbox_consumer_sessions AS consumer_session
            WHERE EXISTS (
              SELECT 1
              FROM provider_runtime_inbox_sessions AS session
              WHERE session.provider_instance_id = consumer_session.provider_instance_id
                AND session.thread_id = consumer_session.thread_id
                AND session.session_generation = consumer_session.session_generation
                AND session.status = 'closed'
                AND session.consumers_completed_at IS NOT NULL
                AND session.consumers_completed_at <= ${input.completedBefore}
            )
              AND NOT EXISTS (
                SELECT 1
                FROM provider_runtime_inbox AS inbox
                WHERE inbox.provider_instance_id = consumer_session.provider_instance_id
                  AND inbox.thread_id = consumer_session.thread_id
                  AND inbox.session_generation = consumer_session.session_generation
              )
          `
          yield* sql`
            DELETE FROM provider_runtime_inbox_sessions AS session
            WHERE session.status = 'closed'
              AND session.consumers_completed_at IS NOT NULL
              AND session.consumers_completed_at <= ${input.completedBefore}
              AND NOT EXISTS (
                SELECT 1
                FROM provider_runtime_inbox AS inbox
                WHERE inbox.provider_instance_id = session.provider_instance_id
                  AND inbox.thread_id = session.thread_id
                  AND inbox.session_generation = session.session_generation
              )
              AND EXISTS (
                SELECT 1
                FROM provider_runtime_inbox_sessions AS newer_session
                WHERE newer_session.provider_instance_id = session.provider_instance_id
                  AND newer_session.thread_id = session.thread_id
                  AND newer_session.session_generation > session.session_generation
              )
          `
          return rows
        }),
      )
      .pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(toSqlError('ProviderRuntimeInbox.pruneCompleted')),
      )

  return ProviderRuntimeInbox.of({
    claimAdmissionOwner,
    getAdmissionState,
    setAdmissionMode,
    resumeAdmissionAfterHandoff,
    beginSession,
    append,
    getCurrentSession,
    getSession,
    listOpenSessions,
    listAllOpenSessions,
    matchesCurrentSession,
    get,
    readPage,
    getBuffer,
    getDiagnostics,
    completeConsumerEvent,
    pruneCompleted,
    get wakeups()
    {
      return Stream.fromPubSub(wakeups)
    },
  })
})

export const ProviderRuntimeInboxLive = Layer.effect(ProviderRuntimeInbox, make)
