// tests/apps/server/projectionSnapshotQueryTestHelpers.ts
// provides fail-fast projection snapshot query test stubs

import * as Effect from 'effect/Effect'

import type { ProjectionSnapshotQueryShape } from '../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'

export const makeProjectionSnapshotQueryStub = (
  overrides: Partial<ProjectionSnapshotQueryShape> = {},
): ProjectionSnapshotQueryShape => ({
  getCommandReadModel: () => Effect.die('unexpected ProjectionSnapshotQuery.getCommandReadModel'),
  getSnapshot: () => Effect.die('unexpected ProjectionSnapshotQuery.getSnapshot'),
  getShellSnapshot: () => Effect.die('unexpected ProjectionSnapshotQuery.getShellSnapshot'),
  getArchivedShellSnapshot: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getArchivedShellSnapshot'),
  getSnapshotSequence: () => Effect.die('unexpected ProjectionSnapshotQuery.getSnapshotSequence'),
  getCounts: () => Effect.die('unexpected ProjectionSnapshotQuery.getCounts'),
  getImportReconciliationContext: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getImportReconciliationContext'),
  getActiveProjectByWorkspaceRoot: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot'),
  getProjectShellById: () => Effect.die('unexpected ProjectionSnapshotQuery.getProjectShellById'),
  getFirstActiveThreadIdByProjectId: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId'),
  getThreadCheckpointContext: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getThreadCheckpointContext'),
  getFullThreadDiffContext: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getFullThreadDiffContext'),
  getCheckpointIdentity: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getCheckpointIdentity'),
  getThreadShellById: () => Effect.die('unexpected ProjectionSnapshotQuery.getThreadShellById'),
  isThreadImportFinalized: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.isThreadImportFinalized'),
  getThreadDetailById: () => Effect.die('unexpected ProjectionSnapshotQuery.getThreadDetailById'),
  getOrchestrateRunExecution: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getOrchestrateRunExecution'),
  getCurrentOrchestrateRunExecution: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getCurrentOrchestrateRunExecution'),
  getThreadDetailSnapshot: () =>
    Effect.die('unexpected ProjectionSnapshotQuery.getThreadDetailSnapshot'),
  ...overrides,
})
