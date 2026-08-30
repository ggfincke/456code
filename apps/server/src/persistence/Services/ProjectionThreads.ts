// apps/server/src/persistence/Services/ProjectionThreads.ts
// defines the projected thread repository service

// ProjectionThreadRepository - Projection repository interface for threads.
//
// owns persistence operations for projected thread records in the
// orchestration read model.
//
// @module ProjectionThreadRepository
import {
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  OrchestrationPendingHandoff,
  OrchestrationProviderSwitch,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { ProjectionRepositoryError } from '../Errors.ts'

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  pendingHandoff: Schema.NullOr(OrchestrationPendingHandoff),
  providerSwitch: Schema.NullOr(OrchestrationProviderSwitch),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  interactionOrchestrate: NonNegativeInt,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  // required-but-nullable on purpose: it makes the compiler enumerate every full
  // row literal, so no write path can silently null the run's integration target
  // back out and take the thread's evidence surfaces with it
  orchestrateRunWorktreePath: Schema.NullOr(Schema.String),
  orchestrateRunBranch: Schema.NullOr(Schema.String),
  originJson: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  archiveGeneration: NonNegativeInt,
  settledOverride: Schema.NullOr(Schema.Literals(['settled', 'active'])),
  settledAt: Schema.NullOr(IsoDateTime),
  unsettledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  deletedAt: Schema.NullOr(IsoDateTime),
})
export type ProjectionThread = typeof ProjectionThread.Type

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
})
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
})
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
})
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape
{
  // insert or replace a projected thread row.
  //
  // upserts by `threadId`.
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>

  // read a projected thread row by id.
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>

  // list projected threads for a project.
  //
  // returned in deterministic creation order.
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>

  // soft-delete a projected thread row by id.
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()('456code/persistence/Services/ProjectionThreads/ProjectionThreadRepository')
{}
