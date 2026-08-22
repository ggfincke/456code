// tests/packages/client-runtime/errors/orchestration.test.ts
// verify bootstrap thread deletion detection for dispatch errors

import { OrchestrationDispatchCommandError } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { wasBootstrapThreadDeleted } from '../../../../packages/client-runtime/src/errors/orchestration.ts'

describe('wasBootstrapThreadDeleted', () =>
{
  it('accepts only a confirmed deleted bootstrap thread', () =>
  {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: 'Failed to create worktree.',
          bootstrapThreadDisposition: 'deleted',
        }),
      ),
    ).toBe(true)
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: 'Failed to create worktree.' }),
      ),
    ).toBe(false)
    expect(wasBootstrapThreadDeleted(new Error('connection lost'))).toBe(false)
    expect(wasBootstrapThreadDeleted(null)).toBe(false)
  })
})
