// tests/apps/mobile/state/threads/run-worktree.test.ts
// verifies mobile resolves only the current exact run root with legacy fallback

import { ThreadId, TurnId, type OrchestrateRunExecution } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { resolveCurrentRunWorktreePath } from '../../../../../apps/mobile/src/state/threads/run-worktree.ts'

const execution: OrchestrateRunExecution = {
  threadId: ThreadId.make('thread-mobile-run'),
  runId: 'run-current',
  planRevision: 2,
  sourceTurnId: TurnId.make('turn-mobile-run'),
  sourceSequence: 20,
  repositoryRoot: '/repo',
  repositoryCommonDir: '/repo/.git',
  baseOid: 'base-oid',
  lifecycle: 'active',
  availability: 'available',
  integrationRoot: '/repo/worktrees/current',
  integrationCommonDir: '/repo/.git',
  integrationBranch: 'run-current',
  integrationOid: 'head-oid',
  observedHeadOid: 'head-oid',
  finalHeadOid: null,
  closeReason: null,
  current: true,
  admittedAt: '2026-08-09T03:00:00.000Z',
  updatedAt: '2026-08-09T03:01:00.000Z',
  terminalAt: null,
  jobs: [],
}

describe('resolveCurrentRunWorktreePath', () =>
{
  it('prefers shell current execution and refuses stale roots after exact prune', () =>
  {
    const staleDetail = {
      ...execution,
      runId: 'run-stale',
      integrationRoot: '/repo/worktrees/stale',
    }
    expect(
      resolveCurrentRunWorktreePath({
        shellExecution: execution,
        detailExecution: staleDetail,
        shellLegacyPath: '/repo/worktrees/legacy-shell',
        detailLegacyPath: '/repo/worktrees/legacy-detail',
      }),
    ).toBe('/repo/worktrees/current')
    expect(
      resolveCurrentRunWorktreePath({
        shellExecution: null,
        detailExecution: staleDetail,
        shellLegacyPath: '/repo/worktrees/legacy-shell',
        detailLegacyPath: '/repo/worktrees/legacy-detail',
      }),
    ).toBe('/repo/worktrees/legacy-shell')
    expect(
      resolveCurrentRunWorktreePath({
        shellExecution: null,
        detailExecution: staleDetail,
        shellLegacyPath: undefined,
        detailLegacyPath: '/repo/worktrees/legacy-detail',
      }),
    ).toBeNull()
    expect(
      resolveCurrentRunWorktreePath({
        shellExecution: { ...execution, availability: 'unavailable' },
        detailExecution: staleDetail,
        shellLegacyPath: '/repo/worktrees/legacy-shell',
        detailLegacyPath: '/repo/worktrees/legacy-detail',
      }),
    ).toBeNull()
  })

  it('uses legacy current-root compatibility when no exact execution exists', () =>
  {
    expect(
      resolveCurrentRunWorktreePath({
        shellExecution: undefined,
        detailExecution: undefined,
        shellLegacyPath: '/repo/worktrees/legacy-shell',
        detailLegacyPath: '/repo/worktrees/legacy-detail',
      }),
    ).toBe('/repo/worktrees/legacy-shell')
    expect(
      resolveCurrentRunWorktreePath({
        shellExecution: null,
        detailExecution: null,
        shellLegacyPath: '/repo/worktrees/legacy-shell',
        detailLegacyPath: '/repo/worktrees/legacy-detail',
      }),
    ).toBe('/repo/worktrees/legacy-shell')
  })
})
