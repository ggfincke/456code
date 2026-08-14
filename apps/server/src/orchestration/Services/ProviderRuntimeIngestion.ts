// apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts
// define provider runtime ingestion service contract

// owns background workers that consume provider runtime streams and emit
// orchestration commands/events; domain events are not an input.
//
// @module ProviderRuntimeIngestionService
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'

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
  // every admitted event is claimed through the durable inbox before this
  // consumer may advance its cursor.
  readonly start: () => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>

  // resolves when the internal processing queue is empty and idle.
  readonly drain: Effect.Effect<void, ReactorDeliveryError>
}

/**
 * ProviderRuntimeIngestionService - Service tag for runtime ingestion workers.
 */
export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()('456code/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService')
{}
