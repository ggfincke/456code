// apps/server/src/recovery/RuntimeRecoveryAdmin.ts
// serves redacted recovery diagnostics and owner-authorized audited retries

import * as NodeCrypto from 'node:crypto'

import {
  NonNegativeInt,
  RuntimeRecoveryAuditState,
  RuntimeRecoveryPageCursor,
  TrimmedNonEmptyString,
  type RuntimeRecoveryAuditRecord,
  type RuntimeRecoveryCheckpointDetail,
  type RuntimeRecoveryCheckpointDiagnostic,
  type RuntimeRecoveryCheckpointListResult,
  type RuntimeRecoveryReactorDetail,
  type RuntimeRecoveryReactorDiagnostic,
  type RuntimeRecoveryReactorListResult,
  type RuntimeRecoveryReactorMutation,
  type RuntimeRecoverySubjectKind,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import {
  RuntimeRecoveryPersistence,
  type RuntimeRecoveryActor,
  type RuntimeRecoveryAuditRow,
  type RuntimeRecoveryCheckpointRecord,
  type RuntimeRecoveryCheckpointPageCursor,
  type RuntimeRecoveryReactorActionRecord,
  type RuntimeRecoveryReactorPageCursor,
} from '../persistence/Services/RuntimeRecovery.ts'
import {
  RuntimeRecoveryPolicyRegistry,
  type RuntimeRecoveryEffectPolicyView,
  type RuntimeRecoveryPolicyDeniedError,
} from './RuntimeRecoveryPolicy.ts'

const MAX_LIST_ITEMS = 100
const MAX_AUDIT_ITEMS = 100

const RuntimeRecoveryReactorCursorEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  listKind: Schema.Literal('reactor-actions'),
  updatedAt: TrimmedNonEmptyString,
  reactorId: TrimmedNonEmptyString,
  sourceSequence: NonNegativeInt,
  outputIndex: NonNegativeInt,
  actionId: TrimmedNonEmptyString,
})

const RuntimeRecoveryCheckpointCursorEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  listKind: Schema.Literal('checkpoint-reverts'),
  updatedAt: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
})

const decodeReactorCursorEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeRecoveryReactorCursorEnvelope),
)
const decodeCheckpointCursorEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeRecoveryCheckpointCursorEnvelope),
)

export class RuntimeRecoveryAdminNotFoundError extends Schema.TaggedErrorClass<RuntimeRecoveryAdminNotFoundError>()(
  'RuntimeRecoveryAdminNotFoundError',
  {
    subjectKind: Schema.Literals(['reactor-action', 'checkpoint-revert']),
    subjectId: Schema.String,
  },
)
{}

export class RuntimeRecoveryAdminStaleError extends Schema.TaggedErrorClass<RuntimeRecoveryAdminStaleError>()(
  'RuntimeRecoveryAdminStaleError',
  {
    subjectKind: Schema.Literals(['reactor-action', 'checkpoint-revert']),
    subjectId: Schema.String,
  },
)
{}

export class RuntimeRecoveryAdminInvalidCursorError extends Schema.TaggedErrorClass<RuntimeRecoveryAdminInvalidCursorError>()(
  'RuntimeRecoveryAdminInvalidCursorError',
  {
    listKind: Schema.Literals(['reactor-actions', 'checkpoint-reverts']),
  },
)
{}

