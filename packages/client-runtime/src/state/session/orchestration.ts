// packages/client-runtime/src/state/session/orchestration.ts
// holds client orchestration state atoms and reducers

import { ORCHESTRATION_WS_METHODS } from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'

import { importScan, importSessions } from '../../operations/importSessions.ts'
import { createEnvironmentCommand, createEnvironmentRpcQueryAtomFamily } from '../runtime.ts'
import type { EnvironmentRegistry } from '../../connection/registry.ts'

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
)
{
  return {
    importScan: createEnvironmentCommand(runtime, {
      label: 'environment-data:orchestration:import-scan',
      execute: importScan,
    }),
    importSessions: createEnvironmentCommand(runtime, {
      label: 'environment-data:orchestration:import-sessions',
      execute: importSessions,
    }),
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:orchestration:turn-diff',
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:orchestration:full-thread-diff',
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    runDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:orchestration:run-diff',
      tag: ORCHESTRATION_WS_METHODS.getRunDiff,
    }),
    runExecutionDiffV1: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:orchestration:run-execution-diff-v1',
      tag: ORCHESTRATION_WS_METHODS.getRunExecutionDiffV1,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:orchestration:archived-shell-snapshot',
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  }
}
