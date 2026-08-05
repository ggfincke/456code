// tests/packages/client-runtime/state/workers.test.ts
// verifies selected worker activity subscriptions are keyed by job and environment

import { describe, expect, it } from '@effect/vitest'
import { EnvironmentId } from '@t3tools/contracts'
import * as Layer from 'effect/Layer'
import { Atom } from 'effect/unstable/reactivity'

import type { EnvironmentRegistry } from '../../../../packages/client-runtime/src/connection/registry.ts'
import { createWorkersEnvironmentAtoms } from '../../../../packages/client-runtime/src/state/workers.ts'

describe('worker activity environment atoms', () =>
{
  it('maps one selected job to one stable subscription atom', () =>
  {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >
    const workers = createWorkersEnvironmentAtoms(runtime)
    const target = {
      environmentId: EnvironmentId.make('environment-1'),
      input: { jobId: 'job-a' },
    }

    expect(workers.activity(target)).toBe(
      workers.activity({ environmentId: target.environmentId, input: { jobId: 'job-a' } }),
    )
    expect(
      workers.activity({ environmentId: target.environmentId, input: { jobId: 'job-b' } }),
    ).not.toBe(workers.activity(target))
    expect(
      workers.activity({
        environmentId: EnvironmentId.make('environment-2'),
        input: target.input,
      }),
    ).not.toBe(workers.activity(target))
  })
})
