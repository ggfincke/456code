// apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts
// defines durable reactor progress and action delivery persistence

// @effect-diagnostics preferSchemaOverJson:off - canonical action identity tuple

import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { ReactorDeliveryError } from '../Errors.ts'

export const ReactorId = Schema.Literals([
  'thread-deletion',
  'thread-archive',
  'project-atlas-lifecycle',
  'checkpoint-domain',
  'provider-command',
  'architecture-auto-analysis',
  'provider-runtime-ingestion',
  'provider-runtime-checkpoint',
])
export type ReactorId = typeof ReactorId.Type

export const ReactorMode = Schema.Literals(['shadow', 'durable', 'paused'])
export type ReactorMode = typeof ReactorMode.Type

export const ReactorActionStatus = Schema.Literals([
  'shadow',
  'pending',
  'leased',
  'succeeded',
  'retryable',
  'unknown',
  'poison',
  'manual',
  'resolved',
])
export type ReactorActionStatus = typeof ReactorActionStatus.Type

export const ReactorFailureClass = Schema.Literals(['retryable', 'unknown', 'poison', 'manual'])
export type ReactorFailureClass = typeof ReactorFailureClass.Type

export interface ReactorActionIdentity
{
  readonly reactorId: ReactorId
  readonly sourceSequence: number
  readonly sourceEventId: string
  readonly outputIndex: number
  readonly effectKind: string
  readonly targetKind: string
  readonly targetId: string
  readonly operationVersion: number
}

export function makeReactorActionId(input: ReactorActionIdentity): string
{
  return JSON.stringify([
    input.reactorId,
    input.sourceSequence,
    input.outputIndex,
    input.effectKind,
    input.targetKind,
    input.targetId,
    input.operationVersion,
  ])
}

export interface ReactorActionDraft
{
  readonly outputIndex: number
  readonly effectKind: string
  readonly targetKind: string
  readonly targetId: string
  readonly payloadJson: string
}

export const ReactorActionRecord = Schema.Struct({
  actionId: Schema.String,
  reactorId: ReactorId,
  sourceSequence: Schema.Number,
  sourceEventId: Schema.String,
  outputIndex: Schema.Number,
  effectKind: Schema.String,
  targetKind: Schema.String,
  targetId: Schema.String,
  operationVersion: Schema.Number,
  payloadJson: Schema.String,
  status: ReactorActionStatus,
  attemptCount: Schema.Number,
  availableAt: Schema.String,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseEpoch: Schema.NullOr(Schema.Number),
  leaseExpiresAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  outcomeJson: Schema.NullOr(Schema.String),
})
export interface ReactorActionRecord extends ReactorActionIdentity
{
  readonly actionId: string
  readonly payloadJson: string
  readonly status: ReactorActionStatus
  readonly attemptCount: number
  readonly availableAt: string
  readonly leaseOwner: string | null
  readonly leaseEpoch: number | null
  readonly leaseExpiresAt: string | null
  readonly lastError: string | null
  readonly outcomeJson: string | null
}

export const ReactorProgress = Schema.Struct({
  reactorId: ReactorId,
  operationVersion: Schema.Number,
  mode: ReactorMode,
  cursorSequence: Schema.Number,
  shadowCursorSequence: Schema.Number,
  highWaterSequence: Schema.NullOr(Schema.Number),
  blockedSequence: Schema.NullOr(Schema.Number),
  activeOwnerId: Schema.NullOr(Schema.String),
  ownerEpoch: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})
export type ReactorProgress = typeof ReactorProgress.Type

