// apps/mobile/src/state/git.ts
// manage git environment state

import { createGitEnvironmentAtoms } from '@t3tools/client-runtime/state/git'

import { connectionAtomRuntime } from '../connection/runtime'

export const gitEnvironment = createGitEnvironmentAtoms(connectionAtomRuntime)
