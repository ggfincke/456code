// apps/server/src/orchestration/Services/ProjectionPipeline.ts
// defines projection execution and attachment ownership operations

// OrchestrationProjectionPipeline - Event projection pipeline service interface.
//
// coordinates projection bootstrap/replay and per-event projection updates for
// orchestration read models.
//
// @module OrchestrationProjectionPipeline
import type { OrchestrationEvent } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { ProjectionRepositoryError } from '../../persistence/Errors.ts'

/**
 * OrchestrationProjectionPipelineShape - Service API for projection execution.
 */
export interface OrchestrationProjectionPipelineShape
{
  readonly verifyThreadAttachmentSet?: (input: {
    readonly threadId: string
    readonly expectedRelativePaths: ReadonlyArray<string>
  }) => Effect.Effect<
    {
      readonly complete: boolean
      readonly actualRelativePaths: ReadonlyArray<string>
    },
    Error
  >

  readonly cleanupDeletedThreadAttachments?: (threadId: string) => Effect.Effect<
    {
      readonly complete: boolean
      readonly remainingRelativePaths: ReadonlyArray<string>
    },
    Error
  >

  // bootstrap projections by replaying persisted events.
  //
  // resumes each projector from its stored projection-state cursor.
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>

  // project a single orchestration event into projection repositories.
  //
  // projectors are executed sequentially to preserve deterministic ordering.
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>
}

/**
 * OrchestrationProjectionPipeline - Service tag for orchestration projections.
 */
export class OrchestrationProjectionPipeline extends Context.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()('456code/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline')
{}
