// tests/packages/client-runtime/state/threads-atoms.test.ts
// verify create environment thread state atoms behavior

import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Layer from 'effect/Layer'
import { Atom } from 'effect/unstable/reactivity'

import type { EnvironmentRegistry } from '../../../../packages/client-runtime/src/connection/registry.ts'
import type { EnvironmentCacheStore } from '../../../../packages/client-runtime/src/platform/persistence.ts'
import {
  createEnvironmentThreadStateAtoms,
  type ThreadSnapshotLoader,
} from '../../../../packages/client-runtime/src/state/threads.ts'

describe('createEnvironmentThreadStateAtoms', () =>
{
  it('caches stateAtom by environment+thread', () =>
  {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >
    const threads = createEnvironmentThreadStateAtoms(runtime)
    const environmentId = EnvironmentId.make('environment-1')
    const threadId = ThreadId.make('thread-1')
    const atom = threads.stateAtom(environmentId, threadId)

    expect(threads.stateAtom(environmentId, threadId)).toBe(atom)
    expect(threads.stateAtom(environmentId, ThreadId.make('thread-2'))).not.toBe(atom)
  })
})
