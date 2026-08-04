// apps/server/src/persistence/Layers/OrchestrationReactorDelivery.ts
// persists ordered reactor actions with lease and cursor fencing

import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import { ReactorDeliveryError } from '../Errors.ts'
import {
  makeReactorActionId,
  OrchestrationReactorDelivery,
  type OrchestrationReactorDeliveryShape,
  ReactorActionRecord,
  ReactorProgress,
} from '../Services/OrchestrationReactorDelivery.ts'

const ChangedRow = Schema.Struct({ changed: Schema.Number })
const RecoveredRow = Schema.Struct({ actionId: Schema.String })
const OutcomeRow = Schema.Struct({ reactorId: Schema.String, sourceSequence: Schema.Number })

const addMilliseconds = (iso: string, milliseconds: number): string =>
  DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(iso), milliseconds))

const toReactorDeliveryError = (operation: string) => (cause: unknown) =>
  new ReactorDeliveryError({ operation, cause })

const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const readProgress = SqlSchema.findOneOption({
    Request: Schema.Struct({ reactorId: Schema.String }),
    Result: ReactorProgress,
    execute: ({ reactorId }) => sql`
      SELECT
        reactor_id AS "reactorId",
        operation_version AS "operationVersion",
        mode,
        cursor_sequence AS "cursorSequence",
        shadow_cursor_sequence AS "shadowCursorSequence",
        high_water_sequence AS "highWaterSequence",
        blocked_sequence AS "blockedSequence",
        active_owner_id AS "activeOwnerId",
        owner_epoch AS "ownerEpoch",
        last_error AS "lastError",
        updated_at AS "updatedAt"
      FROM orchestration_reactor_progress
      WHERE reactor_id = ${reactorId}
    `,
  })

  const ensureProgress: OrchestrationReactorDeliveryShape['ensureProgress'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          yield* sql`
            INSERT INTO orchestration_reactor_progress (
              reactor_id,
              operation_version,
              mode,
              cursor_sequence,
              shadow_cursor_sequence,
              updated_at
            )
            VALUES (
              ${input.reactorId},
              ${input.operationVersion},
              ${input.mode},
              ${input.initialSequence},
              ${input.initialSequence},
              ${input.now}
            )
            ON CONFLICT (reactor_id) DO UPDATE SET
              operation_version = excluded.operation_version,
              updated_at = excluded.updated_at
          `
          const progress = yield* readProgress({ reactorId: input.reactorId })
          if (Option.isNone(progress))
          {
            return yield* new ReactorDeliveryError({
              operation: 'OrchestrationReactorDelivery.ensureProgress:missingRow',
            })
          }
          return progress.value
        }),
      )
      .pipe(
        Effect.mapError(
          toReactorDeliveryError('OrchestrationReactorDelivery.ensureProgress:transaction'),
        ),
      )

  const getProgress: OrchestrationReactorDeliveryShape['getProgress'] = (reactorId) =>
    readProgress({ reactorId }).pipe(
      Effect.mapError(toReactorDeliveryError('OrchestrationReactorDelivery.getProgress:query')),
    )

  const materialize: OrchestrationReactorDeliveryShape['materialize'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const status = input.mode === 'shadow' ? 'shadow' : 'pending'
          for (const action of input.actions)
          {
            const identity = {
              reactorId: input.reactorId,
              sourceSequence: input.sourceSequence,
              sourceEventId: input.sourceEventId,
              outputIndex: action.outputIndex,
              effectKind: action.effectKind,
              targetKind: action.targetKind,
              targetId: action.targetId,
              operationVersion: input.operationVersion,
            } as const
            yield* sql`
              INSERT INTO orchestration_reactor_actions (
                action_id,
                reactor_id,
                source_sequence,
                source_event_id,
                output_index,
                effect_kind,
                target_kind,
                target_id,
                operation_version,
                payload_json,
                status,
                available_at,
                created_at,
                updated_at
              )
              VALUES (
                ${makeReactorActionId(identity)},
                ${input.reactorId},
                ${input.sourceSequence},
                ${input.sourceEventId},
                ${action.outputIndex},
                ${action.effectKind},
                ${action.targetKind},
                ${action.targetId},
                ${input.operationVersion},
                ${action.payloadJson},
                ${status},
                ${input.now},
                ${input.now},
                ${input.now}
              )
              ON CONFLICT DO NOTHING
            `
          }

          if (input.mode === 'shadow')
          {
            yield* sql`
              UPDATE orchestration_reactor_progress
              SET
                shadow_cursor_sequence = CASE
                  WHEN shadow_cursor_sequence < ${input.sourceSequence}
                    THEN ${input.sourceSequence}
                  ELSE shadow_cursor_sequence
                END,
                updated_at = ${input.now}
              WHERE reactor_id = ${input.reactorId}
            `
          }
        }),
      )
      .pipe(
        Effect.mapError(
          toReactorDeliveryError('OrchestrationReactorDelivery.materialize:transaction'),
        ),
      )

  const claimAction = SqlSchema.findOneOption({
    Request: Schema.Struct({
      reactorId: Schema.String,
      ownerId: Schema.String,
      now: Schema.String,
      leaseExpiresAt: Schema.String,
    }),
    Result: ReactorActionRecord,
    execute: ({ reactorId, ownerId, now, leaseExpiresAt }) => sql`
      UPDATE orchestration_reactor_actions
      SET
        status = 'leased',
        attempt_count = attempt_count + 1,
        lease_owner = ${ownerId},
        lease_epoch = COALESCE(lease_epoch, 0) + 1,
        lease_expires_at = ${leaseExpiresAt},
        updated_at = ${now}
      WHERE action_id = (
        SELECT candidate.action_id
        FROM orchestration_reactor_actions AS candidate
        JOIN orchestration_reactor_progress AS progress
          ON progress.reactor_id = candidate.reactor_id
        WHERE candidate.reactor_id = ${reactorId}
          AND progress.mode = 'durable'
          AND progress.active_owner_id = ${ownerId}
          AND candidate.source_sequence > progress.cursor_sequence
          AND (
            progress.high_water_sequence IS NULL
            OR candidate.source_sequence <= progress.high_water_sequence
          )
          AND candidate.status IN ('pending', 'retryable')
          AND candidate.available_at <= ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_reactor_actions AS earlier
            WHERE earlier.reactor_id = candidate.reactor_id
              AND earlier.status NOT IN ('succeeded', 'resolved', 'shadow')
              AND NOT (
                candidate.effect_kind = 'thread.provider.switch.compensate'
                AND earlier.source_sequence = candidate.source_sequence
                AND earlier.status IN ('unknown', 'poison', 'manual')
              )
              AND earlier.source_sequence > progress.cursor_sequence
              AND (
                earlier.source_sequence < candidate.source_sequence
                OR (
                  earlier.source_sequence = candidate.source_sequence
                  AND earlier.output_index < candidate.output_index
                )
              )
          )
        ORDER BY
          candidate.source_sequence ASC,
          candidate.output_index ASC,
          candidate.action_id ASC
        LIMIT 1
      )
      RETURNING
        action_id AS "actionId",
        reactor_id AS "reactorId",
        source_sequence AS "sourceSequence",
        source_event_id AS "sourceEventId",
        output_index AS "outputIndex",
        effect_kind AS "effectKind",
        target_kind AS "targetKind",
        target_id AS "targetId",
        operation_version AS "operationVersion",
        payload_json AS "payloadJson",
        status,
        attempt_count AS "attemptCount",
        available_at AS "availableAt",
        lease_owner AS "leaseOwner",
        lease_epoch AS "leaseEpoch",
        lease_expires_at AS "leaseExpiresAt",
        last_error AS "lastError",
        outcome_json AS "outcomeJson"
    `,
  })

  const claimNext: OrchestrationReactorDeliveryShape['claimNext'] = (input) =>
    sql
      .withTransaction(
        claimAction({
          reactorId: input.reactorId,
          ownerId: input.ownerId,
          now: input.now,
          leaseExpiresAt: addMilliseconds(input.now, input.leaseDurationMs),
        }),
      )
      .pipe(
        Effect.mapError(
          toReactorDeliveryError('OrchestrationReactorDelivery.claimNext:transaction'),
        ),
      )

  const renewActionLease = SqlSchema.findOneOption({
    Request: Schema.Struct({
      actionId: Schema.String,
      ownerId: Schema.String,
      leaseEpoch: Schema.Number,
      leaseExpiresAt: Schema.String,
      now: Schema.String,
    }),
    Result: ChangedRow,
    execute: ({ actionId, ownerId, leaseEpoch, leaseExpiresAt, now }) => sql`
      UPDATE orchestration_reactor_actions
      SET lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
      WHERE action_id = ${actionId}
        AND status = 'leased'
        AND lease_owner = ${ownerId}
        AND lease_epoch = ${leaseEpoch}
        AND EXISTS (
          SELECT 1
          FROM orchestration_reactor_progress AS progress
          WHERE progress.reactor_id = orchestration_reactor_actions.reactor_id
            AND progress.active_owner_id = ${ownerId}
        )
      RETURNING 1 AS changed
    `,
  })

  const renewLease: OrchestrationReactorDeliveryShape['renewLease'] = (input) =>
    renewActionLease({
      actionId: input.actionId,
      ownerId: input.ownerId,
      leaseEpoch: input.leaseEpoch,
      leaseExpiresAt: addMilliseconds(input.now, input.leaseDurationMs),
      now: input.now,
    }).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(toReactorDeliveryError('OrchestrationReactorDelivery.renewLease:query')),
    )

  const updateActionOutcome = SqlSchema.findOneOption({
    Request: Schema.Struct({
      actionId: Schema.String,
      ownerId: Schema.String,
      leaseEpoch: Schema.Number,
      status: Schema.String,
      outcomeJson: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
      availableAt: Schema.String,
      now: Schema.String,
    }),
    Result: OutcomeRow,
    execute: (input) => sql`
      UPDATE orchestration_reactor_actions
      SET
        status = ${input.status},
        available_at = ${input.availableAt},
        lease_owner = NULL,
        lease_expires_at = NULL,
        outcome_json = ${input.outcomeJson},
        last_error = ${input.error},
        updated_at = ${input.now},
        completed_at = CASE WHEN ${input.status} = 'succeeded' THEN ${input.now} ELSE NULL END
      WHERE action_id = ${input.actionId}
        AND status = 'leased'
        AND lease_owner = ${input.ownerId}
        AND lease_epoch = ${input.leaseEpoch}
        AND EXISTS (
          SELECT 1
          FROM orchestration_reactor_progress AS progress
          WHERE progress.reactor_id = orchestration_reactor_actions.reactor_id
            AND progress.active_owner_id = ${input.ownerId}
        )
      RETURNING reactor_id AS "reactorId", source_sequence AS "sourceSequence"
    `,
  })

  const refreshBlockedSequence = (reactorId: string, now: string, lastError?: string) => sql`
    UPDATE orchestration_reactor_progress
    SET
      blocked_sequence = (
        SELECT MIN(source_sequence)
        FROM orchestration_reactor_actions
        WHERE reactor_id = ${reactorId}
          AND status IN ('unknown', 'poison', 'manual')
      ),
      last_error = ${lastError ?? null},
      updated_at = ${now}
    WHERE reactor_id = ${reactorId}
  `

  const recordOutcome: OrchestrationReactorDeliveryShape['recordOutcome'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const updated = yield* updateActionOutcome({
            actionId: input.actionId,
            ownerId: input.ownerId,
            leaseEpoch: input.leaseEpoch,
            status: input.status,
            outcomeJson: input.outcomeJson ?? null,
            error: input.error ?? null,
            availableAt: input.nextAttemptAt ?? input.now,
            now: input.now,
          })
          if (Option.isNone(updated))
          {
            return false
          }
          yield* refreshBlockedSequence(updated.value.reactorId, input.now, input.error)
          return true
        }),
      )
      .pipe(
        Effect.mapError(
          toReactorDeliveryError('OrchestrationReactorDelivery.recordOutcome:transaction'),
        ),
      )

  const advanceReactorCursor = SqlSchema.findOneOption({
    Request: Schema.Struct({
      reactorId: Schema.String,
      sourceSequence: Schema.Number,
      expectedPreviousSequence: Schema.Number,
      now: Schema.String,
    }),
    Result: ChangedRow,
    execute: (input) => sql`
      UPDATE orchestration_reactor_progress
      SET
        cursor_sequence = ${input.sourceSequence},
        blocked_sequence = NULL,
        last_error = NULL,
        updated_at = ${input.now}
      WHERE reactor_id = ${input.reactorId}
        AND mode = 'durable'
        AND cursor_sequence = ${input.expectedPreviousSequence}
        AND ${input.sourceSequence} = ${input.expectedPreviousSequence} + 1
        AND (high_water_sequence IS NULL OR ${input.sourceSequence} <= high_water_sequence)
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_reactor_actions AS action
          WHERE action.reactor_id = ${input.reactorId}
            AND action.source_sequence = ${input.sourceSequence}
            AND action.status NOT IN ('succeeded', 'resolved')
        )
      RETURNING 1 AS changed
    `,
  })

  const advanceCursor: OrchestrationReactorDeliveryShape['advanceCursor'] = (input) =>
    advanceReactorCursor(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(toReactorDeliveryError('OrchestrationReactorDelivery.advanceCursor:query')),
    )

  const recoverExpiredLeases: OrchestrationReactorDeliveryShape['recoverExpiredLeases'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const rows = yield* SqlSchema.findAll({
            Request: Schema.Void,
            Result: RecoveredRow,
            execute: () => sql`
              UPDATE orchestration_reactor_actions
              SET
                status = ${input.policy},
                available_at = ${input.now},
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = 'lease expired before an outcome was recorded',
                updated_at = ${input.now}
              WHERE reactor_id = ${input.reactorId}
                AND status = 'leased'
                AND lease_expires_at <= ${input.now}
                AND EXISTS (
                  SELECT 1
                  FROM orchestration_reactor_progress AS progress
                  WHERE progress.reactor_id = ${input.reactorId}
                    AND progress.active_owner_id = ${input.ownerId}
                )
              RETURNING action_id AS "actionId"
            `,
          })(undefined)
          yield* refreshBlockedSequence(
            input.reactorId,
            input.now,
            rows.length === 0 ? undefined : 'lease expired before an outcome was recorded',
          )
          return rows.length
        }),
      )
      .pipe(
        Effect.mapError(
          toReactorDeliveryError('OrchestrationReactorDelivery.recoverExpiredLeases:transaction'),
        ),
      )

  const resolveAction = SqlSchema.findOneOption({
    Request: Schema.Struct({
      actionId: Schema.String,
      status: Schema.String,
      operator: Schema.String,
      resolution: Schema.String,
      now: Schema.String,
    }),
    Result: OutcomeRow,
    execute: (input) => sql`
      UPDATE orchestration_reactor_actions
      SET
        status = ${input.status},
        available_at = ${input.now},
        lease_owner = NULL,
        lease_expires_at = NULL,
        resolved_by = ${input.operator},
        resolution = ${input.resolution},
        updated_at = ${input.now},
        completed_at = CASE WHEN ${input.status} = 'resolved' THEN ${input.now} ELSE NULL END
      WHERE action_id = ${input.actionId}
        AND status IN ('manual', 'poison', 'unknown')
      RETURNING reactor_id AS "reactorId", source_sequence AS "sourceSequence"
    `,
  })

  const resolve: OrchestrationReactorDeliveryShape['resolve'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const updated = yield* resolveAction({
            actionId: input.actionId,
            status: input.resolution === 'retry' ? 'pending' : 'resolved',
            operator: input.operator,
            resolution: `${input.resolution}: ${input.detail}`,
            now: input.now,
          })
          if (Option.isNone(updated))
          {
            return false
          }
          yield* refreshBlockedSequence(updated.value.reactorId, input.now)
          return true
        }),
      )
      .pipe(
        Effect.mapError(toReactorDeliveryError('OrchestrationReactorDelivery.resolve:transaction')),
      )

  const skipStale: OrchestrationReactorDeliveryShape['skipStale'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const updated = yield* SqlSchema.findOneOption({
            Request: Schema.Void,
            Result: OutcomeRow,
            execute: () => sql`
              UPDATE orchestration_reactor_actions
              SET
                status = 'resolved',
                lease_owner = NULL,
                lease_expires_at = NULL,
                resolved_by = ${input.operator},
                resolution = ${`skip: ${input.detail}`},
                updated_at = ${input.now},
                completed_at = ${input.now}
              WHERE action_id = ${input.actionId}
                AND source_event_id = ${input.sourceEventId}
                AND status IN ('pending', 'leased', 'retryable', 'unknown', 'poison', 'manual')
              RETURNING reactor_id AS "reactorId", source_sequence AS "sourceSequence"
            `,
          })(undefined)
          if (Option.isNone(updated))
          {
            return false
          }
          yield* refreshBlockedSequence(updated.value.reactorId, input.now)
          return true
        }),
      )
      .pipe(
        Effect.mapError(
          toReactorDeliveryError('OrchestrationReactorDelivery.skipStale:transaction'),
        ),
      )

  const skipStaleByTarget: OrchestrationReactorDeliveryShape['skipStaleByTarget'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const updated = yield* sql<{ readonly reactorId: string }>`
            UPDATE orchestration_reactor_actions
            SET
              status = 'resolved',
              lease_owner = NULL,
              lease_expires_at = NULL,
              resolved_by = ${input.operator},
              resolution = ${`skip: ${input.detail}`},
              updated_at = ${input.now},
              completed_at = ${input.now}
            WHERE reactor_id = ${input.reactorId}
              AND target_kind = ${input.targetKind}
              AND target_id = ${input.targetId}
              AND effect_kind = ${input.effectKind}
              AND status IN ('pending', 'leased', 'retryable', 'unknown', 'poison', 'manual')
            RETURNING reactor_id AS "reactorId"
          `
          if (updated.length === 0)
          {
            return 0
          }
          yield* refreshBlockedSequence(input.reactorId, input.now)
          return updated.length
        }),
      )
      .pipe(
        Effect.mapError(
          toReactorDeliveryError('OrchestrationReactorDelivery.skipStaleByTarget:transaction'),
        ),
      )

  const updateMode = SqlSchema.findOne({
    Request: Schema.Struct({
      reactorId: Schema.String,
      mode: Schema.String,
      highWaterSequence: Schema.NullOr(Schema.Number),
      preserveHighWater: Schema.Number,
      ownerId: Schema.String,
      now: Schema.String,
    }),
    Result: ReactorProgress,
    execute: (input) => sql`
      UPDATE orchestration_reactor_progress
      SET
        cursor_sequence = CASE
          WHEN mode = 'shadow' AND ${input.mode} = 'durable' THEN shadow_cursor_sequence
          ELSE cursor_sequence
        END,
        mode = ${input.mode},
        high_water_sequence = CASE
          WHEN ${input.preserveHighWater} = 1 THEN high_water_sequence
          ELSE ${input.highWaterSequence}
        END,
        owner_epoch = CASE
          WHEN active_owner_id IS ${input.ownerId} THEN owner_epoch
          ELSE owner_epoch + 1
        END,
        active_owner_id = ${input.ownerId},
        updated_at = ${input.now}
      WHERE reactor_id = ${input.reactorId}
      RETURNING
        reactor_id AS "reactorId",
        operation_version AS "operationVersion",
        mode,
        cursor_sequence AS "cursorSequence",
        shadow_cursor_sequence AS "shadowCursorSequence",
        high_water_sequence AS "highWaterSequence",
        blocked_sequence AS "blockedSequence",
        active_owner_id AS "activeOwnerId",
        owner_epoch AS "ownerEpoch",
        last_error AS "lastError",
        updated_at AS "updatedAt"
    `,
  })

  const setMode: OrchestrationReactorDeliveryShape['setMode'] = (input) =>
    updateMode({
      reactorId: input.reactorId,
      mode: input.mode,
      highWaterSequence: input.highWaterSequence ?? null,
      preserveHighWater: input.highWaterSequence === undefined ? 1 : 0,
      ownerId: input.ownerId,
      now: input.now,
    }).pipe(Effect.mapError(toReactorDeliveryError('OrchestrationReactorDelivery.setMode:query')))

  return OrchestrationReactorDelivery.of({
    ensureProgress,
    getProgress,
    materialize,
    claimNext,
    renewLease,
    recordOutcome,
    advanceCursor,
    recoverExpiredLeases,
    resolve,
    skipStale,
    skipStaleByTarget,
    setMode,
  })
})

export const OrchestrationReactorDeliveryLive = Layer.effect(OrchestrationReactorDelivery, make)
