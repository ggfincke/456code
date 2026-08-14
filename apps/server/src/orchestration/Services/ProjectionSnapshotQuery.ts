// apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts
// define projection snapshot query service contract

// exposes the current orchestration projection snapshot for read-only API
// access.
//
// @module ProjectionSnapshotQuery
import type {
  CheckpointRef,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrateRunExecution,
  OrchestrateRunExecutionIdentity,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  ModelSelection,
  ProjectId,
  ThreadId,
  ThreadOrigin,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Option from 'effect/Option'
import type * as Effect from 'effect/Effect'

import type { ProjectionRepositoryError } from '../../persistence/Errors.ts'

export interface ProjectionSnapshotCounts
{
  readonly projectCount: number
  readonly threadCount: number
}

export interface ProjectionSnapshotSequence
{
  readonly snapshotSequence: number
}

export interface ProjectionThreadCheckpointContext
{
  readonly threadId: ThreadId
  readonly projectId: ProjectId
  readonly workspaceRoot: string
  readonly worktreePath: string | null
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>
  readonly baselineCheckpointIdentity?: ProjectionCheckpointIdentity | null
}

export interface ProjectionCheckpointIdentity
{
  readonly checkpointTurnCount: number
  readonly checkpointRef: CheckpointRef
  readonly checkpointCaptureRoot: string | null
  readonly checkpointRepositoryCommonDir: string | null
  readonly checkpointCommitOid: string | null
}

export interface ProjectionFullThreadDiffContext
{
  readonly threadId: ThreadId
  readonly projectId: ProjectId
  readonly workspaceRoot: string
  readonly worktreePath: string | null
  readonly latestCheckpointTurnCount: number
  readonly fromCheckpointIdentity?: ProjectionCheckpointIdentity | null
  readonly toCheckpointIdentity?: ProjectionCheckpointIdentity | null
  readonly toCheckpointRef?: CheckpointRef | null
}

export interface ProjectionImportReconciliationContext
{
  readonly projects: ReadonlyArray<{
    readonly projectId: ProjectId
    readonly workspaceRoot: string
  }>
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId
    readonly projectId: ProjectId
    readonly modelSelection: ModelSelection
    readonly origin: ThreadOrigin
    readonly archived: boolean
  }>
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape
{
  // read the lightweight command snapshot used to bootstrap the in-memory
  // orchestration engine without hydrating message/activity/checkpoint bodies.
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >

  // read the latest orchestration projection snapshot.
  //
  // rehydrates from projection tables and derives snapshot sequence from
  // projector cursor state.
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>

  // read the latest orchestration shell snapshot.
  //
  // returns only projects and thread shell summaries so clients can bootstrap
  // lightweight navigation state without hydrating every thread body.
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >

  // read archived thread shell summaries for the archive page.
  //
  // this query is separate from the main shell snapshot so archived threads
  // are never bootstrapped into normal navigation state.
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >

  // read the latest projection snapshot sequence without hydrating read-model
  // entities.
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >

  // read aggregate projection counts without hydrating the full read model.
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>

  // read the narrow project and imported-thread metadata needed to reconcile
  // external session history without hydrating shell or thread bodies.
  readonly getImportReconciliationContext: () => Effect.Effect<
    ProjectionImportReconciliationContext,
    ProjectionRepositoryError
  >

  // read the active project for an exact workspace root match.
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>

  // read a single active project shell row by id.
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>

  // read the earliest active thread for a project.
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>

  // read the checkpoint context needed to resolve a single thread diff.
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>

  // read only the narrow context needed to compute a full-thread diff from
  // checkpoint 0 to a specific turn count.
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>

  // read one checkpoint's durable capture identity, including turn zero.
  readonly getCheckpointIdentity: (
    threadId: ThreadId,
    checkpointTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionCheckpointIdentity>, ProjectionRepositoryError>

  // exact historical execution lookup; paths may be unavailable while captured
  // repository/base/final provenance remains readable
  readonly getOrchestrateRunExecution: (
    identity: OrchestrateRunExecutionIdentity,
  ) => Effect.Effect<Option.Option<OrchestrateRunExecution>, ProjectionRepositoryError>

  // compatibility owner for web/mobile current-run surfaces.
  readonly getCurrentOrchestrateRunExecution: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrateRunExecution>, ProjectionRepositoryError>

  // read a single active thread shell row by id.
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>

  // check whether an active or archived thread has completed session import
  // without hydrating its imported transcript.
  readonly isThreadImportFinalized: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>

  // read a single active thread detail snapshot by id.
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>

  // read a single active thread detail together with the projection snapshot
  // sequence in one consistent transaction, so the returned `snapshotSequence`
  // exactly matches the state reflected in `thread` (no interleaving projector
  // update between the two reads).
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()('456code/orchestration/Services/ProjectionSnapshotQuery')
{}
