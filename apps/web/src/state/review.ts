// apps/web/src/state/review.ts
// manage review environment state

import { createReviewEnvironmentAtoms } from '@t3tools/client-runtime/state/review'

import { connectionAtomRuntime } from '../connection/runtime'

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime)