export class RuntimeRecoveryAdminInternalError extends Schema.TaggedErrorClass<RuntimeRecoveryAdminInternalError>()(
  'RuntimeRecoveryAdminInternalError',
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{}

export type RuntimeRecoveryAdminReadError =
  RuntimeRecoveryAdminNotFoundError | RuntimeRecoveryAdminInternalError

export type RuntimeRecoveryAdminMutationError =
  RuntimeRecoveryAdminReadError | RuntimeRecoveryAdminStaleError | RuntimeRecoveryPolicyDeniedError

export interface RuntimeRecoveryAdminShape
{
  readonly listReactorActions: (input?: {
    readonly cursor?: RuntimeRecoveryPageCursor
  }) => Effect.Effect<
    RuntimeRecoveryReactorListResult,
    RuntimeRecoveryAdminInvalidCursorError | RuntimeRecoveryAdminInternalError
  >
  readonly getReactorAction: (
    actionId: string,
  ) => Effect.Effect<RuntimeRecoveryReactorDetail, RuntimeRecoveryAdminReadError>
  readonly recoverReactorAction: (input: {
    readonly actionId: string
    readonly mutation: RuntimeRecoveryReactorMutation
    readonly actor: RuntimeRecoveryActor
  }) => Effect.Effect<RuntimeRecoveryReactorDetail, RuntimeRecoveryAdminMutationError>
  readonly listCheckpointReverts: (input?: {
    readonly cursor?: RuntimeRecoveryPageCursor
  }) => Effect.Effect<
    RuntimeRecoveryCheckpointListResult,
    RuntimeRecoveryAdminInvalidCursorError | RuntimeRecoveryAdminInternalError
  >
  readonly getCheckpointRevert: (
    operationId: string,
  ) => Effect.Effect<RuntimeRecoveryCheckpointDetail, RuntimeRecoveryAdminReadError>
}

export class RuntimeRecoveryAdmin extends Context.Service<
  RuntimeRecoveryAdmin,
  RuntimeRecoveryAdminShape
>()('456code/recovery/RuntimeRecoveryAdmin')
{}

const digest = (value: string): string =>
  `sha256:${NodeCrypto.createHash('sha256').update(value).digest('hex')}`

const digestNullable = (value: string | null): string | null =>
  value === null ? null : digest(value)

const invalidCursor = (listKind: 'reactor-actions' | 'checkpoint-reverts') =>
  new RuntimeRecoveryAdminInvalidCursorError({ listKind })

const decodeCursorText = (
  cursor: RuntimeRecoveryPageCursor,
  listKind: 'reactor-actions' | 'checkpoint-reverts',
): Effect.Effect<string, RuntimeRecoveryAdminInvalidCursorError> =>
  Effect.try({
    try: () => Buffer.from(cursor, 'base64url').toString('utf8'),
    catch: () => invalidCursor(listKind),
  })

const decodeReactorCursor = Effect.fn('RuntimeRecoveryAdmin.decodeReactorCursor')(function* (
  cursor: RuntimeRecoveryPageCursor,
): Effect.fn.Return<RuntimeRecoveryReactorPageCursor, RuntimeRecoveryAdminInvalidCursorError>
{
  const text = yield* decodeCursorText(cursor, 'reactor-actions')
  const envelope = yield* decodeReactorCursorEnvelope(text).pipe(
    Effect.mapError(() => invalidCursor('reactor-actions')),
  )
  return {
    updatedAt: envelope.updatedAt,
    reactorId: envelope.reactorId,
    sourceSequence: envelope.sourceSequence,
    outputIndex: envelope.outputIndex,
    actionId: envelope.actionId,
  }
})

const decodeCheckpointCursor = Effect.fn('RuntimeRecoveryAdmin.decodeCheckpointCursor')(function* (
  cursor: RuntimeRecoveryPageCursor,
): Effect.fn.Return<RuntimeRecoveryCheckpointPageCursor, RuntimeRecoveryAdminInvalidCursorError>
{
  const text = yield* decodeCursorText(cursor, 'checkpoint-reverts')
  const envelope = yield* decodeCheckpointCursorEnvelope(text).pipe(
    Effect.mapError(() => invalidCursor('checkpoint-reverts')),
  )
  return {
    updatedAt: envelope.updatedAt,
    operationId: envelope.operationId,
  }
})

const encodeReactorCursor = (row: RuntimeRecoveryReactorActionRecord): RuntimeRecoveryPageCursor =>
  RuntimeRecoveryPageCursor.make(
    Buffer.from(
      JSON.stringify({
        version: 1,
        listKind: 'reactor-actions',
        updatedAt: row.updatedAt,
        reactorId: row.reactorId,
        sourceSequence: row.sourceSequence,
        outputIndex: row.outputIndex,
        actionId: row.actionId,
      } satisfies typeof RuntimeRecoveryReactorCursorEnvelope.Type),
      'utf8',
    ).toString('base64url'),
  )

const encodeCheckpointCursor = (row: RuntimeRecoveryCheckpointRecord): RuntimeRecoveryPageCursor =>
  RuntimeRecoveryPageCursor.make(
    Buffer.from(
      JSON.stringify({
        version: 1,
        listKind: 'checkpoint-reverts',
        updatedAt: row.updatedAt,
        operationId: row.operationId,
      } satisfies typeof RuntimeRecoveryCheckpointCursorEnvelope.Type),
      'utf8',
    ).toString('base64url'),
  )

const decodeAuditState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeRecoveryAuditState),
)

