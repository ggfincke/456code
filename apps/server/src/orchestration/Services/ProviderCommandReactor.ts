// apps/server/src/orchestration/Services/ProviderCommandReactor.ts
// define provider command reactor service contract

// owns durable replay and ordered execution for provider intent events.
//
// @module ProviderCommandReactor
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape
{
  // register and start the durable provider-command runner.
  //
  // the returned effect must be run in a scope so all worker fibers can be
  // finalized on shutdown.
  //
  readonly start: () => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>

  // drain persisted provider actions through the current event high-water.
  readonly drain: Effect.Effect<void, ReactorDeliveryError>
}

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends Context.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()('456code/orchestration/Services/ProviderCommandReactor')
{}
