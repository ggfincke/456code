// apps/server/src/persistence/Layers/CheckpointRevertOperations.ts
// persists checkpoint revert operations and enforces their state machine

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import { toPersistenceSqlError } from '../Errors.ts'
import {
  AdmitCheckpointRevertInput,
  CheckpointRevertOperation,
  CheckpointRevertOperationConflictError,
  CheckpointRevertOperations,
  type CheckpointRevertOperationsShape,
  type CheckpointRevertPhase,
  CheckpointRevertLookupInput,
  CheckpointRevertSequenceLookupInput,
  CheckpointRevertTransitionError,
  ReserveCheckpointRevertInput,
} from '../Services/CheckpointRevertOperations.ts'

const operationColumns = `
  operation_id AS "operationId",
  thread_id AS "threadId",
  target_ref AS "targetRef",
  target_turn_count AS "targetTurnCount",
  request_source_sequence AS "requestSourceSequence",
  provider_inbox_high_water AS "providerInboxHighWater",
  target_tree AS "targetTree",
  cwd,
  checkpoint_capture_root AS "checkpointCaptureRoot",
  repository_common_dir AS "repositoryCommonDir",
  checkpoint_commit_oid AS "checkpointCommitOid",
  stage_path AS "stagePath",
  phase,
  attempt_count AS "attemptCount",
  last_error AS "lastError",
  provider_kind AS "provider",
  provider_instance_id AS "providerInstanceId",
  provider_session_id AS "providerSessionId",
  provider_thread_id AS "providerThreadId",
  provider_session_generation AS "providerSessionGeneration",
  provider_outcome AS "providerOutcome",
  provider_outcome_json AS "providerOutcomeJson",
  projection_status AS "projectionStatus",
  stale_refs_json AS "staleRefsJson",
  cleanup_status AS "cleanupStatus",
  manual_resume_phase AS "manualResumePhase",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const forwardPhases: ReadonlyArray<CheckpointRevertPhase> = [
  'requested',
  'admitted',
  'target-staged',
  'restore-ready',
  'provider-pending',
  'provider-outcome-recorded',
  'restore-started',
  'filesystem-restored',
  'projection-finalized',
  'cleanup-pending',
  'completed',
]

const isCheckpointRevertOperationsError = Schema.is(
  Schema.Union([CheckpointRevertOperationConflictError, CheckpointRevertTransitionError]),
)

function transitionReason(
  operation: CheckpointRevertOperation,
  expectedPhase: CheckpointRevertPhase,
  nextPhase: CheckpointRevertPhase,
): 'phase-mismatch' | 'illegal-edge' | 'resume-mismatch' | null
{
  if (operation.phase !== expectedPhase) return 'phase-mismatch'
  if (expectedPhase === nextPhase) return null

  if (expectedPhase === 'manual-required')
  {
    return operation.manualResumePhase === nextPhase ? null : 'resume-mismatch'
  }

  const expectedIndex = forwardPhases.indexOf(expectedPhase)
  if (expectedIndex >= 0 && forwardPhases[expectedIndex + 1] === nextPhase) return null
  if (expectedIndex >= 0 && expectedIndex <= 3 && nextPhase === 'aborted') return null
  if (expectedIndex >= 0 && expectedPhase !== 'completed' && nextPhase === 'manual-required')
  {
    return null
  }
  return 'illegal-edge'
}

const makeCheckpointRevertOperations = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  const findById = SqlSchema.findOneOption({
    Request: CheckpointRevertLookupInput,
    Result: CheckpointRevertOperation,
    execute: ({ id }) =>
      sql.unsafe(
        `SELECT ${operationColumns} FROM checkpoint_revert_operations WHERE operation_id = ?`,
        [id],
      ),
  })

  const findActiveByThread = SqlSchema.findOneOption({
    Request: CheckpointRevertLookupInput,
    Result: CheckpointRevertOperation,
    execute: ({ id }) =>
      sql.unsafe(
        `SELECT ${operationColumns}
         FROM checkpoint_revert_operations
         WHERE thread_id = ? AND phase NOT IN ('completed', 'aborted')`,
        [id],
      ),
  })

  const findRequestedBySourceSequence = SqlSchema.findOneOption({
    Request: CheckpointRevertSequenceLookupInput,
    Result: CheckpointRevertOperation,
    execute: ({ sequence }) =>
      sql.unsafe(
        `SELECT ${operationColumns}
         FROM checkpoint_revert_operations
         WHERE request_source_sequence = ? AND phase = 'requested'
         ORDER BY operation_id
         LIMIT 1`,
        [sequence],
      ),
  })

  const listResumableRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CheckpointRevertOperation,
    execute: () =>
      sql.unsafe(
        `SELECT ${operationColumns}
         FROM checkpoint_revert_operations
         WHERE phase NOT IN ('completed', 'aborted')
         ORDER BY created_at, operation_id`,
      ),
  })

  const insertReservedOperation = SqlSchema.findOneOption({
    Request: ReserveCheckpointRevertInput,
    Result: CheckpointRevertOperation,
    execute: (input) =>
      sql.unsafe(
        `
          INSERT INTO checkpoint_revert_operations (
            operation_id,
            thread_id,
            target_ref,
            target_turn_count,
            request_source_sequence,
            provider_inbox_high_water,
            phase,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)
          ON CONFLICT DO NOTHING
          RETURNING ${operationColumns}
        `,
        [
          input.operationId,
          input.threadId,
          input.targetRef,
          input.targetTurnCount,
          input.requestSourceSequence,
          input.providerInboxHighWater,
          input.now,
          input.now,
        ],
      ),
  })

  const insertOperation = SqlSchema.findOneOption({
    Request: AdmitCheckpointRevertInput,
    Result: CheckpointRevertOperation,
    execute: (input) =>
      sql.unsafe(
        `
          INSERT INTO checkpoint_revert_operations (
            operation_id,
            thread_id,
            target_ref,
            target_turn_count,
            request_source_sequence,
            provider_inbox_high_water,
            cwd,
            checkpoint_capture_root,
            repository_common_dir,
            checkpoint_commit_oid,
            provider_kind,
            provider_instance_id,
            provider_session_id,
            provider_thread_id,
            provider_session_generation,
            phase,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)
          ON CONFLICT DO NOTHING
          RETURNING ${operationColumns}
        `,
        [
          input.operationId,
          input.threadId,
          input.targetRef,
          input.targetTurnCount,
          input.requestSourceSequence,
          input.providerInboxHighWater,
          input.cwd,
          input.checkpointCaptureRoot,
          input.repositoryCommonDir,
          input.checkpointCommitOid,
          input.providerIdentity.provider,
          input.providerIdentity.providerInstanceId,
          input.providerSessionId,
          input.providerIdentity.threadId,
          input.providerIdentity.sessionGeneration,
          input.now,
          input.now,
        ],
      ),
  })

  const getById: CheckpointRevertOperationsShape['getById'] = (operationId) =>
    findById({ id: operationId }).pipe(
      Effect.mapError(toPersistenceSqlError('CheckpointRevertOperations.getById:query')),
    )

  const getActiveByThread: CheckpointRevertOperationsShape['getActiveByThread'] = (threadId) =>
    findActiveByThread({ id: threadId }).pipe(
      Effect.mapError(toPersistenceSqlError('CheckpointRevertOperations.getActiveByThread:query')),
    )

  const getRequestedBySourceSequence: CheckpointRevertOperationsShape['getRequestedBySourceSequence'] =
    (sourceSequence) =>
      findRequestedBySourceSequence({ sequence: sourceSequence }).pipe(
        Effect.mapError(
          toPersistenceSqlError('CheckpointRevertOperations.getRequestedBySourceSequence:query'),
        ),
      )

  const reserve: CheckpointRevertOperationsShape['reserve'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const inserted = yield* insertReservedOperation(input)
          if (Option.isSome(inserted)) return inserted.value

          const sameOperation = yield* findById({ id: input.operationId })
          if (
            Option.isSome(sameOperation) &&
            sameOperation.value.threadId === input.threadId &&
            sameOperation.value.targetRef === input.targetRef &&
            sameOperation.value.targetTurnCount === input.targetTurnCount &&
            sameOperation.value.requestSourceSequence === input.requestSourceSequence &&
            sameOperation.value.providerInboxHighWater === input.providerInboxHighWater
          )
          {
            return sameOperation.value
          }

          const active = yield* findActiveByThread({ id: input.threadId })
          return yield* new CheckpointRevertOperationConflictError({
            operationId: input.operationId,
            threadId: input.threadId,
            activeOperationId: Option.isSome(active) ? active.value.operationId : input.operationId,
            activePhase: Option.isSome(active) ? active.value.phase : 'requested',
          })
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isCheckpointRevertOperationsError(cause)
            ? cause
            : toPersistenceSqlError('CheckpointRevertOperations.reserve:transaction')(cause),
        ),
      )

  const admit: CheckpointRevertOperationsShape['admit'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const reserved = yield* findById({ id: input.operationId })
          if (Option.isSome(reserved))
          {
            if (reserved.value.phase !== 'requested') return reserved.value
            if (
              reserved.value.threadId !== input.threadId ||
              reserved.value.targetRef !== input.targetRef ||
              reserved.value.targetTurnCount !== input.targetTurnCount ||
              reserved.value.requestSourceSequence !== input.requestSourceSequence ||
              reserved.value.providerInboxHighWater !== input.providerInboxHighWater
            )
            {
              return yield* new CheckpointRevertOperationConflictError({
                operationId: input.operationId,
                threadId: input.threadId,
                activeOperationId: reserved.value.operationId,
                activePhase: reserved.value.phase,
              })
            }
            const promoted = yield* sql.unsafe<CheckpointRevertOperation>(
              `
                UPDATE checkpoint_revert_operations
                SET
                  cwd = ?,
                  checkpoint_capture_root = ?,
                  repository_common_dir = ?,
                  checkpoint_commit_oid = ?,
                  provider_kind = ?,
                  provider_instance_id = ?,
                  provider_session_id = ?,
                  provider_thread_id = ?,
                  provider_session_generation = ?,
                  phase = 'admitted',
                  last_error = NULL,
                  updated_at = ?
                WHERE operation_id = ? AND phase = 'requested'
                RETURNING ${operationColumns}
              `,
              [
                input.cwd,
                input.checkpointCaptureRoot,
                input.repositoryCommonDir,
                input.checkpointCommitOid,
                input.providerIdentity.provider,
                input.providerIdentity.providerInstanceId,
                input.providerSessionId,
                input.providerIdentity.threadId,
                input.providerIdentity.sessionGeneration,
                input.now,
                input.operationId,
              ],
            )
            if (promoted[0] !== undefined)
            {
              return yield* Schema.decodeUnknownEffect(CheckpointRevertOperation)(promoted[0])
            }
          }

          const inserted = yield* insertOperation(input)
          if (Option.isSome(inserted)) return inserted.value

          const sameOperation = yield* findById({ id: input.operationId })
          if (Option.isSome(sameOperation)) return sameOperation.value

          const active = yield* findActiveByThread({ id: input.threadId })
          if (Option.isSome(active))
          {
            return yield* new CheckpointRevertOperationConflictError({
              operationId: input.operationId,
              threadId: input.threadId,
              activeOperationId: active.value.operationId,
              activePhase: active.value.phase,
            })
          }

          return yield* new CheckpointRevertOperationConflictError({
            operationId: input.operationId,
            threadId: input.threadId,
            activeOperationId: input.operationId,
            activePhase: 'admitted',
          })
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isCheckpointRevertOperationsError(cause)
            ? cause
            : toPersistenceSqlError('CheckpointRevertOperations.admit:transaction')(cause),
        ),
      )

  const casTransition: CheckpointRevertOperationsShape['casTransition'] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* ()
        {
          const current = yield* findById({ id: input.operationId })
          if (Option.isNone(current))
          {
            return yield* new CheckpointRevertTransitionError({
              operationId: input.operationId,
              expectedPhase: input.expectedPhase,
              nextPhase: input.nextPhase,
              actualPhase: null,
              reason: 'not-found',
            })
          }

          const reason = transitionReason(current.value, input.expectedPhase, input.nextPhase)
          if (reason !== null)
          {
            return yield* new CheckpointRevertTransitionError({
              operationId: input.operationId,
              expectedPhase: input.expectedPhase,
              nextPhase: input.nextPhase,
              actualPhase: current.value.phase,
              reason,
            })
          }

          const patch = input.patch ?? {}
          // a same-phase retry never re-derives the resume target: entering
          // manual-required again from itself would record 'manual-required'
          // as its own resume phase, which the column's CHECK rejects
          const manualResumePhase =
            input.expectedPhase === input.nextPhase
              ? current.value.manualResumePhase
              : input.nextPhase === 'manual-required'
                ? forwardPhases.indexOf(input.expectedPhase) <= 3
                  ? null
                  : input.expectedPhase
                : input.expectedPhase === 'manual-required'
                  ? null
                  : current.value.manualResumePhase
          const rows = yield* sql.unsafe<CheckpointRevertOperation>(
            `
              UPDATE checkpoint_revert_operations
              SET
                phase = ?,
                attempt_count = attempt_count + ?,
                target_tree = ?,
                repository_common_dir = ?,
                stage_path = ?,
                last_error = ?,
                provider_session_id = ?,
                provider_outcome = ?,
                provider_outcome_json = ?,
                projection_status = ?,
                stale_refs_json = ?,
                cleanup_status = ?,
                manual_resume_phase = ?,
                updated_at = ?
              WHERE operation_id = ?
                AND phase = ?
              RETURNING ${operationColumns}
            `,
            [
              input.nextPhase,
              input.expectedPhase === input.nextPhase ? 1 : 0,
              patch.targetTree === undefined ? current.value.targetTree : patch.targetTree,
              patch.repositoryCommonDir === undefined
                ? current.value.repositoryCommonDir
                : patch.repositoryCommonDir,
              patch.stagePath === undefined ? current.value.stagePath : patch.stagePath,
              patch.lastError === undefined ? current.value.lastError : patch.lastError,
              patch.providerSessionId === undefined
                ? current.value.providerSessionId
                : patch.providerSessionId,
              patch.providerOutcome === undefined
                ? current.value.providerOutcome
                : patch.providerOutcome,
              patch.providerOutcomeJson === undefined
                ? current.value.providerOutcomeJson
                : patch.providerOutcomeJson,
              patch.projectionStatus === undefined
                ? current.value.projectionStatus
                : patch.projectionStatus,
              patch.staleRefsJson === undefined ? current.value.staleRefsJson : patch.staleRefsJson,
              patch.cleanupStatus === undefined ? current.value.cleanupStatus : patch.cleanupStatus,
              manualResumePhase,
              input.now,
              input.operationId,
              input.expectedPhase,
            ],
          )
          const updated = rows[0]
          if (updated === undefined)
          {
            const raced = yield* findById({ id: input.operationId })
            return yield* new CheckpointRevertTransitionError({
              operationId: input.operationId,
              expectedPhase: input.expectedPhase,
              nextPhase: input.nextPhase,
              actualPhase: Option.isSome(raced) ? raced.value.phase : null,
              reason: Option.isSome(raced) ? 'phase-mismatch' : 'not-found',
            })
          }
          return yield* Schema.decodeUnknownEffect(CheckpointRevertOperation)(updated)
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isCheckpointRevertOperationsError(cause)
            ? cause
            : toPersistenceSqlError('CheckpointRevertOperations.casTransition:transaction')(cause),
        ),
      )

  const listResumable: CheckpointRevertOperationsShape['listResumable'] = () =>
    listResumableRows(undefined).pipe(
      Effect.map((operations) =>
        operations.map((operation) => ({
          ...operation,
          manualRequired: operation.phase === 'manual-required',
        })),
      ),
      Effect.mapError(toPersistenceSqlError('CheckpointRevertOperations.listResumable:query')),
    )

  const recordProviderOutcome: CheckpointRevertOperationsShape['recordProviderOutcome'] = (input) =>
    casTransition({
      operationId: input.operationId,
      expectedPhase: 'provider-pending',
      nextPhase: 'provider-outcome-recorded',
      patch: {
        providerOutcome: input.outcome,
        providerOutcomeJson: input.outcomeJson,
        providerSessionId: input.providerSessionId,
        lastError: null,
      },
      now: input.now,
    })

  const recordStaleRefs: CheckpointRevertOperationsShape['recordStaleRefs'] = (input) =>
    casTransition({
      operationId: input.operationId,
      expectedPhase: 'projection-finalized',
      nextPhase: 'cleanup-pending',
      patch: {
        staleRefsJson: JSON.stringify(input.staleRefs),
        cleanupStatus: 'pending',
      },
      now: input.now,
    })

  const markManual: CheckpointRevertOperationsShape['markManual'] = (input) =>
    casTransition({
      operationId: input.operationId,
      expectedPhase: input.expectedPhase,
      nextPhase: 'manual-required',
      patch: { lastError: input.error },
      now: input.now,
    })

  return CheckpointRevertOperations.of({
    reserve,
    admit,
    getActiveByThread,
    getById,
    getRequestedBySourceSequence,
    casTransition,
    listResumable,
    recordProviderOutcome,
    recordStaleRefs,
    markManual,
  })
})

export const CheckpointRevertOperationsLive = Layer.effect(
  CheckpointRevertOperations,
  makeCheckpointRevertOperations,
)
