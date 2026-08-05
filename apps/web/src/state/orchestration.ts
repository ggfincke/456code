// apps/web/src/state/orchestration.ts
// manage orchestration environment state

import { createOrchestrationEnvironmentAtoms } from '@t3tools/client-runtime/state/orchestration'

import { connectionAtomRuntime } from '../connection/runtime'

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime)
