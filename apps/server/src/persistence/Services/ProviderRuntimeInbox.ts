// apps/server/src/persistence/Services/ProviderRuntimeInbox.ts
// defines canonical provider-event admission and replay persistence

import { ProviderDriverKind, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type * as Stream from 'effect/Stream'

import type { PersistenceSqlError } from '../Errors.ts'

export const ProviderRuntimeInboxConsumerId = Schema.Literals([
  'provider-runtime-ingestion',
  'provider-runtime-checkpoint',
])
export type ProviderRuntimeInboxConsumerId = typeof ProviderRuntimeInboxConsumerId.Type

export const ProviderRuntimeInboxAdmissionMode = Schema.Literals(['required', 'fenced'])
export type ProviderRuntimeInboxAdmissionMode = typeof ProviderRuntimeInboxAdmissionMode.Type

export const ProviderRuntimeInboxAdmissionState = Schema.Struct({
  mode: ProviderRuntimeInboxAdmissionMode,
  nextSequence: Schema.Number,
  activeOwnerId: Schema.NullOr(Schema.String),
  ownerGeneration: Schema.Number,
  highWaterSequence: Schema.NullOr(Schema.Number),
  updatedAt: Schema.String,
})
export type ProviderRuntimeInboxAdmissionState = typeof ProviderRuntimeInboxAdmissionState.Type

export const ProviderRuntimeSessionIdentity = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  sessionGeneration: Schema.Number,
})
export type ProviderRuntimeSessionIdentity = typeof ProviderRuntimeSessionIdentity.Type

