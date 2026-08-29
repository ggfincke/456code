// apps/server/src/orchestration/Services/ThreadDeletionReactor.ts
// define thread deletion reactor service contract

// owns durable ordered actions that clean up runtime resources after deletion.
//
// @module ThreadDeletionReactor
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'

/**
 * ThreadDeletionReactorShape - Service API for thread deletion cleanup.
 */
export interface ThreadDeletionReactorShape
{
  // start reacting to thread.deleted orchestration domain events.
  //
  // the returned effect must be run in a scope so all worker fibers can be
  // finalized on shutdown.
  readonly start: () => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>

  // resolves when the durable reactor lane is empty and idle.
  // intended for test use to replace timing-sensitive sleeps.
  readonly drain: Effect.Effect<void, ReactorDeliveryError>

  // resolves once deletion cleanup has reached the supplied event sequence.
  readonly drainThrough: (sequence: number) => Effect.Effect<void, ReactorDeliveryError>
}

/**
 * ThreadDeletionReactor - Service tag for thread deletion cleanup workers.
 */
export class ThreadDeletionReactor extends Context.Service<
  ThreadDeletionReactor,
  ThreadDeletionReactorShape
>()('456code/orchestration/Services/ThreadDeletionReactor')
{}
