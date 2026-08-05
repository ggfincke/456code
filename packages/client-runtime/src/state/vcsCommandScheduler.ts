// packages/client-runtime/src/state/vcsCommandScheduler.ts
// manage vcs command scheduler state

import type { EnvironmentId } from '@t3tools/contracts'

import { createAtomCommandScheduler, type AtomCommandConcurrency } from './runtime.ts'

export const vcsCommandScheduler = createAtomCommandScheduler()

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId
  readonly input: { readonly cwd: string }
}> = {
  mode: 'serial',
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
}
