// apps/server/src/persistence/Services/CheckpointRevertOperations.ts
// defines durable checkpoint revert journal operations and transition policy

import { NonNegativeInt } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PersistenceSqlError } from '../Errors.ts'

export const CheckpointRevertPhase = Schema.Literals([
  'admitted',
  'target-staged',
  'restore-ready',
  'restore-started',
  'filesystem-restored',
  'provider-pending',
  'provider-outcome-recorded',
  'projection-finalized',
  'cleanup-pending',
  'completed',
  'aborted',
  'manual-required',
])
export type CheckpointRevertPhase = typeof CheckpointRevertPhase.Type

export const CheckpointRevertProviderOutcome = Schema.Literals([
  'exact',
  'known-unsupported',
  'manual-unknown',
])
export type CheckpointRevertProviderOutcome = typeof CheckpointRevertProviderOutcome.Type

export const CheckpointRevertOperation = Schema.Struct({
  operationId: Schema.String,
  threadId: Schema.String,
  targetRef: Schema.String,
  targetTurnCount: NonNegativeInt,
  targetTree: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  repositoryCommonDir: Schema.NullOr(Schema.String),
  stagePath: Schema.NullOr(Schema.String),
  phase: CheckpointRevertPhase,
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  providerSessionId: Schema.NullOr(Schema.String),
  providerThreadId: Schema.NullOr(Schema.String),
  providerOutcome: Schema.NullOr(CheckpointRevertProviderOutcome),
  providerOutcomeJson: Schema.NullOr(Schema.String),
  projectionStatus: Schema.NullOr(Schema.String),
  staleRefsJson: Schema.NullOr(Schema.String),
  cleanupStatus: Schema.NullOr(Schema.String),
  manualResumePhase: Schema.NullOr(CheckpointRevertPhase),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type CheckpointRevertOperation = typeof CheckpointRevertOperation.Type

export interface CheckpointRevertResumableOperation extends CheckpointRevertOperation
{
  readonly manualRequired: boolean
}

export const AdmitCheckpointRevertInput = Schema.Struct({
  operationId: Schema.String,
  threadId: Schema.String,
  targetRef: Schema.String,
  targetTurnCount: NonNegativeInt,
  cwd: Schema.String,
  now: Schema.String,
})
export type AdmitCheckpointRevertInput = typeof AdmitCheckpointRevertInput.Type

export const CheckpointRevertLookupInput = Schema.Struct({ id: Schema.String })
export type CheckpointRevertLookupInput = typeof CheckpointRevertLookupInput.Type

export const CheckpointRevertTransitionPatch = Schema.Struct({
  targetTree: Schema.optional(Schema.NullOr(Schema.String)),
  repositoryCommonDir: Schema.optional(Schema.NullOr(Schema.String)),
  stagePath: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  providerInstanceId: Schema.optional(Schema.NullOr(Schema.String)),
  providerSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  providerThreadId: Schema.optional(Schema.NullOr(Schema.String)),
  providerOutcome: Schema.optional(Schema.NullOr(CheckpointRevertProviderOutcome)),
  providerOutcomeJson: Schema.optional(Schema.NullOr(Schema.String)),
  projectionStatus: Schema.optional(Schema.NullOr(Schema.String)),
  staleRefsJson: Schema.optional(Schema.NullOr(Schema.String)),
  cleanupStatus: Schema.optional(Schema.NullOr(Schema.String)),
})
export type CheckpointRevertTransitionPatch = typeof CheckpointRevertTransitionPatch.Type

export const CasCheckpointRevertTransitionInput = Schema.Struct({
  operationId: Schema.String,
  expectedPhase: CheckpointRevertPhase,
  nextPhase: CheckpointRevertPhase,
  patch: Schema.optional(CheckpointRevertTransitionPatch),
  now: Schema.String,
})
export type CasCheckpointRevertTransitionInput = typeof CasCheckpointRevertTransitionInput.Type

export const RecordCheckpointRevertProviderOutcomeInput = Schema.Struct({
  operationId: Schema.String,
  outcome: CheckpointRevertProviderOutcome,
  outcomeJson: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  providerSessionId: Schema.NullOr(Schema.String),
  providerThreadId: Schema.NullOr(Schema.String),
  now: Schema.String,
})
export type RecordCheckpointRevertProviderOutcomeInput =
  typeof RecordCheckpointRevertProviderOutcomeInput.Type

export const RecordCheckpointRevertStaleRefsInput = Schema.Struct({
  operationId: Schema.String,
  staleRefs: Schema.Array(Schema.String),
  now: Schema.String,
})
export type RecordCheckpointRevertStaleRefsInput = typeof RecordCheckpointRevertStaleRefsInput.Type

export const MarkCheckpointRevertManualInput = Schema.Struct({
  operationId: Schema.String,
  expectedPhase: CheckpointRevertPhase,
  error: Schema.String,
  now: Schema.String,
})
export type MarkCheckpointRevertManualInput = typeof MarkCheckpointRevertManualInput.Type

export class CheckpointRevertOperationConflictError extends Schema.TaggedErrorClass<CheckpointRevertOperationConflictError>()(
  'CheckpointRevertOperationConflictError',
  {
    operationId: Schema.String,
    threadId: Schema.String,
    activeOperationId: Schema.String,
    activePhase: CheckpointRevertPhase,
  },
)
{
  override get message(): string
  {
    return (
      `Checkpoint revert '${this.activeOperationId}' is already active for ` +
      `thread '${this.threadId}' in phase '${this.activePhase}'.`
    )
  }
}

export class CheckpointRevertTransitionError extends Schema.TaggedErrorClass<CheckpointRevertTransitionError>()(
  'CheckpointRevertTransitionError',
  {
    operationId: Schema.String,
    expectedPhase: CheckpointRevertPhase,
    nextPhase: CheckpointRevertPhase,
    actualPhase: Schema.NullOr(CheckpointRevertPhase),
    reason: Schema.Literals(['not-found', 'phase-mismatch', 'illegal-edge', 'resume-mismatch']),
  },
)
{
  override get message(): string
  {
    return (
      `Checkpoint revert transition '${this.operationId}' from '${this.expectedPhase}' ` +
      `to '${this.nextPhase}' was rejected (${this.reason}).`
    )
  }
}

export type CheckpointRevertOperationsError =
  PersistenceSqlError | CheckpointRevertOperationConflictError | CheckpointRevertTransitionError

export interface CheckpointRevertOperationsShape
{
  readonly admit: (
    input: AdmitCheckpointRevertInput,
  ) => Effect.Effect<CheckpointRevertOperation, CheckpointRevertOperationsError>
  readonly getActiveByThread: (
    threadId: string,
  ) => Effect.Effect<Option.Option<CheckpointRevertOperation>, PersistenceSqlError>
  readonly getById: (
    operationId: string,
  ) => Effect.Effect<Option.Option<CheckpointRevertOperation>, PersistenceSqlError>
  readonly casTransition: (
    input: CasCheckpointRevertTransitionInput,
  ) => Effect.Effect<CheckpointRevertOperation, CheckpointRevertOperationsError>
  readonly listResumable: () => Effect.Effect<
    ReadonlyArray<CheckpointRevertResumableOperation>,
    PersistenceSqlError
  >
  readonly recordProviderOutcome: (
    input: RecordCheckpointRevertProviderOutcomeInput,
  ) => Effect.Effect<CheckpointRevertOperation, CheckpointRevertOperationsError>
  readonly recordStaleRefs: (
    input: RecordCheckpointRevertStaleRefsInput,
  ) => Effect.Effect<CheckpointRevertOperation, CheckpointRevertOperationsError>
  readonly markManual: (
    input: MarkCheckpointRevertManualInput,
  ) => Effect.Effect<CheckpointRevertOperation, CheckpointRevertOperationsError>
}

export class CheckpointRevertOperations extends Context.Service<
  CheckpointRevertOperations,
  CheckpointRevertOperationsShape
>()('456code/persistence/Services/CheckpointRevertOperations')
{}
