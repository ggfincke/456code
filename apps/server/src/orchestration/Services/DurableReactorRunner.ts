// apps/server/src/orchestration/Services/DurableReactorRunner.ts
// defines durable event replay and ordered reactor action execution

import type { OrchestrationEvent } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'
import type {
  ReactorActionDraft,
  ReactorActionRecord,
  ReactorFailureClass,
  ReactorId,
} from '../../persistence/Services/OrchestrationReactorDelivery.ts'

export type ReactorEffectResult =
  | { readonly status: 'succeeded'; readonly resultJson?: string }
  | { readonly status: 'unknown'; readonly detail: string; readonly resultJson?: string }

export interface DurableReactorDefinition
{
  readonly reactorId: ReactorId
  readonly operationVersion: number
  readonly plan: (
    event: OrchestrationEvent,
  ) => Effect.Effect<ReadonlyArray<ReactorActionDraft>, unknown>
  readonly execute: (action: ReactorActionRecord) => Effect.Effect<ReactorEffectResult, unknown>
  readonly classify: (cause: unknown, action: ReactorActionRecord) => ReactorFailureClass
  // reconcile owner-local fences before a durable action becomes terminally
  // blocked. If this fails, the action remains leased/recoverable instead of
  // publishing a blocked state that its owner has not made internally safe.
  readonly onBlocked?: (input: {
    readonly action: ReactorActionRecord
    readonly cause: unknown
    readonly status: 'unknown' | 'poison' | 'manual'
  }) => Effect.Effect<void, ReactorDeliveryError>
  readonly onLeaseExpiry: 'retryable' | 'unknown'
}

export interface DurableReactorRunnerShape
{
  readonly start: (
    definition: DurableReactorDefinition,
  ) => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>
  readonly drain: (reactorId: ReactorId) => Effect.Effect<void, ReactorDeliveryError>
  readonly drainThrough: (
    reactorId: ReactorId,
    sourceSequence: number,
  ) => Effect.Effect<void, ReactorDeliveryError>
  readonly pauseClaims: (reactorId: ReactorId) => Effect.Effect<void, ReactorDeliveryError>
  readonly resumeClaims: (reactorId: ReactorId) => Effect.Effect<void, ReactorDeliveryError>
  readonly setHighWater: (
    reactorId: ReactorId,
    sourceSequence: number,
  ) => Effect.Effect<void, ReactorDeliveryError>
}

export class DurableReactorRunner extends Context.Service<
  DurableReactorRunner,
  DurableReactorRunnerShape
>()('456code/orchestration/Services/DurableReactorRunner')
{}
