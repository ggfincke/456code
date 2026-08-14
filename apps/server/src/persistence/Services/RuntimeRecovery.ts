// apps/server/src/persistence/Services/RuntimeRecovery.ts
// defines durable recovery diagnostics and atomic audited mutation persistence

import type {
  RuntimeRecoveryBlockedReactorStatus,
  RuntimeRecoveryCheckpointPhase,
  RuntimeRecoveryEffectAction,
  RuntimeRecoveryOperatorAction,
  RuntimeRecoveryReactorStatus,
  RuntimeRecoverySubjectKind,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PersistenceSqlError } from '../Errors.ts'

export interface RuntimeRecoveryReactorActionRecord
{
  readonly actionId: string
  readonly reactorId: string
  readonly operationVersion: number
  readonly sourceSequence: number
  readonly sourceEventId: string
  readonly outputIndex: number
  readonly effectKind: string
  readonly targetKind: string
  readonly targetId: string
  readonly status: RuntimeRecoveryReactorStatus
  readonly attemptCount: number
  readonly payloadJson: string
  readonly outcomeJson: string | null
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly materializedBlockedActionCount: number
}

export interface RuntimeRecoveryCheckpointRecord
{
  readonly operationId: string
  readonly threadId: string
  readonly targetRef: string
  readonly targetTurnCount: number
  readonly phase: RuntimeRecoveryCheckpointPhase
  readonly attemptCount: number
  readonly lastError: string | null
  readonly providerOutcome: 'exact' | 'known-unsupported' | 'manual-unknown' | null
  readonly manualResumePhase: RuntimeRecoveryCheckpointPhase | null
  readonly checkpointCaptureRoot: 'present' | 'missing'
  readonly repositoryCommonDir: 'present' | 'missing'
  readonly checkpointCommitOid: 'present' | 'missing'
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RuntimeRecoveryAuditRow
{
  readonly auditId: string
  readonly subjectKind: RuntimeRecoverySubjectKind
  readonly subjectId: string
  readonly reactorId: string | null
  readonly operationVersion: number | null
  readonly actorSessionId: string
  readonly actorSubject: string
  readonly effectKind: string
  readonly action: RuntimeRecoveryOperatorAction
  readonly beforeStateJson: string
  readonly afterStateJson: string
  readonly reason: string
  readonly createdAt: string
}

export interface RuntimeRecoveryActor
{
  readonly sessionId: string
  readonly subject: string
}

export interface RuntimeRecoveryReactorPageCursor
{
  readonly updatedAt: string
  readonly reactorId: string
  readonly sourceSequence: number
  readonly outputIndex: number
  readonly actionId: string
}

export interface RuntimeRecoveryCheckpointPageCursor
{
  readonly updatedAt: string
  readonly operationId: string
}

export class RuntimeRecoveryPersistenceNotFoundError extends Schema.TaggedErrorClass<RuntimeRecoveryPersistenceNotFoundError>()(
  'RuntimeRecoveryPersistenceNotFoundError',
  {
    subjectKind: Schema.Literals(['reactor-action', 'checkpoint-revert']),
    subjectId: Schema.String,
  },
)
{}

export class RuntimeRecoveryPersistenceStaleError extends Schema.TaggedErrorClass<RuntimeRecoveryPersistenceStaleError>()(
  'RuntimeRecoveryPersistenceStaleError',
  {
    subjectKind: Schema.Literals(['reactor-action', 'checkpoint-revert']),
    subjectId: Schema.String,
    reason: Schema.Literals([
      'state-changed',
      'timestamp-changed',
      'effect-changed',
      'reactor-changed',
      'operation-version-changed',
      'resume-target-changed',
    ]),
  },
)
{}

export type RuntimeRecoveryPersistenceMutationError =
  | PersistenceSqlError
  | RuntimeRecoveryPersistenceNotFoundError
  | RuntimeRecoveryPersistenceStaleError

export interface RuntimeRecoveryPersistenceShape
{
  readonly listBlockedReactorActions: (input: {
    readonly limit: number
    readonly cursor?: RuntimeRecoveryReactorPageCursor
  }) => Effect.Effect<ReadonlyArray<RuntimeRecoveryReactorActionRecord>, PersistenceSqlError>
  readonly getReactorAction: (
    actionId: string,
  ) => Effect.Effect<Option.Option<RuntimeRecoveryReactorActionRecord>, PersistenceSqlError>
  readonly getBlockedReactorAction: (
    actionId: string,
  ) => Effect.Effect<Option.Option<RuntimeRecoveryReactorActionRecord>, PersistenceSqlError>
  readonly recoverReactorAction: (input: {
    readonly actionId: string
    readonly expectedReactorId: string
    readonly expectedEffectKind: string
    readonly expectedOperationVersion: number
    readonly expectedStatus: RuntimeRecoveryBlockedReactorStatus
    readonly expectedUpdatedAt: string
    readonly action: RuntimeRecoveryEffectAction
    readonly actor: RuntimeRecoveryActor
    readonly reason: string
    readonly auditId: string
    readonly now: string
  }) => Effect.Effect<RuntimeRecoveryReactorActionRecord, RuntimeRecoveryPersistenceMutationError>
  readonly listManualCheckpointReverts: (input: {
    readonly limit: number
    readonly cursor?: RuntimeRecoveryCheckpointPageCursor
  }) => Effect.Effect<ReadonlyArray<RuntimeRecoveryCheckpointRecord>, PersistenceSqlError>
  readonly getManualCheckpointRevert: (
    operationId: string,
  ) => Effect.Effect<Option.Option<RuntimeRecoveryCheckpointRecord>, PersistenceSqlError>
  readonly listAudit: (input: {
    readonly subjectKind: RuntimeRecoverySubjectKind
    readonly subjectId: string
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<RuntimeRecoveryAuditRow>, PersistenceSqlError>
}

export class RuntimeRecoveryPersistence extends Context.Service<
  RuntimeRecoveryPersistence,
  RuntimeRecoveryPersistenceShape
>()('456code/persistence/Services/RuntimeRecovery/RuntimeRecoveryPersistence')
{}
