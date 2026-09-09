// apps/web/src/state/usage.ts
// query bounded environment usage summaries

import { createEnvironmentRpcQueryAtomFamily } from '@t3tools/client-runtime/state/runtime'
import { WS_METHODS } from '@t3tools/contracts'

import { connectionAtomRuntime } from '../connection/runtime'

export const usageEnvironment = {
  summary: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: 'environment-data:usage:summary',
    tag: WS_METHODS.serverGetUsageSummary,
    staleTimeMs: 0,
    idleTtlMs: 60_000,
  }),
}