export interface OrchestrationReactorDeliveryShape
{
  readonly ensureProgress: (input: {
    readonly reactorId: ReactorId
    readonly operationVersion: number
    readonly initialSequence: number
    readonly mode: ReactorMode
    readonly now: string
  }) => Effect.Effect<ReactorProgress, ReactorDeliveryError>
  readonly getProgress: (
    reactorId: ReactorId,
  ) => Effect.Effect<Option.Option<ReactorProgress>, ReactorDeliveryError>
  readonly materialize: (input: {
    readonly reactorId: ReactorId
    readonly operationVersion: number
    readonly sourceSequence: number
    readonly sourceEventId: string
    readonly mode: ReactorMode
    readonly actions: ReadonlyArray<ReactorActionDraft>
    readonly now: string
  }) => Effect.Effect<void, ReactorDeliveryError>
  readonly materializeAhead: (input: {
    readonly reactorId: ReactorId
    readonly operationVersion: number
    readonly ownerId: string
    readonly sourceSequence: number
    readonly sourceEventId: string
    readonly actions: ReadonlyArray<ReactorActionDraft>
    readonly now: string
  }) => Effect.Effect<boolean, ReactorDeliveryError>
  readonly claimNext: (input: {
    readonly reactorId: ReactorId
    readonly ownerId: string
    readonly leaseDurationMs: number
    readonly now: string
    readonly maxSourceSequence?: number
  }) => Effect.Effect<Option.Option<ReactorActionRecord>, ReactorDeliveryError>
  readonly claimNextAhead: (input: {
    readonly reactorId: ReactorId
    readonly ownerId: string
    readonly blockerEffectKind: string
    readonly effectKinds: readonly [string, ...Array<string>]
    readonly leaseDurationMs: number
    readonly now: string
  }) => Effect.Effect<Option.Option<ReactorActionRecord>, ReactorDeliveryError>
  readonly renewLease: (input: {
    readonly actionId: string
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly leaseDurationMs: number
    readonly now: string
  }) => Effect.Effect<boolean, ReactorDeliveryError>
  readonly recordOutcome: (input: {
    readonly actionId: string
    readonly ownerId: string
    readonly leaseEpoch: number
    readonly status: 'succeeded' | 'retryable' | 'unknown' | 'poison' | 'manual'
    readonly outcomeJson?: string
    readonly error?: string
    readonly nextAttemptAt?: string
    readonly now: string
  }) => Effect.Effect<boolean, ReactorDeliveryError>
  readonly advanceCursor: (input: {
    readonly reactorId: ReactorId
    readonly sourceSequence: number
    readonly expectedPreviousSequence: number
    readonly now: string
  }) => Effect.Effect<boolean, ReactorDeliveryError>
  readonly recoverExpiredLeases: (input: {
    readonly reactorId: ReactorId
    readonly ownerId: string
    readonly policy: 'retryable' | 'unknown'
    readonly now: string
  }) => Effect.Effect<number, ReactorDeliveryError>
  readonly resolve: (input: {
    readonly actionId: string
    readonly resolution: 'retry' | 'succeeded' | 'skip'
    readonly operator: string
    readonly detail: string
    readonly now: string
  }) => Effect.Effect<boolean, ReactorDeliveryError>
  readonly skipStale: (input: {
    readonly actionId: string
    readonly sourceEventId: string
    readonly operator: string
    readonly detail: string
    readonly now: string
  }) => Effect.Effect<boolean, ReactorDeliveryError>
  readonly skipStaleByTarget: (input: {
    readonly reactorId: ReactorId
    readonly targetKind: string
    readonly targetId: string
    readonly effectKind: string
    readonly operator: string
    readonly detail: string
    readonly now: string
  }) => Effect.Effect<number, ReactorDeliveryError>
  readonly setMode: (input: {
    readonly reactorId: ReactorId
    readonly mode: ReactorMode
    readonly highWaterSequence?: number
    readonly ownerId: string
    readonly now: string
  }) => Effect.Effect<ReactorProgress, ReactorDeliveryError>
}

export class OrchestrationReactorDelivery extends Context.Service<
  OrchestrationReactorDelivery,
  OrchestrationReactorDeliveryShape
>()('456code/persistence/Services/OrchestrationReactorDelivery')
{}
