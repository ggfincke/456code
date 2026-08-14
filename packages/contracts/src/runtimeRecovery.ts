// packages/contracts/src/runtimeRecovery.ts
// defines redacted operator contracts for durable runtime recovery

import * as Schema from 'effect/Schema'
import * as HttpServerRespondable from 'effect/unstable/http/HttpServerRespondable'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as HttpApi from 'effect/unstable/httpapi/HttpApi'
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup'

import {
  EnvironmentAuthenticatedAuth,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
} from './environmentHttp.ts'
import { NonNegativeInt, TrimmedNonEmptyString } from './baseSchemas.ts'

const RuntimeRecoveryIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))
const RuntimeRecoveryIsoDateTime = TrimmedNonEmptyString.check(Schema.isMaxLength(64))
const RuntimeRecoveryReason = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))
const RuntimeRecoverySummary = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))
export const RuntimeRecoveryPageCursor = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4_096),
).pipe(Schema.brand('RuntimeRecoveryPageCursor'))
export type RuntimeRecoveryPageCursor = typeof RuntimeRecoveryPageCursor.Type

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
})

export const RuntimeRecoveryBlockedReactorStatus = Schema.Literals(['unknown', 'poison', 'manual'])
export type RuntimeRecoveryBlockedReactorStatus = typeof RuntimeRecoveryBlockedReactorStatus.Type

export const RuntimeRecoveryReactorStatus = Schema.Literals([
  'shadow',
  'pending',
  'leased',
  'succeeded',
  'retryable',
  'resolved',
  'unknown',
  'poison',
  'manual',
])
export type RuntimeRecoveryReactorStatus = typeof RuntimeRecoveryReactorStatus.Type

export const RuntimeRecoveryEffectAction = Schema.Literal('retry')
export type RuntimeRecoveryEffectAction = typeof RuntimeRecoveryEffectAction.Type

export const RuntimeRecoveryCheckpointPhase = Schema.Literals([
  'requested',
  'admitted',
  'target-staged',
  'restore-ready',
  'restore-started',
  'filesystem-restored',
  'provider-pending',
  'provider-outcome-recorded',
  'projection-finalized',
  'cleanup-pending',
  'manual-required',
  'completed',
  'aborted',
])
export type RuntimeRecoveryCheckpointPhase = typeof RuntimeRecoveryCheckpointPhase.Type

export const RuntimeRecoveryOperatorAction = RuntimeRecoveryEffectAction
export type RuntimeRecoveryOperatorAction = typeof RuntimeRecoveryOperatorAction.Type

export const RuntimeRecoveryAllowedAction = Schema.Struct({
  action: RuntimeRecoveryOperatorAction,
  confirmation: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  description: RuntimeRecoverySummary,
})
export type RuntimeRecoveryAllowedAction = typeof RuntimeRecoveryAllowedAction.Type

export const RuntimeRecoveryBlastRadius = Schema.Struct({
  scope: Schema.Literals(['reactor-stream', 'checkpoint-operation']),
  materializedBlockedActionCount: NonNegativeInt,
  summary: RuntimeRecoverySummary,
})
export type RuntimeRecoveryBlastRadius = typeof RuntimeRecoveryBlastRadius.Type

export const RuntimeRecoveryCheckpointIdentityEvidence = Schema.Struct({
  captureRoot: Schema.Literals(['present', 'missing']),
  repositoryCommonDir: Schema.Literals(['present', 'missing']),
  commitOid: Schema.Literals(['present', 'missing']),
})
export type RuntimeRecoveryCheckpointIdentityEvidence =
  typeof RuntimeRecoveryCheckpointIdentityEvidence.Type

