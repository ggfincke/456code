// apps/mobile/src/state/auth.ts
// manage auth environment state

import { createAuthEnvironmentAtoms } from '@t3tools/client-runtime/state/auth'

import { connectionAtomRuntime } from '../connection/runtime'

export const authEnvironment = createAuthEnvironmentAtoms(connectionAtomRuntime)
