// apps/server/src/persistence/Services/ProjectionPendingApprovals.ts
// define projection pending approvals service contract

// owns persistence operations for projected approval requests awaiting user
// decisions.
//
// @module ProjectionPendingApprovalRepository
import {
  ApprovalRequestId,
  IsoDateTime,
  ProjectionPendingApprovalDecision,
  ProjectionPendingApprovalStatus,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { ProjectionRepositoryError } from '../Errors.ts'

export const ProjectionPendingApproval = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  status: ProjectionPendingApprovalStatus,
  decision: ProjectionPendingApprovalDecision,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
})
export type ProjectionPendingApproval = typeof ProjectionPendingApproval.Type

export const ListProjectionPendingApprovalsInput = Schema.Struct({
  threadId: ThreadId,
})
export type ListProjectionPendingApprovalsInput = typeof ListProjectionPendingApprovalsInput.Type

export const GetProjectionPendingApprovalInput = Schema.Struct({
  requestId: ApprovalRequestId,
})
export type GetProjectionPendingApprovalInput = typeof GetProjectionPendingApprovalInput.Type

export const DeleteProjectionPendingApprovalInput = Schema.Struct({
  requestId: ApprovalRequestId,
})
export type DeleteProjectionPendingApprovalInput = typeof DeleteProjectionPendingApprovalInput.Type

/**
 * ProjectionPendingApprovalRepositoryShape - Service API for pending approvals.
 */
export interface ProjectionPendingApprovalRepositoryShape
{
  // insert or replace a projected pending approval row.
  //
  // upserts by `requestId`.
  readonly upsert: (
    row: ProjectionPendingApproval,
  ) => Effect.Effect<void, ProjectionRepositoryError>

  // list pending approvals for a thread.
  //
  // returned in ascending creation order.
  readonly listByThreadId: (
    input: ListProjectionPendingApprovalsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionPendingApproval>, ProjectionRepositoryError>

  // read a pending approval row by request id.
  readonly getByRequestId: (
    input: GetProjectionPendingApprovalInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingApproval>, ProjectionRepositoryError>

  // delete a pending approval row by request id.
  readonly deleteByRequestId: (
    input: DeleteProjectionPendingApprovalInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>
}

/**
 * ProjectionPendingApprovalRepository - Service tag for pending approval persistence.
 */
export class ProjectionPendingApprovalRepository extends Context.Service<
  ProjectionPendingApprovalRepository,
  ProjectionPendingApprovalRepositoryShape
>()(
  '456code/persistence/Services/ProjectionPendingApprovals/ProjectionPendingApprovalRepository',
)
{}
