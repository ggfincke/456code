// apps/web/src/state/filesystem.ts
// manage filesystem environment state

import { createFilesystemEnvironmentAtoms } from '@t3tools/client-runtime/state/filesystem'

import { connectionAtomRuntime } from '../connection/runtime'

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime)
