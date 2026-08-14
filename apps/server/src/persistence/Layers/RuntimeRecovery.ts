// apps/server/src/persistence/Layers/RuntimeRecovery.ts
// persists redacted recovery reads and atomically audited optimistic mutations

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { RuntimeRecoveryReactorAuditState } from '@t3tools/contracts'

import { toPersistenceSqlError } from '../Errors.ts'
import {
  RuntimeRecoveryPersistence,
  RuntimeRecoveryPersistenceNotFoundError,
  RuntimeRecoveryPersistenceStaleError,
  type RuntimeRecoveryAuditRow,
  type RuntimeRecoveryCheckpointRecord,
  type RuntimeRecoveryPersistenceShape,
  type RuntimeRecoveryReactorActionRecord,
} from '../Services/RuntimeRecovery.ts'

const reactorColumns = `
  action.action_id AS "actionId",
  action.reactor_id AS "reactorId",
  action.operation_version AS "operationVersion",
  action.source_sequence AS "sourceSequence",
  action.source_event_id AS "sourceEventId",
  action.output_index AS "outputIndex",
  action.effect_kind AS "effectKind",
  action.target_kind AS "targetKind",
  action.target_id AS "targetId",
  action.status,
  action.attempt_count AS "attemptCount",
  action.payload_json AS "payloadJson",
  action.outcome_json AS "outcomeJson",
  action.last_error AS "lastError",
  action.created_at AS "createdAt",
  action.updated_at AS "updatedAt",
  (
    SELECT COUNT(*)
    FROM orchestration_reactor_actions AS successor
    WHERE successor.reactor_id = action.reactor_id
      AND successor.status NOT IN ('shadow', 'succeeded', 'resolved')
      AND (
        successor.source_sequence > action.source_sequence
        OR (
          successor.source_sequence = action.source_sequence
          AND successor.output_index > action.output_index
        )
      )
      AND NOT (
        successor.effect_kind = 'thread.provider.switch.compensate'
        AND successor.source_sequence = action.source_sequence
      )
  ) AS "materializedBlockedActionCount"
`

const checkpointColumns = `
  operation_id AS "operationId",
  thread_id AS "threadId",
  target_ref AS "targetRef",
  target_turn_count AS "targetTurnCount",
  phase,
  attempt_count AS "attemptCount",
  last_error AS "lastError",
  provider_outcome AS "providerOutcome",
  manual_resume_phase AS "manualResumePhase",
  CASE
    WHEN checkpoint_capture_root IS NULL THEN 'missing'
    ELSE 'present'
  END AS "checkpointCaptureRoot",
  CASE
    WHEN repository_common_dir IS NULL THEN 'missing'
    ELSE 'present'
  END AS "repositoryCommonDir",
  CASE
    WHEN checkpoint_commit_oid IS NULL THEN 'missing'
    ELSE 'present'
  END AS "checkpointCommitOid",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const auditColumns = `
  audit_id AS "auditId",
  subject_kind AS "subjectKind",
  subject_id AS "subjectId",
  reactor_id AS "reactorId",
  operation_version AS "operationVersion",
  actor_session_id AS "actorSessionId",
  actor_subject AS "actorSubject",
  effect_kind AS "effectKind",
  recovery_action AS "action",
  before_state_json AS "beforeStateJson",
  after_state_json AS "afterStateJson",
  reason,
  created_at AS "createdAt"
