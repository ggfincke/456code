// packages/client-runtime/src/state/review.ts
// manage create review environment atoms state

import { WS_METHODS } from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'

import { createEnvironmentRpcQueryAtomFamily } from './runtime.ts'
import type { EnvironmentRegistry } from '../connection/registry.ts'

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
)
{
  return {
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:review:diff-preview',
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
    }),
  }
}