export const RuntimeRecoveryReactorDiagnostic = Schema.Struct({
  actionId: RuntimeRecoveryIdentifier,
  reactorId: RuntimeRecoveryIdentifier,
  operationVersion: NonNegativeInt,
  sourceSequence: NonNegativeInt,
  effectKind: RuntimeRecoveryIdentifier,
  targetKind: RuntimeRecoveryIdentifier,
  targetId: RuntimeRecoveryIdentifier,
  status: RuntimeRecoveryReactorStatus,
  attemptCount: NonNegativeInt,
  createdAt: RuntimeRecoveryIsoDateTime,
  updatedAt: RuntimeRecoveryIsoDateTime,
  summary: RuntimeRecoverySummary,
  payloadDigest: RuntimeRecoveryIdentifier,
  outcomeDigest: Schema.NullOr(RuntimeRecoveryIdentifier),
  errorDigest: Schema.NullOr(RuntimeRecoveryIdentifier),
  blastRadius: RuntimeRecoveryBlastRadius,
  allowedActions: Schema.Array(RuntimeRecoveryAllowedAction),
})
export type RuntimeRecoveryReactorDiagnostic = typeof RuntimeRecoveryReactorDiagnostic.Type

export const RuntimeRecoveryCheckpointDiagnostic = Schema.Struct({
  operationId: RuntimeRecoveryIdentifier,
  threadId: RuntimeRecoveryIdentifier,
  targetRef: RuntimeRecoveryIdentifier,
  targetTurnCount: NonNegativeInt,
  phase: RuntimeRecoveryCheckpointPhase,
  attemptCount: NonNegativeInt,
  providerOutcome: Schema.NullOr(Schema.Literals(['exact', 'known-unsupported', 'manual-unknown'])),
  manualResumePhase: Schema.NullOr(RuntimeRecoveryCheckpointPhase),
  identityEvidence: RuntimeRecoveryCheckpointIdentityEvidence,
  createdAt: RuntimeRecoveryIsoDateTime,
  updatedAt: RuntimeRecoveryIsoDateTime,
  summary: RuntimeRecoverySummary,
  errorDigest: Schema.NullOr(RuntimeRecoveryIdentifier),
  blastRadius: RuntimeRecoveryBlastRadius,
  allowedActions: Schema.Array(RuntimeRecoveryAllowedAction),
})
export type RuntimeRecoveryCheckpointDiagnostic = typeof RuntimeRecoveryCheckpointDiagnostic.Type

export const RuntimeRecoveryReactorAuditState = Schema.Struct({
  kind: Schema.Literal('reactor-action'),
  status: Schema.String,
  updatedAt: RuntimeRecoveryIsoDateTime,
})

export const RuntimeRecoveryCheckpointAuditState = Schema.Struct({
  kind: Schema.Literal('checkpoint-revert'),
  phase: Schema.String,
  manualResumePhase: Schema.NullOr(Schema.String),
  updatedAt: RuntimeRecoveryIsoDateTime,
})

export const RuntimeRecoveryAuditState = Schema.Union([
  RuntimeRecoveryReactorAuditState,
  RuntimeRecoveryCheckpointAuditState,
])
export type RuntimeRecoveryAuditState = typeof RuntimeRecoveryAuditState.Type

export const RuntimeRecoveryAuditRecord = Schema.Struct({
  auditId: RuntimeRecoveryIdentifier,
  subjectKind: Schema.Literals(['reactor-action', 'checkpoint-revert']),
  subjectId: RuntimeRecoveryIdentifier,
  reactorId: Schema.NullOr(RuntimeRecoveryIdentifier),
  operationVersion: Schema.NullOr(NonNegativeInt),
  actorSessionDigest: RuntimeRecoveryIdentifier,
  actorSubjectDigest: RuntimeRecoveryIdentifier,
  effectKind: RuntimeRecoveryIdentifier,
  action: RuntimeRecoveryOperatorAction,
  beforeState: RuntimeRecoveryAuditState,
  afterState: RuntimeRecoveryAuditState,
  reasonDigest: RuntimeRecoveryIdentifier,
  createdAt: RuntimeRecoveryIsoDateTime,
})
export type RuntimeRecoveryAuditRecord = typeof RuntimeRecoveryAuditRecord.Type

