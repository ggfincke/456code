// apps/server/src/orchestration/Services/CheckpointReactor.ts
// define checkpoint reactor service contract

// owns background workers that react to orchestration checkpoint lifecycle
// events and apply checkpoint side effects.
//
// @module CheckpointReactor
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { PersistenceSqlError, ReactorDeliveryError } from '../../persistence/Errors.ts'

/**
 * CheckpointReactorShape - Service API for checkpoint reactor lifecycle.
 */
export interface CheckpointReactorShape
{
  // start only the provider-runtime inbox lane.
  //
  // orchestration startup uses this split phase to catch both durable inbox
  // consumers up to the persisted handoff high-water before provider admission
  // is resumed or any checkpoint journal can publish a terminal event.
  readonly startRuntimeLane: () => Effect.Effect<
    void,
    PersistenceSqlError | ReactorDeliveryError,
    Scope.Scope
  >

  // resume persisted checkpoint journals and start the domain-event lane.
  // the runtime lane and provider admission handoff must already be ready.
  readonly startDomain: () => Effect.Effect<
    void,
    PersistenceSqlError | ReactorDeliveryError,
    Scope.Scope
  >

  // start both checkpoint lanes for compatibility callers.
  //
  // the returned effect must be run in a scope so all worker fibers can be
  // finalized on shutdown.
  //
  // durable domain actions replay from the event store while provider-runtime
  // events remain on the scoped in-memory queue.
  readonly start: () => Effect.Effect<void, PersistenceSqlError | ReactorDeliveryError, Scope.Scope>

  // resolves when both runtime input and durable domain work are idle.
  // intended for test use to replace timing-sensitive sleeps.
  readonly drain: Effect.Effect<void, ReactorDeliveryError>
}

/**
 * CheckpointReactor - Service tag for checkpoint reactor workers.
 */
export class CheckpointReactor extends Context.Service<CheckpointReactor, CheckpointReactorShape>()(
  '456code/orchestration/Services/CheckpointReactor',
)
{}