`

const isRecoveryPersistenceMutationError = Schema.is(
  Schema.Union([RuntimeRecoveryPersistenceNotFoundError, RuntimeRecoveryPersistenceStaleError]),
)

const firstOption = <A>(rows: ReadonlyArray<A>): Option.Option<A> =>
  rows[0] === undefined ? Option.none<A>() : Option.some(rows[0])

const encodeReactorAuditState = Schema.encodeSync(
  Schema.fromJsonString(RuntimeRecoveryReactorAuditState),
)

const mapMutationError = (operation: string) => (cause: unknown) =>
  isRecoveryPersistenceMutationError(cause) ? cause : toPersistenceSqlError(operation)(cause)

const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const readReactorAction = (actionId: string) =>
    sql
      .unsafe<RuntimeRecoveryReactorActionRecord>(
        `
        SELECT ${reactorColumns}
        FROM orchestration_reactor_actions AS action
        WHERE action.action_id = ?
      `,
        [actionId],
      )
      .pipe(Effect.map(firstOption))

  const listBlockedReactorActions: RuntimeRecoveryPersistenceShape['listBlockedReactorActions'] = (
    input,
  ) =>
  {
    const cursorClause =
      input.cursor === undefined
        ? ''
        : `AND (
            action.updated_at,
            action.reactor_id,
            action.source_sequence,
            action.output_index,
            action.action_id
          ) > (?, ?, ?, ?, ?)`
    const params =
      input.cursor === undefined
        ? [input.limit]
        : [
            input.cursor.updatedAt,
            input.cursor.reactorId,
            input.cursor.sourceSequence,
            input.cursor.outputIndex,
            input.cursor.actionId,
            input.limit,
          ]
    return sql
      .unsafe<RuntimeRecoveryReactorActionRecord>(
        `
          SELECT ${reactorColumns}
          FROM orchestration_reactor_actions AS action
          WHERE action.status IN ('unknown', 'poison', 'manual')
          ${cursorClause}
          ORDER BY
            action.updated_at,
            action.reactor_id,
            action.source_sequence,
            action.output_index,
            action.action_id
          LIMIT ?
        `,
        params,
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError('RuntimeRecoveryPersistence.listBlockedReactorActions'),
        ),
      )
  }

  const getBlockedReactorAction: RuntimeRecoveryPersistenceShape['getBlockedReactorAction'] = (
    actionId,
  ) =>
    readReactorAction(actionId).pipe(
      Effect.map(Option.filter((row) => ['unknown', 'poison', 'manual'].includes(row.status))),
      Effect.mapError(toPersistenceSqlError('RuntimeRecoveryPersistence.getBlockedReactorAction')),
    )

  const getReactorAction: RuntimeRecoveryPersistenceShape['getReactorAction'] = (actionId) =>
    readReactorAction(actionId).pipe(
      Effect.mapError(toPersistenceSqlError('RuntimeRecoveryPersistence.getReactorAction')),
    )

  const recoverReactorAction: RuntimeRecoveryPersistenceShape['recoverReactorAction'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const current = yield* readReactorAction(input.actionId)
          if (Option.isNone(current))
          {
            return yield* new RuntimeRecoveryPersistenceNotFoundError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
            })
          }
          if (current.value.effectKind !== input.expectedEffectKind)
          {
            return yield* new RuntimeRecoveryPersistenceStaleError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
              reason: 'effect-changed',
            })
          }
          if (current.value.reactorId !== input.expectedReactorId)
          {
            return yield* new RuntimeRecoveryPersistenceStaleError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
              reason: 'reactor-changed',
            })
          }
          if (current.value.operationVersion !== input.expectedOperationVersion)
          {
            return yield* new RuntimeRecoveryPersistenceStaleError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
              reason: 'operation-version-changed',
            })
          }
          if (current.value.status !== input.expectedStatus)
          {
            return yield* new RuntimeRecoveryPersistenceStaleError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
              reason: 'state-changed',
            })
          }
          if (current.value.updatedAt !== input.expectedUpdatedAt)
          {
            return yield* new RuntimeRecoveryPersistenceStaleError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
              reason: 'timestamp-changed',
            })
          }

          const changed = yield* sql.unsafe<{ readonly actionId: string }>(
            `
              UPDATE orchestration_reactor_actions AS action
              SET
                status = 'pending',
                available_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                resolved_by = ?,
                resolution = ?,
                updated_at = ?,
                completed_at = NULL
              WHERE action_id = ?
                AND reactor_id = ?
                AND effect_kind = ?
                AND operation_version = ?
                AND status = ?
                AND updated_at = ?
              RETURNING action_id AS "actionId"
            `,
            [
              input.now,
              `${input.actor.subject} (${input.actor.sessionId})`,
              `${input.action}: ${input.reason}`,
              input.now,
              input.actionId,
              input.expectedReactorId,
              input.expectedEffectKind,
              input.expectedOperationVersion,
              input.expectedStatus,
              input.expectedUpdatedAt,
            ],
          )
          if (changed[0] === undefined)
          {
            return yield* new RuntimeRecoveryPersistenceStaleError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
              reason: 'state-changed',
            })
          }
          const updatedOption = yield* readReactorAction(input.actionId)
          if (Option.isNone(updatedOption))
          {
            return yield* new RuntimeRecoveryPersistenceStaleError({
              subjectKind: 'reactor-action',
              subjectId: input.actionId,
              reason: 'state-changed',
            })
          }
          const updated = updatedOption.value

          yield* sql`
            UPDATE orchestration_reactor_progress
            SET
              blocked_sequence = (
                SELECT MIN(source_sequence)
                FROM orchestration_reactor_actions
                WHERE reactor_id = ${updated.reactorId}
                  AND status IN ('unknown', 'poison', 'manual')
              ),
              last_error = NULL,
              updated_at = ${input.now}
            WHERE reactor_id = ${updated.reactorId}
          `

          yield* sql`
            INSERT INTO runtime_recovery_audit (
              audit_id,
              subject_kind,
              subject_id,
              reactor_id,
              operation_version,
              actor_session_id,
              actor_subject,
              effect_kind,
              recovery_action,
              before_state_json,
              after_state_json,
              reason,
              created_at
            )
            VALUES (
              ${input.auditId},
              'reactor-action',
              ${input.actionId},
              ${input.expectedReactorId},
              ${input.expectedOperationVersion},
              ${input.actor.sessionId},
              ${input.actor.subject},
              ${input.expectedEffectKind},
              ${input.action},
              ${encodeReactorAuditState({
                kind: 'reactor-action',
                status: current.value.status,
                updatedAt: current.value.updatedAt,
              })},
              ${encodeReactorAuditState({
                kind: 'reactor-action',
                status: updated.status,
                updatedAt: updated.updatedAt,
              })},
              ${input.reason},
              ${input.now}
            )
          `

          return updated
        }),
      )
      .pipe(
        Effect.mapError(
          mapMutationError('RuntimeRecoveryPersistence.recoverReactorAction:transaction'),
        ),
      )

  const readCheckpointRevert = (operationId: string) =>
    sql
      .unsafe<RuntimeRecoveryCheckpointRecord>(
        `
          SELECT ${checkpointColumns}
          FROM checkpoint_revert_operations
          WHERE operation_id = ?
        `,
        [operationId],
      )
      .pipe(Effect.map(firstOption))

  const listManualCheckpointReverts: RuntimeRecoveryPersistenceShape['listManualCheckpointReverts'] =
    (input) =>
    {
      const cursorClause =
        input.cursor === undefined ? '' : 'AND (updated_at, operation_id) > (?, ?)'
      const params =
        input.cursor === undefined
          ? [input.limit]
          : [input.cursor.updatedAt, input.cursor.operationId, input.limit]
      return sql
        .unsafe<RuntimeRecoveryCheckpointRecord>(
          `
            SELECT ${checkpointColumns}
            FROM checkpoint_revert_operations
            WHERE phase IN ('requested', 'manual-required')
            ${cursorClause}
            ORDER BY updated_at, operation_id
            LIMIT ?
          `,
          params,
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError('RuntimeRecoveryPersistence.listManualCheckpointReverts'),
          ),
        )
    }

  const getManualCheckpointRevert: RuntimeRecoveryPersistenceShape['getManualCheckpointRevert'] = (
    operationId,
  ) =>
    readCheckpointRevert(operationId).pipe(
      Effect.map(
        Option.filter((row) => row.phase === 'requested' || row.phase === 'manual-required'),
      ),
      Effect.mapError(
        toPersistenceSqlError('RuntimeRecoveryPersistence.getManualCheckpointRevert'),
      ),
    )

  const listAudit: RuntimeRecoveryPersistenceShape['listAudit'] = (input) =>
    sql
      .unsafe<RuntimeRecoveryAuditRow>(
        `
          SELECT ${auditColumns}
          FROM runtime_recovery_audit
          WHERE subject_kind = ? AND subject_id = ?
          ORDER BY created_at DESC, audit_id DESC
          LIMIT ?
        `,
        [input.subjectKind, input.subjectId, input.limit],
      )
      .pipe(Effect.mapError(toPersistenceSqlError('RuntimeRecoveryPersistence.listAudit')))

  return RuntimeRecoveryPersistence.of({
    listBlockedReactorActions,
    getReactorAction,
    getBlockedReactorAction,
    recoverReactorAction,
    listManualCheckpointReverts,
    getManualCheckpointRevert,
    listAudit,
  })
})

export const RuntimeRecoveryPersistenceLive = Layer.effect(RuntimeRecoveryPersistence, make)