export const RuntimeRecoveryReactorListResult = Schema.Struct({
  items: Schema.Array(RuntimeRecoveryReactorDiagnostic),
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(RuntimeRecoveryPageCursor),
})
export type RuntimeRecoveryReactorListResult = typeof RuntimeRecoveryReactorListResult.Type

export const RuntimeRecoveryCheckpointListResult = Schema.Struct({
  items: Schema.Array(RuntimeRecoveryCheckpointDiagnostic),
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(RuntimeRecoveryPageCursor),
})
export type RuntimeRecoveryCheckpointListResult = typeof RuntimeRecoveryCheckpointListResult.Type

export const RuntimeRecoveryReactorDetail = Schema.Struct({
  diagnostic: RuntimeRecoveryReactorDiagnostic,
  audits: Schema.Array(RuntimeRecoveryAuditRecord),
  auditsTruncated: Schema.Boolean,
})
export type RuntimeRecoveryReactorDetail = typeof RuntimeRecoveryReactorDetail.Type

export const RuntimeRecoveryCheckpointDetail = Schema.Struct({
  diagnostic: RuntimeRecoveryCheckpointDiagnostic,
  audits: Schema.Array(RuntimeRecoveryAuditRecord),
  auditsTruncated: Schema.Boolean,
})
export type RuntimeRecoveryCheckpointDetail = typeof RuntimeRecoveryCheckpointDetail.Type

export const RuntimeRecoveryReactorParams = Schema.Struct({
  actionId: RuntimeRecoveryIdentifier,
})
export type RuntimeRecoveryReactorParams = typeof RuntimeRecoveryReactorParams.Type

export const RuntimeRecoveryCheckpointParams = Schema.Struct({
  operationId: RuntimeRecoveryIdentifier,
})
export type RuntimeRecoveryCheckpointParams = typeof RuntimeRecoveryCheckpointParams.Type

export const RuntimeRecoveryListQuery = Schema.Struct({
  cursor: Schema.optionalKey(RuntimeRecoveryPageCursor),
})
export type RuntimeRecoveryListQuery = typeof RuntimeRecoveryListQuery.Type

const RuntimeRecoveryMutationCommon = {
  expectedUpdatedAt: RuntimeRecoveryIsoDateTime,
  reason: RuntimeRecoveryReason,
} as const

export const RuntimeRecoveryReactorMutation = Schema.Struct({
  ...RuntimeRecoveryMutationCommon,
  action: Schema.Literal('retry'),
  expectedStatus: RuntimeRecoveryBlockedReactorStatus,
  confirmation: Schema.Literal('retry-owner-declared-idempotent'),
})
export type RuntimeRecoveryReactorMutation = typeof RuntimeRecoveryReactorMutation.Type

export const RuntimeRecoverySubjectKind = Schema.Literals(['reactor-action', 'checkpoint-revert'])
export type RuntimeRecoverySubjectKind = typeof RuntimeRecoverySubjectKind.Type

