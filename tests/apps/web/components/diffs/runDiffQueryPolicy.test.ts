// tests/apps/web/components/diffs/runDiffQueryPolicy.test.ts
// verifies exact run diffs survive current-path cleanup while legacy queries stay bounded

import { describe, expect, it } from 'vite-plus/test'

import { resolveRunDiffQueryKind } from '../../../../../apps/web/src/components/diffs/runDiffQueryPolicy.ts'

describe('resolveRunDiffQueryKind', () =>
{
  it('keeps exact current execution readable after the current path stops being a repository', () =>
  {
    expect(
      resolveRunDiffQueryKind({
        isRunScope: true,
        usesExactRunExecution: true,
        hasActiveThread: true,
        hasActiveThreadId: true,
        hasActiveRunExecution: true,
        isCurrentPathGitRepository: false,
      }),
    ).toBe('exact')
  })

  it('keeps mixed-version legacy fallback gated by the current repository probe', () =>
  {
    const base = {
      isRunScope: true,
      usesExactRunExecution: false,
      hasActiveThread: true,
      hasActiveThreadId: true,
      hasActiveRunExecution: false,
    }
    expect(resolveRunDiffQueryKind({ ...base, isCurrentPathGitRepository: true })).toBe('legacy')
    expect(resolveRunDiffQueryKind({ ...base, isCurrentPathGitRepository: false })).toBeNull()
    expect(
      resolveRunDiffQueryKind({
        ...base,
        usesExactRunExecution: true,
        isCurrentPathGitRepository: true,
      }),
    ).toBeNull()
  })
})