export const ProviderRuntimeInboxSession = Schema.Struct({
  ...ProviderRuntimeSessionIdentity.fields,
  status: Schema.Literals(['open', 'closed']),
  openedSequence: Schema.NullOr(Schema.Number),
  closedSequence: Schema.NullOr(Schema.Number),
  consumersCompletedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type ProviderRuntimeInboxSession = typeof ProviderRuntimeInboxSession.Type

export const ProviderRuntimeInboxRecord = Schema.Struct({
  ...ProviderRuntimeSessionIdentity.fields,
  sequence: Schema.Number,
  sourceEventId: Schema.String,
  eventType: Schema.String,
  eventCreatedAt: Schema.String,
  receivedAt: Schema.String,
  eventJson: Schema.String,
  eventDigest: Schema.String,
})
export type ProviderRuntimeInboxRecord = typeof ProviderRuntimeInboxRecord.Type

export const ProviderRuntimeInboxAppendResult = Schema.Struct({
  record: ProviderRuntimeInboxRecord,
  duplicate: Schema.Boolean,
  terminalAlreadyClosed: Schema.Boolean,
})
export type ProviderRuntimeInboxAppendResult = typeof ProviderRuntimeInboxAppendResult.Type

export const ProviderRuntimeInboxBuffer = Schema.Struct({
  consumerId: ProviderRuntimeInboxConsumerId,
  stateVersion: Schema.Number,
  throughSequence: Schema.Number,
  stateJson: Schema.String,
  updatedAt: Schema.String,
})
export type ProviderRuntimeInboxBuffer = typeof ProviderRuntimeInboxBuffer.Type

export const ProviderRuntimeInboxConsumerDiagnostics = Schema.Struct({
  consumerId: ProviderRuntimeInboxConsumerId,
  cursorSequence: Schema.Number,
  lag: Schema.Number,
})
export type ProviderRuntimeInboxConsumerDiagnostics =
  typeof ProviderRuntimeInboxConsumerDiagnostics.Type

export const ProviderRuntimeInboxDiagnostics = Schema.Struct({
  admissionMode: ProviderRuntimeInboxAdmissionMode,
  lastSequence: Schema.Number,
  retainedRecordCount: Schema.Number,
  backlogCount: Schema.Number,
  oldestPendingReceivedAt: Schema.NullOr(Schema.String),
  consumers: Schema.Array(ProviderRuntimeInboxConsumerDiagnostics),
})
export type ProviderRuntimeInboxDiagnostics = typeof ProviderRuntimeInboxDiagnostics.Type

export class ProviderRuntimeInboxAdmissionError extends Schema.TaggedErrorClass<ProviderRuntimeInboxAdmissionError>()(
  'ProviderRuntimeInboxAdmissionError',
  {
    reason: Schema.Literals([
      'fenced',
      'owner-fenced',
      'event-collision',
      'session-missing',
      'session-closed',
      'session-provider-mismatch',
      'handoff-incomplete',
    ]),
    detail: Schema.String,
    sourceEventId: Schema.optional(Schema.String),
  },
)
{
  override get message(): string
  {
    return `Provider runtime inbox admission failed (${this.reason}): ${this.detail}`
  }
}

export type ProviderRuntimeInboxError = PersistenceSqlError | ProviderRuntimeInboxAdmissionError

export interface ProviderRuntimeInboxShape
{
  readonly claimAdmissionOwner: (input: {
    readonly ownerId: string
    readonly now: string
  }) => Effect.Effect<ProviderRuntimeInboxAdmissionState, PersistenceSqlError>
  readonly getAdmissionState: Effect.Effect<ProviderRuntimeInboxAdmissionState, PersistenceSqlError>
  readonly setAdmissionMode: (input: {
    readonly ownerId: string
    readonly ownerGeneration: number
    readonly mode: 'fenced'
    readonly highWaterSequence?: number
    readonly now: string
  }) => Effect.Effect<ProviderRuntimeInboxAdmissionState, ProviderRuntimeInboxError>
  readonly resumeAdmissionAfterHandoff: (input: {
    readonly ownerId: string
    readonly ownerGeneration: number
    readonly now: string
  }) => Effect.Effect<ProviderRuntimeInboxAdmissionState, ProviderRuntimeInboxError>
  readonly beginSession: (input: {
    readonly ownerId: string
    readonly ownerGeneration: number
    readonly provider: ProviderDriverKind
    readonly providerInstanceId: string
    readonly threadId: string
    readonly now: string
  }) => Effect.Effect<ProviderRuntimeInboxSession, ProviderRuntimeInboxError>
  readonly append: (input: {
    readonly ownerId: string
    readonly ownerGeneration: number
    readonly provider: ProviderDriverKind
    readonly providerInstanceId: string
    readonly threadId: string
    readonly sessionGeneration: number
    readonly sourceEventId: string
    readonly eventType: string
    readonly eventCreatedAt: string
    readonly receivedAt: string
    readonly eventJson: string
    readonly eventDigest: string
  }) => Effect.Effect<ProviderRuntimeInboxAppendResult, ProviderRuntimeInboxError>
  readonly getCurrentSession: (input: {
    readonly providerInstanceId: string
    readonly threadId: string
  }) => Effect.Effect<Option.Option<ProviderRuntimeInboxSession>, PersistenceSqlError>
  readonly getSession: (
    identity: ProviderRuntimeSessionIdentity,
  ) => Effect.Effect<Option.Option<ProviderRuntimeInboxSession>, PersistenceSqlError>
  readonly listOpenSessions: (
    providerInstanceId: string,
  ) => Effect.Effect<ReadonlyArray<ProviderRuntimeInboxSession>, PersistenceSqlError>
  readonly listAllOpenSessions: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeInboxSession>,
    PersistenceSqlError
  >
  readonly matchesCurrentSession: (
    identity: ProviderRuntimeSessionIdentity,
  ) => Effect.Effect<boolean, PersistenceSqlError>
  readonly get: (
    sequence: number,
  ) => Effect.Effect<Option.Option<ProviderRuntimeInboxRecord>, PersistenceSqlError>
  readonly readPage: (input: {
    readonly afterSequence: number
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ProviderRuntimeInboxRecord>, PersistenceSqlError>
  readonly getBuffer: (
    consumerId: ProviderRuntimeInboxConsumerId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeInboxBuffer>, PersistenceSqlError>
  readonly getDiagnostics: Effect.Effect<ProviderRuntimeInboxDiagnostics, PersistenceSqlError>
  readonly completeConsumerEvent: (input: {
    readonly consumerId: ProviderRuntimeInboxConsumerId
    readonly actionId: string
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly record: ProviderRuntimeInboxRecord
    readonly stateVersion: number
    readonly stateJson: string
    readonly sessionBufferTerminal: boolean
    readonly outcomeJson?: string
    readonly now: string
  }) => Effect.Effect<boolean, PersistenceSqlError>
  readonly pruneCompleted: (input: {
    readonly completedBefore: string
    readonly now: string
  }) => Effect.Effect<number, PersistenceSqlError>
  readonly wakeups: Stream.Stream<number>
}

export class ProviderRuntimeInbox extends Context.Service<
  ProviderRuntimeInbox,
  ProviderRuntimeInboxShape
>()('456code/persistence/Services/ProviderRuntimeInbox')
{}