export class RuntimeRecoveryNotFoundError extends Schema.TaggedErrorClass<RuntimeRecoveryNotFoundError>()(
  'RuntimeRecoveryNotFoundError',
  {
    code: Schema.Literal('not_found'),
    subjectKind: RuntimeRecoverySubjectKind,
    subjectId: RuntimeRecoveryIdentifier,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
)
{
  [HttpServerRespondable.symbol]()
  {
    return HttpServerResponse.schemaJson(RuntimeRecoveryNotFoundError)(this, { status: 404 })
  }
}

export class RuntimeRecoveryConflictError extends Schema.TaggedErrorClass<RuntimeRecoveryConflictError>()(
  'RuntimeRecoveryConflictError',
  {
    code: Schema.Literal('stale_state'),
    subjectKind: RuntimeRecoverySubjectKind,
    subjectId: RuntimeRecoveryIdentifier,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
)
{
  [HttpServerRespondable.symbol]()
  {
    return HttpServerResponse.schemaJson(RuntimeRecoveryConflictError)(this, { status: 409 })
  }
}

export class RuntimeRecoveryInvalidCursorError extends Schema.TaggedErrorClass<RuntimeRecoveryInvalidCursorError>()(
  'RuntimeRecoveryInvalidCursorError',
  {
    code: Schema.Literal('invalid_cursor'),
    listKind: Schema.Literals(['reactor-actions', 'checkpoint-reverts']),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
)
{
  [HttpServerRespondable.symbol]()
  {
    return HttpServerResponse.schemaJson(RuntimeRecoveryInvalidCursorError)(this, { status: 400 })
  }
}

export const RuntimeRecoveryActionDeniedReason = Schema.Literals([
  'effect-not-declared',
  'action-not-declared',
  'status-not-recoverable',
  'confirmation-required',
])
export type RuntimeRecoveryActionDeniedReason = typeof RuntimeRecoveryActionDeniedReason.Type

export class RuntimeRecoveryActionDeniedError extends Schema.TaggedErrorClass<RuntimeRecoveryActionDeniedError>()(
  'RuntimeRecoveryActionDeniedError',
  {
    code: Schema.Literal('action_denied'),
    reason: RuntimeRecoveryActionDeniedReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
)
{
  [HttpServerRespondable.symbol]()
  {
    return HttpServerResponse.schemaJson(RuntimeRecoveryActionDeniedError)(this, { status: 409 })
  }
}

export class RuntimeRecoveryInternalError extends Schema.TaggedErrorClass<RuntimeRecoveryInternalError>()(
  'RuntimeRecoveryInternalError',
  {
    code: Schema.Literal('internal_error'),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
)
{
  [HttpServerRespondable.symbol]()
  {
    return HttpServerResponse.schemaJson(RuntimeRecoveryInternalError)(this, { status: 500 })
  }
}

const RuntimeRecoveryReadErrors = [
  EnvironmentScopeRequiredError,
  RuntimeRecoveryNotFoundError,
  RuntimeRecoveryInternalError,
  EnvironmentInternalError,
] as const

const RuntimeRecoveryListErrors = [
  EnvironmentScopeRequiredError,
  RuntimeRecoveryInvalidCursorError,
  RuntimeRecoveryInternalError,
  EnvironmentInternalError,
] as const

const RuntimeRecoveryMutationErrors = [
  ...RuntimeRecoveryReadErrors,
  RuntimeRecoveryConflictError,
  RuntimeRecoveryActionDeniedError,
] as const

export class RuntimeRecoveryHttpApiGroup extends HttpApiGroup.make('recovery')
  .add(
    HttpApiEndpoint.get('listReactorActions', '/api/recovery/actions', {
      headers: OptionalBearerHeaders,
      query: RuntimeRecoveryListQuery,
      success: RuntimeRecoveryReactorListResult,
      error: RuntimeRecoveryListErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get('getReactorAction', '/api/recovery/actions/:actionId', {
      headers: OptionalBearerHeaders,
      params: RuntimeRecoveryReactorParams,
      success: RuntimeRecoveryReactorDetail,
      error: RuntimeRecoveryReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post('recoverReactorAction', '/api/recovery/actions/:actionId', {
      headers: OptionalBearerHeaders,
      params: RuntimeRecoveryReactorParams,
      payload: RuntimeRecoveryReactorMutation,
      success: RuntimeRecoveryReactorDetail,
      error: RuntimeRecoveryMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get('listCheckpointReverts', '/api/recovery/checkpoint-reverts', {
      headers: OptionalBearerHeaders,
      query: RuntimeRecoveryListQuery,
      success: RuntimeRecoveryCheckpointListResult,
      error: RuntimeRecoveryListErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get('getCheckpointRevert', '/api/recovery/checkpoint-reverts/:operationId', {
      headers: OptionalBearerHeaders,
      params: RuntimeRecoveryCheckpointParams,
      success: RuntimeRecoveryCheckpointDetail,
      error: RuntimeRecoveryReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  {}

export class RuntimeRecoveryHttpApi extends HttpApi.make('runtimeRecovery').add(
  RuntimeRecoveryHttpApiGroup,
)
{}