const isBlockedStatus = (
  status: RuntimeRecoveryReactorActionRecord['status'],
): status is 'unknown' | 'poison' | 'manual' =>
  status === 'unknown' || status === 'poison' || status === 'manual'

const toInternalError = (operation: string) => (cause: unknown) =>
  new RuntimeRecoveryAdminInternalError({ operation, cause })

const make = Effect.gen(function* ()
{
  const persistence = yield* RuntimeRecoveryPersistence
  const policyRegistry = yield* RuntimeRecoveryPolicyRegistry

  const policyFor = (
    action: RuntimeRecoveryReactorActionRecord,
    hasRecoveryAudit: boolean,
  ): RuntimeRecoveryEffectPolicyView =>
  {
    if (isBlockedStatus(action.status))
    {
      return policyRegistry.describe({
        reactorId: action.reactorId,
        effectKind: action.effectKind,
        operationVersion: action.operationVersion,
        status: action.status,
      })
    }
    if (hasRecoveryAudit)
    {
      return {
        owner: 'completed-recovery-transition',
        summary: 'An audited retry was accepted and returned to the normal owner queue.',
        blastRadiusSummary:
          'The owner revalidates current state before executing the effect; no operator success was asserted.',
        allowedActions: [],
      }
    }
    return {
      owner: action.reactorId,
      summary: 'This action is not blocked and has no runtime-recovery audit history.',
      blastRadiusSummary: 'No operator recovery action is available for this action state.',
      allowedActions: [],
    }
  }

  const toReactorDiagnostic = (
    action: RuntimeRecoveryReactorActionRecord,
    hasRecoveryAudit = false,
  ): RuntimeRecoveryReactorDiagnostic =>
  {
    const policy = policyFor(action, hasRecoveryAudit)
    return {
      actionId: action.actionId,
      reactorId: action.reactorId,
      operationVersion: action.operationVersion,
      sourceSequence: action.sourceSequence,
      effectKind: action.effectKind,
      targetKind: action.targetKind,
      targetId: action.targetId,
      status: action.status,
      attemptCount: action.attemptCount,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      summary: `${policy.summary} Owner: ${policy.owner}.`,
      payloadDigest: digest(action.payloadJson),
      outcomeDigest: digestNullable(action.outcomeJson),
      errorDigest: digestNullable(action.lastError),
      blastRadius: {
        scope: 'reactor-stream',
        materializedBlockedActionCount: action.materializedBlockedActionCount,
        summary:
          `${policy.blastRadiusSummary} The count includes materialized action rows only; ` +
          'later source events may not yet be materialized.',
      },
      allowedActions: policy.allowedActions,
    }
  }

  const toCheckpointDiagnostic = (
    operation: RuntimeRecoveryCheckpointRecord,
  ): RuntimeRecoveryCheckpointDiagnostic => ({
    operationId: operation.operationId,
    threadId: operation.threadId,
    targetRef: operation.targetRef,
    targetTurnCount: operation.targetTurnCount,
    phase: operation.phase,
    attemptCount: operation.attemptCount,
    providerOutcome: operation.providerOutcome,
    manualResumePhase: operation.manualResumePhase,
    identityEvidence: {
      captureRoot: operation.checkpointCaptureRoot,
      repositoryCommonDir: operation.repositoryCommonDir,
      commitOid: operation.checkpointCommitOid,
    },
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    summary:
      operation.phase === 'requested'
        ? 'Checkpoint revert admission is durably fenced and awaiting owner replay; no destructive phase has started.'
        : 'Automatic checkpoint recovery stopped for operator inspection. The current owner has no proven safe operator mutation for this manual state.',
    errorDigest: digestNullable(operation.lastError),
    blastRadius: {
      scope: 'checkpoint-operation',
      materializedBlockedActionCount: 0,
      summary:
        'This active journal can keep lifecycle mutation closed for its thread; generic reactor action rows are not counted here.',
    },
    allowedActions: [],
  })

  const toAuditRecord = Effect.fn('RuntimeRecoveryAdmin.toAuditRecord')(function* (
    row: RuntimeRecoveryAuditRow,
  ): Effect.fn.Return<RuntimeRecoveryAuditRecord, RuntimeRecoveryAdminInternalError>
  {
    const beforeState = yield* decodeAuditState(row.beforeStateJson).pipe(
      Effect.mapError(toInternalError('RuntimeRecoveryAdmin.decodeAuditBeforeState')),
    )
    const afterState = yield* decodeAuditState(row.afterStateJson).pipe(
      Effect.mapError(toInternalError('RuntimeRecoveryAdmin.decodeAuditAfterState')),
    )
    return {
      auditId: row.auditId,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      reactorId: row.reactorId,
      operationVersion: row.operationVersion,
      actorSessionDigest: digest(row.actorSessionId),
      actorSubjectDigest: digest(row.actorSubject),
      effectKind: row.effectKind,
      action: row.action,
      beforeState,
      afterState,
      reasonDigest: digest(row.reason),
      createdAt: row.createdAt,
    }
  })

  const readAudits = Effect.fn('RuntimeRecoveryAdmin.readAudits')(function* (
    subjectKind: RuntimeRecoverySubjectKind,
    subjectId: string,
  ): Effect.fn.Return<
    {
      readonly items: ReadonlyArray<RuntimeRecoveryAuditRecord>
      readonly truncated: boolean
    },
    RuntimeRecoveryAdminInternalError
  >
  {
    const rows = yield* persistence
      .listAudit({ subjectKind, subjectId, limit: MAX_AUDIT_ITEMS + 1 })
      .pipe(Effect.mapError(toInternalError('RuntimeRecoveryAdmin.listAudit')))
    const items = yield* Effect.forEach(rows.slice(0, MAX_AUDIT_ITEMS).toReversed(), toAuditRecord)
    return { items, truncated: rows.length > MAX_AUDIT_ITEMS }
  })

  const listReactorActions: RuntimeRecoveryAdminShape['listReactorActions'] = (input = {}) =>
    Effect.gen(function* ()
    {
      const cursor =
        input.cursor === undefined ? undefined : yield* decodeReactorCursor(input.cursor)
      const rows = yield* persistence
        .listBlockedReactorActions({
          limit: MAX_LIST_ITEMS + 1,
          ...(cursor === undefined ? {} : { cursor }),
        })
        .pipe(Effect.mapError(toInternalError('RuntimeRecoveryAdmin.listReactorActions')))
      const page = rows.slice(0, MAX_LIST_ITEMS)
      const last = page[page.length - 1]
      const truncated = rows.length > MAX_LIST_ITEMS
      return {
        items: page.map((row) => toReactorDiagnostic(row)),
        truncated,
        nextCursor: truncated && last !== undefined ? encodeReactorCursor(last) : null,
      }
    })

  const getReactorAction: RuntimeRecoveryAdminShape['getReactorAction'] = (actionId) =>
    Effect.gen(function* ()
    {
      const action = yield* persistence
        .getReactorAction(actionId)
        .pipe(Effect.mapError(toInternalError('RuntimeRecoveryAdmin.getReactorAction')))
      if (Option.isNone(action))
      {
        return yield* new RuntimeRecoveryAdminNotFoundError({
          subjectKind: 'reactor-action',
          subjectId: actionId,
        })
      }
      const auditHistory = yield* readAudits('reactor-action', actionId)
      if (!isBlockedStatus(action.value.status) && auditHistory.items.length === 0)
      {
        return yield* new RuntimeRecoveryAdminNotFoundError({
          subjectKind: 'reactor-action',
          subjectId: actionId,
        })
      }
      return {
        diagnostic: toReactorDiagnostic(action.value, auditHistory.items.length > 0),
        audits: auditHistory.items,
        auditsTruncated: auditHistory.truncated,
      }
    })

  const recoverReactorAction: RuntimeRecoveryAdminShape['recoverReactorAction'] = (input) =>
    Effect.gen(function* ()
    {
      const current = yield* persistence
        .getBlockedReactorAction(input.actionId)
        .pipe(Effect.mapError(toInternalError('RuntimeRecoveryAdmin.getReactorActionForMutation')))
      if (Option.isNone(current))
      {
        return yield* new RuntimeRecoveryAdminNotFoundError({
          subjectKind: 'reactor-action',
          subjectId: input.actionId,
        })
      }
      if (
        current.value.status !== input.mutation.expectedStatus ||
        current.value.updatedAt !== input.mutation.expectedUpdatedAt
      )
      {
        return yield* new RuntimeRecoveryAdminStaleError({
          subjectKind: 'reactor-action',
          subjectId: input.actionId,
        })
      }

      yield* policyRegistry.authorize({
        reactorId: current.value.reactorId,
        effectKind: current.value.effectKind,
        operationVersion: current.value.operationVersion,
        status: input.mutation.expectedStatus,
        action: input.mutation.action,
        confirmation: input.mutation.confirmation,
      })

      const updated = yield* persistence
        .recoverReactorAction({
          actionId: input.actionId,
          expectedReactorId: current.value.reactorId,
          expectedEffectKind: current.value.effectKind,
          expectedOperationVersion: current.value.operationVersion,
          expectedStatus: input.mutation.expectedStatus,
          expectedUpdatedAt: input.mutation.expectedUpdatedAt,
          action: input.mutation.action,
          actor: input.actor,
          reason: input.mutation.reason,
          auditId: `runtime-recovery:${NodeCrypto.randomUUID()}`,
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.catchTags({
            RuntimeRecoveryPersistenceNotFoundError: () =>
              new RuntimeRecoveryAdminNotFoundError({
                subjectKind: 'reactor-action',
                subjectId: input.actionId,
              }),
            RuntimeRecoveryPersistenceStaleError: () =>
              new RuntimeRecoveryAdminStaleError({
                subjectKind: 'reactor-action',
                subjectId: input.actionId,
              }),
            PersistenceSqlError: (cause) =>
              new RuntimeRecoveryAdminInternalError({
                operation: 'RuntimeRecoveryAdmin.recoverReactorAction',
                cause,
              }),
          }),
        )
      const auditHistory = yield* readAudits('reactor-action', input.actionId)
      return {
        diagnostic: toReactorDiagnostic(updated, true),
        audits: auditHistory.items,
        auditsTruncated: auditHistory.truncated,
      }
    })

  const listCheckpointReverts: RuntimeRecoveryAdminShape['listCheckpointReverts'] = (input = {}) =>
    Effect.gen(function* ()
    {
      const cursor =
        input.cursor === undefined ? undefined : yield* decodeCheckpointCursor(input.cursor)
      const rows = yield* persistence
        .listManualCheckpointReverts({
          limit: MAX_LIST_ITEMS + 1,
          ...(cursor === undefined ? {} : { cursor }),
        })
        .pipe(Effect.mapError(toInternalError('RuntimeRecoveryAdmin.listCheckpointReverts')))
      const page = rows.slice(0, MAX_LIST_ITEMS)
      const last = page[page.length - 1]
      const truncated = rows.length > MAX_LIST_ITEMS
      return {
        items: page.map(toCheckpointDiagnostic),
        truncated,
        nextCursor: truncated && last !== undefined ? encodeCheckpointCursor(last) : null,
      }
    })

  const getCheckpointRevert: RuntimeRecoveryAdminShape['getCheckpointRevert'] = (operationId) =>
    Effect.gen(function* ()
    {
      const operation = yield* persistence
        .getManualCheckpointRevert(operationId)
        .pipe(Effect.mapError(toInternalError('RuntimeRecoveryAdmin.getCheckpointRevert')))
      if (Option.isNone(operation))
      {
        return yield* new RuntimeRecoveryAdminNotFoundError({
          subjectKind: 'checkpoint-revert',
          subjectId: operationId,
        })
      }
      const auditHistory = yield* readAudits('checkpoint-revert', operationId)
      return {
        diagnostic: toCheckpointDiagnostic(operation.value),
        audits: auditHistory.items,
        auditsTruncated: auditHistory.truncated,
      }
    })

  return RuntimeRecoveryAdmin.of({
    listReactorActions,
    getReactorAction,
    recoverReactorAction,
    listCheckpointReverts,
    getCheckpointRevert,
  })
})

export const RuntimeRecoveryAdminLive = Layer.effect(RuntimeRecoveryAdmin, make)
