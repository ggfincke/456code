// apps/server/src/orchestration/Services/ArchitectureAutoAnalysisReactor.ts
// defines durable automatic architecture analysis workers

import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'

export interface ArchitectureAutoAnalysisReactorShape
{
  readonly start: () => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>
  readonly drain: Effect.Effect<void, ReactorDeliveryError>
}

export class ArchitectureAutoAnalysisReactor extends Context.Service<
  ArchitectureAutoAnalysisReactor,
  ArchitectureAutoAnalysisReactorShape
>()('456code/orchestration/Services/ArchitectureAutoAnalysisReactor')
{}
