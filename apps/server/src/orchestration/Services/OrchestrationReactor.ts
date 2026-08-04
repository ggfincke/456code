// apps/server/src/orchestration/Services/OrchestrationReactor.ts
// define orchestration reactor service contract

// coordinates startup of orchestration runtime reactors that translate domain
// events into downstream side effects.
//
// @module OrchestrationReactor
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'

/**
 * OrchestrationReactorShape - Service API for orchestration reactor lifecycle.
 */
export interface OrchestrationReactorShape
{
  // start orchestration-side reactors for provider/runtime/checkpoint flows.
  //
  // the returned effect must be run in a scope so all worker fibers can be
  // finalized on shutdown.
  readonly start: () => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>
}

/**
 * OrchestrationReactor - Service tag for orchestration reactor coordination.
 */
export class OrchestrationReactor extends Context.Service<
  OrchestrationReactor,
  OrchestrationReactorShape
>()('456code/orchestration/Services/OrchestrationReactor')
{}
