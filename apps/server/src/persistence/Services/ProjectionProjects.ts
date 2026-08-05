// apps/server/src/persistence/Services/ProjectionProjects.ts
// define projection projects service contract

// owns persistence operations for project rows in the orchestration projection
// read model.
//
// @module ProjectionProjectRepository
import { IsoDateTime, ModelSelection, ProjectId, ProjectScript } from '@t3tools/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { ProjectionRepositoryError } from '../Errors.ts'

export const ProjectionProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
})
export type ProjectionProject = typeof ProjectionProject.Type

export const GetProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
})
export type GetProjectionProjectInput = typeof GetProjectionProjectInput.Type

export const DeleteProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
})
export type DeleteProjectionProjectInput = typeof DeleteProjectionProjectInput.Type

/**
 * ProjectionProjectRepositoryShape - Service API for projected project records.
 */
export interface ProjectionProjectRepositoryShape
{
  // insert or replace a projected project row.
  //
  // upserts by `projectId` and persists scripts through JSON encoding.
  readonly upsert: (row: ProjectionProject) => Effect.Effect<void, ProjectionRepositoryError>

  // read a projected project row by id.
  readonly getById: (
    input: GetProjectionProjectInput,
  ) => Effect.Effect<Option.Option<ProjectionProject>, ProjectionRepositoryError>

  // list all projected project rows.
  //
  // returned in deterministic creation order.
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionProject>, ProjectionRepositoryError>

  // soft-delete a projected project row by id.
  readonly deleteById: (
    input: DeleteProjectionProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>
}

/**
 * ProjectionProjectRepository - Service tag for project projection persistence.
 */
export class ProjectionProjectRepository extends Context.Service<
  ProjectionProjectRepository,
  ProjectionProjectRepositoryShape
>()('456code/persistence/Services/ProjectionProjects/ProjectionProjectRepository')
{}
