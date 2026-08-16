// tests/apps/web/components/ThreadStatusIndicators.test.ts
// verifies thread and pull request status indicators
import { effectiveSettled } from '@t3tools/client-runtime/state/thread-settled'
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type VcsStatusResult,
} from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { AtomRegistry } from 'effect/unstable/reactivity'

import {
  canRetainTerminalThreadPr,
  nextThreadChangeRequestSnapshot,
  nextTerminalChangeRequestObservation,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolveThreadPr,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
} from '../../../../apps/web/src/components/ThreadStatusIndicators'

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult
{
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: 'feature/current',
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: 'PR branch',
      url: 'https://github.com/pingdotgg/t3code/pull/42',
      baseRef: 'main',
      headRef: 'feature/current',
      state: 'open',
    },
    ...overrides,
  }
}

function terminalPr(state: 'merged' | 'closed' = 'merged')
{
  return {
    number: 42,
    title: 'Feature PR',
    url: 'https://github.com/pingdotgg/t3code/pull/42',
    baseRef: 'main',
    headRef: 'feature/current',
    state,
  } as const
}

function terminalSnapshot(): ThreadChangeRequestSnapshot
{
  return {
    branch: 'feature/current',
    pr: terminalPr(),
    sourceControlProvider: {
      kind: 'github',
      name: 'GitHub',
      baseUrl: 'https://github.com',
    },
  }
}

describe('resolveThreadPr', () =>
{
  it('hides PR indicators when the live checkout does not match the stored thread branch', () =>
  {
    expect(
      resolveThreadPr({
        threadBranch: 'feature/other',
        gitStatus: status(),
      }),
    ).toBeNull()
  })

  it('hides PR indicators when thread branch metadata is missing', () =>
  {
    expect(
      resolveThreadPr({
        threadBranch: null,
        gitStatus: status(),
      }),
    ).toBeNull()
  })

  it('shows the PR when the live checkout matches the stored thread branch', () =>
  {
    const gitStatus = status()

    expect(
      resolveThreadPr({
        threadBranch: 'feature/current',
        gitStatus,
      }),
    ).toBe(gitStatus.pr)
  })
})

