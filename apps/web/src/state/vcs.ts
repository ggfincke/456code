// apps/web/src/state/vcs.ts
// manage vcs environment state

import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from '@t3tools/client-runtime/state/vcs'

import { connectionAtomRuntime } from '../connection/runtime'

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime)
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime)
