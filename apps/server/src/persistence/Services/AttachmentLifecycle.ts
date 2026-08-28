// apps/server/src/persistence/Services/AttachmentLifecycle.ts
// defines durable attachment staging and cleanup repository operations

import { CommandId, IsoDateTime, MessageId, NonNegativeInt, ThreadId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PersistenceSqlError } from '../Errors.ts'

export const AttachmentStagingState = Schema.Literals(['staged', 'owned', 'cleanup_pending'])
export const AttachmentCleanupState = Schema.Literals([
  'pending',
  'running',
  'complete',
  'poison',
  'manual',
])
export const AttachmentCleanupTargetKind = Schema.Literals(['path', 'thread'])

export const AttachmentStaging = Schema.Struct({
  stagingKey: Schema.String,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  attachmentIndex: NonNegativeInt,
  attachmentId: Schema.String,
  stagingRelativePath: Schema.String,
  relativePath: Schema.String,
  mimeType: Schema.String,
  byteCount: NonNegativeInt,
  contentDigest: Schema.String,
  state: AttachmentStagingState,
  generation: NonNegativeInt,
  ownerSequence: Schema.NullOr(NonNegativeInt),
  ownerEventType: Schema.NullOr(Schema.String),
  cleanupReason: Schema.NullOr(Schema.String),
  retryCount: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type AttachmentStaging = typeof AttachmentStaging.Type

export const AttachmentCleanup = Schema.Struct({
  cleanupKey: Schema.String,
  stagingKey: Schema.NullOr(Schema.String),
  targetKind: AttachmentCleanupTargetKind,
  relativePath: Schema.NullOr(Schema.String),
  stagingRelativePath: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  threadSegment: Schema.NullOr(Schema.String),
  reason: Schema.String,
  sourceSequence: Schema.NullOr(NonNegativeInt),
  stagingGeneration: Schema.NullOr(NonNegativeInt),
  state: AttachmentCleanupState,
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  attemptCount: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type AttachmentCleanup = typeof AttachmentCleanup.Type

export const StageAttachmentInput = Schema.Struct({
  stagingKey: Schema.String,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  attachmentIndex: NonNegativeInt,
  attachmentId: Schema.String,
  stagingRelativePath: Schema.String,
  relativePath: Schema.String,
  mimeType: Schema.String,
  byteCount: NonNegativeInt,
  contentDigest: Schema.String,
  now: IsoDateTime,
})
export type StageAttachmentInput = typeof StageAttachmentInput.Type

export const MarkPromotedInput = Schema.Struct({ stagingKey: Schema.String, now: IsoDateTime })
export type MarkPromotedInput = typeof MarkPromotedInput.Type

export const AssociateAcceptedInput = Schema.Struct({
  commandId: CommandId,
  ownerSequence: NonNegativeInt,
  ownerEventType: Schema.String,
  now: IsoDateTime,
})
export type AssociateAcceptedInput = typeof AssociateAcceptedInput.Type

export const MarkDispatchFailureInput = Schema.Struct({
  commandId: CommandId,
  reason: Schema.String,
  now: IsoDateTime,
})
export type MarkDispatchFailureInput = typeof MarkDispatchFailureInput.Type

export const EnqueuePathCleanupInput = Schema.Struct({
  cleanupKey: Schema.String,
  stagingKey: Schema.NullOr(Schema.String),
  relativePath: Schema.NullOr(Schema.String),
  stagingRelativePath: Schema.NullOr(Schema.String),
  reason: Schema.String,
  sourceSequence: Schema.NullOr(NonNegativeInt),
  now: IsoDateTime,
})
export type EnqueuePathCleanupInput = typeof EnqueuePathCleanupInput.Type

export const EnqueueThreadCleanupInput = Schema.Struct({
  cleanupKey: Schema.String,
  threadId: ThreadId,
  threadSegment: Schema.String,
  reason: Schema.String,
  sourceSequence: Schema.NullOr(NonNegativeInt),
  now: IsoDateTime,
})
export type EnqueueThreadCleanupInput = typeof EnqueueThreadCleanupInput.Type

export const ClaimDueInput = Schema.Struct({
  now: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
  limit: NonNegativeInt,
})
export type ClaimDueInput = typeof ClaimDueInput.Type

export const CompleteCleanupInput = Schema.Struct({
  cleanupKey: Schema.String,
  stagingGeneration: Schema.NullOr(NonNegativeInt),
  now: IsoDateTime,
})
export type CompleteCleanupInput = typeof CompleteCleanupInput.Type

export const RetryCleanupInput = Schema.Struct({
  cleanupKey: Schema.String,
  stagingGeneration: Schema.NullOr(NonNegativeInt),
  error: Schema.String,
  nextAttemptAt: IsoDateTime,
  now: IsoDateTime,
})
export type RetryCleanupInput = typeof RetryCleanupInput.Type

export const PoisonCleanupInput = Schema.Struct({
  cleanupKey: Schema.String,
  stagingGeneration: Schema.NullOr(NonNegativeInt),
  error: Schema.String,
  now: IsoDateTime,
})
export type PoisonCleanupInput = typeof PoisonCleanupInput.Type

export const AttachmentLifecycleDiagnostics = Schema.Struct({
  staging: Schema.Array(AttachmentStaging),
  cleanup: Schema.Array(AttachmentCleanup),
})
export type AttachmentLifecycleDiagnostics = typeof AttachmentLifecycleDiagnostics.Type

export class AttachmentStagingConflictError extends Schema.TaggedErrorClass<AttachmentStagingConflictError>()(
  'AttachmentStagingConflictError',
  { stagingKey: Schema.String, detail: Schema.String },
)
{}

export type AttachmentLifecycleError = PersistenceSqlError | AttachmentStagingConflictError

export interface AttachmentLifecycleRepositoryShape
{
  readonly withCommandPermit: <A, E, R>(
    commandId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly stage: (
    input: StageAttachmentInput,
  ) => Effect.Effect<AttachmentStaging, AttachmentLifecycleError>
  readonly markPromoted: (input: MarkPromotedInput) => Effect.Effect<void, PersistenceSqlError>
  readonly associateAccepted: (
    input: AssociateAcceptedInput,
  ) => Effect.Effect<void, PersistenceSqlError>
  readonly markDispatchFailure: (
    input: MarkDispatchFailureInput,
  ) => Effect.Effect<void, PersistenceSqlError>
  readonly enqueuePathCleanup: (
    input: EnqueuePathCleanupInput,
  ) => Effect.Effect<void, PersistenceSqlError>
  readonly enqueueThreadCleanup: (
    input: EnqueueThreadCleanupInput,
  ) => Effect.Effect<void, PersistenceSqlError>
  readonly claimDue: (
    input: ClaimDueInput,
  ) => Effect.Effect<ReadonlyArray<AttachmentCleanup>, PersistenceSqlError>
  readonly complete: (input: CompleteCleanupInput) => Effect.Effect<void, PersistenceSqlError>
  readonly retry: (input: RetryCleanupInput) => Effect.Effect<void, PersistenceSqlError>
  readonly poison: (input: PoisonCleanupInput) => Effect.Effect<void, PersistenceSqlError>
  readonly listStaging: () => Effect.Effect<ReadonlyArray<AttachmentStaging>, PersistenceSqlError>
  readonly listDiagnostics: () => Effect.Effect<AttachmentLifecycleDiagnostics, PersistenceSqlError>
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<ReadonlyArray<AttachmentStaging>, PersistenceSqlError>
  readonly getByStagingKey: (
    stagingKey: string,
  ) => Effect.Effect<Option.Option<AttachmentStaging>, PersistenceSqlError>
  readonly getByRelativePath: (
    relativePath: string,
  ) => Effect.Effect<Option.Option<AttachmentStaging>, PersistenceSqlError>
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<AttachmentStaging>, PersistenceSqlError>
}

export class AttachmentLifecycleRepository extends Context.Service<
  AttachmentLifecycleRepository,
  AttachmentLifecycleRepositoryShape
>()('456code/persistence/Services/AttachmentLifecycle/AttachmentLifecycleRepository')
{}