describe('terminal change request retention', () =>
{
  it.each([
    ['local checkout', null, null, false, true],
    ['pruned adopted run', null, '/tmp/adopted', true, true],
    ['dedicated worktree', '/tmp/thread', null, false, false],
    ['live adopted run', null, '/tmp/adopted', false, false],
  ] as const)(
    '%s applies the expected terminal retention policy',
    (_surface, worktreePath, orchestrateRunWorktreePath, isNotRepository, expected) =>
    {
      const retainTerminalOnBranchMismatch = canRetainTerminalThreadPr({
        worktreePath,
        orchestrateRunWorktreePath,
        orchestrateRunWorktreeIsNotRepository: isNotRepository,
      })
      expect(retainTerminalOnBranchMismatch).toBe(expected)
      expect(
        resolveDisplayedThreadPr({
          threadBranch: 'feature/current',
          gitStatus: status({ refName: 'main', pr: null }),
          snapshot: terminalSnapshot(),
          retainTerminalOnBranchMismatch,
        }),
      ).toEqual(expected ? terminalPr() : null)
    },
  )

  it('caches terminal PRs only and survives a local checkout plus metadata switch', () =>
  {
    const captured = nextThreadChangeRequestSnapshot({
      threadBranch: 'feature/current',
      gitStatus: status({ refName: 'feature/current', pr: terminalPr() }),
      snapshot: undefined,
      retainTerminalOnBranchMismatch: true,
    })
    expect(captured).toMatchObject({ branch: 'feature/current', pr: { state: 'merged' } })

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: 'feature/current',
        gitStatus: status({
          refName: 'feature/current',
          pr: { ...terminalPr(), state: 'open' },
        }),
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull()

    const unrelatedCurrentBranch = status({
      refName: 'main',
      pr: { ...terminalPr('closed'), number: 99, headRef: 'main' },
    })
    expect(
      resolveDisplayedThreadPr({
        threadBranch: 'main',
        gitStatus: unrelatedCurrentBranch,
        snapshot: captured,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(terminalPr())
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: 'main',
        gitStatus: unrelatedCurrentBranch,
        snapshot: captured,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(captured?.sourceControlProvider)
  })

  it('preserves a terminal observation through pending remount data and clears authoritatively', () =>
  {
    const mergedPr = terminalPr()
    let observation = nextTerminalChangeRequestObservation({
      threadBranch: 'feature/current',
      gitStatus: status({ pr: mergedPr }),
      displayedPr: mergedPr,
      retainOnBranchMismatch: false,
    })
    expect(observation).toMatchObject({ branch: 'feature/current', state: 'merged' })

    // a remounted row can briefly have no VCS value after its query cache expires.
    const pending = nextTerminalChangeRequestObservation({
      threadBranch: 'feature/current',
      gitStatus: null,
      displayedPr: null,
      retainOnBranchMismatch: false,
    })
    if (pending !== undefined) observation = pending
    expect(observation).toMatchObject({ branch: 'feature/current', state: 'merged' })
    expect(
      nextTerminalChangeRequestObservation({
        threadBranch: null,
        gitStatus: null,
        displayedPr: mergedPr,
        retainOnBranchMismatch: false,
      }),
    ).toBeNull()

    for (const displayedPr of [{ ...mergedPr, state: 'open' as const }, null])
    {
      expect(
        nextTerminalChangeRequestObservation({
          threadBranch: 'feature/current',
          gitStatus: status({ pr: displayedPr }),
          displayedPr,
          retainOnBranchMismatch: false,
        }),
      ).toBeNull()
    }
  })

  it('preserves missing VCS data, clears a missing branch, and never retains for worktrees', () =>
  {
    const snapshot = terminalSnapshot()
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: 'feature/current',
        gitStatus: null,
        snapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined()
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: null,
        gitStatus: null,
        snapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull()

    const switched = status({ refName: 'main', pr: null })
    for (const surface of ['dedicated worktree', 'live adopted run'] as const)
    {
      expect(
        resolveDisplayedThreadPr({
          threadBranch: 'feature/current',
          gitStatus: switched,
          snapshot,
          retainTerminalOnBranchMismatch: false,
        }),
        surface,
      ).toBeNull()
      expect(
        nextThreadChangeRequestSnapshot({
          threadBranch: 'feature/current',
          gitStatus: switched,
          snapshot,
          retainTerminalOnBranchMismatch: false,
        }),
        surface,
      ).toBeNull()
    }
  })

  it.effect('keeps the terminal snapshot across consumer remounts', () =>
    Effect.gen(function* ()
    {
      const registry = AtomRegistry.make()
      const threadKey = 'environment-1:thread-1'
      const snapshot = terminalSnapshot()
      const unmount = registry.mount(threadChangeRequestSnapshotsAtom)
      registry.set(threadChangeRequestSnapshotsAtom, new Map([[threadKey, snapshot]]))
      unmount()

      yield* Effect.yieldNow

      const remount = registry.mount(threadChangeRequestSnapshotsAtom)
      expect(registry.get(threadChangeRequestSnapshotsAtom).get(threadKey)).toEqual(snapshot)
      remount()
      registry.dispose()
    }),
  )

  it('feeds the retained merge through the idle and preference settlement gates', () =>
  {
    const snapshot = terminalSnapshot()
    const displayed = resolveDisplayedThreadPr({
      threadBranch: 'main',
      gitStatus: status({ refName: 'main', pr: null }),
      snapshot,
      retainTerminalOnBranchMismatch: true,
    })
    const shell = {
      id: ThreadId.make('thread-1'),
      projectId: ProjectId.make('project-1'),
      title: 'Feature thread',
      modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      branch: 'main',
      worktreePath: null,
      latestTurn: null,
      session: null,
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      latestUserMessageAt: '2026-04-09T22:59:59.999Z',
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } as OrchestrationThreadShell
    const options = {
      now: '2026-04-10T00:00:00.000Z',
      autoSettleAfterDays: null,
      changeRequestState: displayed?.state ?? null,
    }

    expect(effectiveSettled(shell, options)).toBe(true)
    expect(effectiveSettled(shell, { ...options, autoSettleOnMerge: false })).toBe(false)
    expect(
      effectiveSettled({ ...shell, latestUserMessageAt: '2026-04-09T23:30:00.000Z' }, options),
    ).toBe(false)
  })
})

describe('prStatusIndicator', () =>
{
  it('formats PR tooltips with number, uppercase status, and title', () =>
  {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: 'PR #42 - Open: PR branch',
      tooltipLead: 'PR #42 - Open',
      tooltipTitle: 'PR branch',
    })
  })
})
