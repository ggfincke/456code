// apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts
// define provider runtime ingestion service contract

// owns background workers that consume provider runtime streams and emit
// orchestration commands/events; domain events are not an input.
//
// @module ProviderRuntimeIngestionService
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

/**
 * ProviderRuntimeIngestionShape - Service API for runtime ingestion lifecycle.
 */
export interface ProviderRuntimeIngestionShape
{
  // start ingesting provider runtime events into orchestration commands.
  //
  // the returned effect must be run in a scope so all worker fibers can be
  // finalized on shutdown.
  //
  // uses an internal queue and continues after non-interrupt failures by
  // logging warnings.
  readonly start: () => Effect.Effect<void, never, Scope.Scope>

  // resolves when the internal processing queue is empty and idle.
  // intended for test use to replace timing-sensitive sleeps.
  readonly drain: Effect.Effect<void>
}

/**
 * ProviderRuntimeIngestionService - Service tag for runtime ingestion workers.
 */
export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()('456code/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService')
{}
