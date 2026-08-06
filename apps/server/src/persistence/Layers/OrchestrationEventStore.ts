// apps/server/src/persistence/Layers/OrchestrationEventStore.ts
// manage orchestration event state

import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  UNKNOWN_ORCHESTRATION_EVENT_TYPE,
  ProjectId,
  ThreadId,
} from '@t3tools/contracts'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import {
  toPersistenceDecodeError,
  toPersistenceSqlOrDecodeError,
  type OrchestrationEventStoreError,
} from '../Errors.ts'
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from '../Services/OrchestrationEventStore.ts'

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent)
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata)

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, ThreadId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
})
const AppendEventsRequestSchema = Schema.Array(AppendEventRequestSchema)

const OrchestrationEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
})

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
})
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000
const READ_PAGE_SIZE = 500

function inferActorKind(
  event: Omit<OrchestrationEvent, 'sequence'>,
): Schema.Schema.Type<typeof OrchestrationActorKind>
{
  if (event.commandId !== null && event.commandId.startsWith('provider:'))
  {
    return 'provider'
  }
  if (event.commandId !== null && event.commandId.startsWith('server:'))
  {
    return 'server'
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  )
  {
    return 'provider'
  }
  if (event.commandId === null)
  {
    return 'server'
  }
  return 'client'
}

const makeEventStore = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const appendEventRows = SqlSchema.findAll({
    Request: AppendEventsRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (requests) =>
      sql`
        WITH input_events (
          ordinal,
          event_id,
          aggregate_kind,
          stream_id,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        ) AS (
          VALUES ${sql.join(
            ',',
            false,
          )(
            requests.map(
              (request, index) =>
                sql`(
                ${index},
                ${request.eventId},
                ${request.aggregateKind},
                ${request.streamId},
                ${request.type},
                ${request.occurredAt},
                ${request.commandId},
                ${request.causationEventId},
                ${request.correlationId},
                ${request.actorKind},
                ${request.payloadJson},
                ${request.metadataJson}
              )`,
            ),
          )}
        ),
        versioned_events AS (
          SELECT
            input_events.*,
            COALESCE(
              (
                SELECT MAX(existing.stream_version) + 1
                FROM orchestration_events AS existing
                WHERE existing.aggregate_kind = input_events.aggregate_kind
                  AND existing.stream_id = input_events.stream_id
              ),
              0
            ) + ROW_NUMBER() OVER (
              PARTITION BY aggregate_kind, stream_id
              ORDER BY ordinal
            ) - 1 AS stream_version
          FROM input_events
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        FROM versioned_events
        ORDER BY ordinal
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  })

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  })

  const appendEvents = (
    events: ReadonlyArray<Omit<OrchestrationEvent, 'sequence'>>,
    operation: 'append' | 'appendAll',
  ): Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError> =>
  {
    if (events.length === 0)
    {
      return Effect.succeed([])
    }
    return Effect.forEach(events, (event) =>
    {
      // the unknown-event sentinel exists for decode-side tolerance only; the
      // server always constructs concrete events, so persisting one is a defect
      if (event.type === UNKNOWN_ORCHESTRATION_EVENT_TYPE)
      {
        return Effect.die(
          new Error('Unknown-event sentinels are decode-side only and cannot be appended.'),
        )
      }
      return Effect.succeed({
        eventId: event.eventId,
        aggregateKind: event.aggregateKind,
        streamId: event.aggregateId,
        type: event.type,
        causationEventId: event.causationEventId,
        correlationId: event.correlationId,
        actorKind: inferActorKind(event),
        occurredAt: event.occurredAt,
        commandId: event.commandId,
        payloadJson: event.payload,
        metadataJson: event.metadata,
      })
    }).pipe(
      Effect.flatMap(appendEventRows),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          `OrchestrationEventStore.${operation}:insert`,
          `OrchestrationEventStore.${operation}:decodeRows`,
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          [...rows].sort((left, right) => left.sequence - right.sequence),
          (row) =>
            decodeEvent(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(`OrchestrationEventStore.${operation}:rowToEvent`),
              ),
            ),
        ),
      ),
    )
  }

  const append: OrchestrationEventStoreShape['append'] = (event) =>
    appendEvents([event], 'append').pipe(Effect.map((events) => events[0]!))

  const appendAll: OrchestrationEventStoreShape['appendAll'] = (events) =>
    appendEvents(events, 'appendAll')

  const readFromSequence: OrchestrationEventStoreShape['readFromSequence'] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) =>
  {
    const normalizedLimit = Math.max(0, Math.floor(limit))
    if (normalizedLimit === 0)
    {
      return Stream.empty
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              'OrchestrationEventStore.readFromSequence:query',
              'OrchestrationEventStore.readFromSequence:decodeRows',
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEvent(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError('OrchestrationEventStore.readFromSequence:rowToEvent'),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) =>
        {
          if (events.length === 0)
          {
            return Stream.empty
          }
          const nextRemaining = remaining - events.length
          if (nextRemaining <= 0)
          {
            return Stream.fromIterable(events)
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          )
        }),
      )

    return readPage(sequenceExclusive, normalizedLimit)
  }

  return {
    append,
    appendAll,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
  } satisfies OrchestrationEventStoreShape
})

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore)
