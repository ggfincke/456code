// tests/apps/web/components/diffs/runDiffAnalysisPolicy.test.ts
// verifies exact run analysis survives integration worktree pruning

import { describe, expect, it } from 'vite-plus/test'

import { resolveRunDiffAnalysisCwd } from '../../../../../apps/web/src/components/diffs/runDiffAnalysisPolicy'

describe('run diff analysis repository policy', () =>
{
  it('uses the retained execution repository instead of a pruned integration path', () =>
  {
    expect(
      resolveRunDiffAnalysisCwd({
        usesExactRunExecution: true,
        executionRepositoryRoot: '/repo/primary',
        activeCwd: '/repo/pruned-run',
      }),
    ).toBe('/repo/primary')
  })

  it('keeps the active cwd for legacy run analysis', () =>
  {
    expect(
      resolveRunDiffAnalysisCwd({
        usesExactRunExecution: false,
        executionRepositoryRoot: undefined,
        activeCwd: '/repo/legacy-run',
      }),
    ).toBe('/repo/legacy-run')
  })
})
