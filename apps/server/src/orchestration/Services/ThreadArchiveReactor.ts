// apps/server/src/orchestration/Services/ThreadArchiveReactor.ts
// defines durable generation-fenced cleanup after thread archive

import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'

/** Owns durable exact-resource cleanup for thread archive generations. */
export interface ThreadArchiveReactorShape
{
  readonly start: () => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>

  // resolves when the archive lane is empty and idle
  readonly drain: Effect.Effect<void, ReactorDeliveryError>
}

/** Durable thread archive reactor service. */
export class ThreadArchiveReactor extends Context.Service<
  ThreadArchiveReactor,
  ThreadArchiveReactorShape
>()('456code/orchestration/Services/ThreadArchiveReactor')
{}
