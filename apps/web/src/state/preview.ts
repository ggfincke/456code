// apps/web/src/state/preview.ts
// manage preview environment state

import { createPreviewEnvironmentAtoms } from '@t3tools/client-runtime/state/preview'

import { connectionAtomRuntime } from '../connection/runtime'

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime)
