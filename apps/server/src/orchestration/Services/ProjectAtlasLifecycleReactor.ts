// apps/server/src/orchestration/Services/ProjectAtlasLifecycleReactor.ts
// define durable standing project atlas lifecycle cleanup workers

import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'

export interface ProjectAtlasLifecycleReactorShape
{
  readonly start: () => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>
  readonly drain: Effect.Effect<void, ReactorDeliveryError>
}

export class ProjectAtlasLifecycleReactor extends Context.Service<
  ProjectAtlasLifecycleReactor,
  ProjectAtlasLifecycleReactorShape
>()('456code/orchestration/Services/ProjectAtlasLifecycleReactor')
{}
