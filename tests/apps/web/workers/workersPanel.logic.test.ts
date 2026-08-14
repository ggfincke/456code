// tests/apps/web/workers/workersPanel.logic.test.ts
// verifies worker outcome, supersession, scope, timing, and lifecycle derivations

import type { WorkersJobSummary } from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vite-plus/test'

import {
  workerElapsedLabel,
  workerFailureView,
  workerEvidenceOutcomeView,
  workerJobElapsedLabel,
  workerJobIsActive,
  workerJobOutcomeView,
  workerRunFailureBreakdown,
  workerRunJobRows,
  workerRunOutcomeSummaryView,
  workerRunIsSettled,
  workerScopeViolationGroups,
  workerStageCounts,
} from '../../../../apps/web/src/workers/workersPanel.logic'

function workerJob(
  status: WorkersJobSummary['status'],
  overrides: Partial<WorkersJobSummary> = {},
): WorkersJobSummary
{
  return {
    jobId: `job-${status}`,
    status,
    provider: 'codex',
    mode: 'write',
    repo: '/workspace/repo',
    branch: Option.none(),
    stage: Option.none(),
    workflow: Option.none(),
    run: Option.none(),
    model: Option.none(),
    effort: Option.none(),
    outcome: Option.none(),
    cancelReason: Option.none(),
    supersededBy: Option.none(),
    relaunchOf: Option.none(),
    error: Option.none(),
    createdAt: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
    elapsedMs: Option.none(),
    changedFileCount: Option.none(),
    verification: Option.none(),
    scopeViolationCount: 0,
    scopeViolationGroups: Option.none(),
    failureClass: Option.none(),
    hasPatch: Option.none(),
    verificationExitCodes: [],
    ...overrides,
  }
}

describe('worker elapsed labels', () =>
{
  it.each([
    {
      status: 'running' as const,
      timestamps: {
        startedAt: Option.some('2026-07-31T12:00:00.000Z'),
        createdAt: Option.some('2026-07-31T11:59:00.000Z'),
      },
      expected: '2m so far',
    },
    {
      status: 'queued' as const,
      timestamps: {
        startedAt: Option.none<string>(),
        createdAt: Option.some('2026-07-31T12:01:00.000Z'),
      },
      expected: '1m so far',
    },
  ])('derives live elapsed time for $status jobs', ({ status, timestamps, expected }) =>
  {
    const job = workerJob(status, timestamps)

    expect(workerJobElapsedLabel(job, Date.parse('2026-07-31T12:02:00.000Z'))).toBe(expected)
  })

  it('uses the recorded formatter after a job settles', () =>
  {
    const job = workerJob('completed', { elapsedMs: Option.some(1_500) })

    expect(workerJobElapsedLabel(job, Date.parse('2026-07-31T12:02:00.000Z'))).toBe(
      workerElapsedLabel(job.elapsedMs),
    )
  })
})

describe('worker lifecycle classification', () =>
{
  it('keeps unknown jobs active and represented in rollups', () =>
  {
    const counts = workerStageCounts([workerJob('unknown')])

    expect(workerJobIsActive('unknown')).toBe(true)
    expect(counts.unknown).toBe(1)
    expect(workerRunIsSettled(counts)).toBe(false)
  })

  it('settles only when no active classification remains', () =>
  {
    const counts = workerStageCounts([
      workerJob('completed'),
      workerJob('failed'),
      workerJob('rejected'),
      workerJob('cancelled'),
    ])

    expect(workerRunIsSettled(counts)).toBe(true)
  })
})

describe('worker job outcomes', () =>
{
  it.each(['completed', 'failed', 'rejected', 'cancelled'] as const)(
    'classifies an explicit patch on a %s job as a positive outcome',
    (status) =>
    {
      expect(workerJobOutcomeView(workerJob(status, { hasPatch: Option.some(true) }))).toEqual({
        label: 'Patch available',
        variant: 'success',
      })
    },
  )

  it('does not infer a patch from changed files or legacy patch state', () =>
  {
    expect(
      workerJobOutcomeView(
        workerJob('completed', {
          hasPatch: Option.some(false),
          changedFileCount: Option.some(4),
        }),
      ),
    ).toBeNull()
    expect(workerJobOutcomeView(workerJob('completed'))).toBeNull()
    expect(workerJobOutcomeView({})).toBeNull()
  })

  it('prefers broker outcomes and labels legacy status inference', () =>
  {
    expect(
      workerEvidenceOutcomeView(
        workerJob('failed', {
          outcome: Option.some('environment-blocked'),
          failureClass: Option.some('model'),
        }),
      ),
    ).toMatchObject({
      outcome: 'environment-blocked',
      label: 'Environment blocked',
      inferred: false,
    })
    expect(workerEvidenceOutcomeView(workerJob('completed'))).toMatchObject({
      outcome: 'succeeded',
      label: 'Succeeded (inferred)',
      inferred: true,
    })
  })

  it('shares one outcome-first run line with patch and supersession counts', () =>
  {
    const jobs = [
      workerJob('failed', {
        jobId: 'failed',
        outcome: Option.some('worker-failed'),
        failureClass: Option.some('unknown'),
      }),
      workerJob('completed', { jobId: 'ok-1', outcome: Option.some('succeeded') }),
      workerJob('completed', {
        jobId: 'ok-2',
        outcome: Option.some('succeeded'),
        hasPatch: Option.some(true),
      }),
      workerJob('cancelled', {
        jobId: 'old',
        outcome: Option.some('superseded'),
        failureClass: Option.some('environment'),
      }),
    ]

    expect(workerRunOutcomeSummaryView(jobs)?.label).toBe(
      '1 worker-failed · 2 succeeded · 1 patch available · 1 superseded',
    )
    expect(workerRunOutcomeSummaryView([], { 'broker-fault': 2 })?.label).toBe('2 broker-fault')
    expect(workerRunFailureBreakdown(jobs)).toBe('1 unclassified')
  })
})

describe('worker supersession rows', () =>
{
  it('collapses explicitly linked superseded cancellations under their successor', () =>
  {
    const prior = workerJob('cancelled', {
      jobId: 'attempt-1',
      outcome: Option.some('superseded'),
    })
    const successor = workerJob('running', {
      jobId: 'attempt-2',
      relaunchOf: Option.some('attempt-1'),
    })

    expect(workerRunJobRows([successor, prior])).toEqual([
      { job: successor, priorAttempts: [prior] },
    ])
  })

  it('does not collapse superseded reasons without an explicit job link', () =>
  {
    const unlinked = workerJob('cancelled', {
      jobId: 'attempt-1',
      cancelReason: Option.some('superseded'),
    })
    const other = workerJob('running', { jobId: 'attempt-2' })

    expect(workerRunJobRows([other, unlinked])).toEqual([
      { job: other, priorAttempts: [] },
      { job: unlinked, priorAttempts: [] },
    ])
  })
})

describe('worker scope warning groups', () =>
{
  it('groups structured warnings by root with nearest-allowed fallback', () =>
  {
    const groups = workerScopeViolationGroups({
      scopeViolationDetails: Option.some([
        {
          path: 'apps/web/a.ts',
          phase: 'provider',
          nearestAllowed: Option.none(),
          root: 'apps/web',
        },
        {
          path: 'apps/web/b.ts',
          phase: 'final',
          nearestAllowed: Option.none(),
          root: 'apps/web',
        },
        {
          path: 'tests/a.test.ts',
          phase: 'final',
          nearestAllowed: Option.some('tests'),
          root: '',
        },
      ]),
    })

    expect(groups.map((group) => [group.label, group.items.map((item) => item.path)])).toEqual([
      ['apps/web', ['apps/web/a.ts', 'apps/web/b.ts']],
      ['tests', ['tests/a.test.ts']],
    ])
  })

  it('keeps legacy strings in a named ungrouped bucket', () =>
  {
    expect(workerScopeViolationGroups({ scopeViolations: ['outside/a.ts'] })).toEqual([
      {
        key: 'ungrouped (legacy)',
        label: 'ungrouped (legacy)',
        legacy: true,
        items: [{ path: 'outside/a.ts', phase: null }],
      },
    ])
  })
})

describe('failure classification views', () =>
{
  it('keeps patch availability out of failure evidence', () =>
  {
    const patched = workerFailureView(
      workerJob('failed', {
        failureClass: Option.some('environment'),
        hasPatch: Option.some(true),
        changedFileCount: Option.some(12),
        verificationExitCodes: [Option.some(127)],
      }),
    )
    expect(patched).toEqual({
      label: 'Environment',
      evidence: '12 files · verify exit 127',
    })

    const zeroWork = workerFailureView(
      workerJob('failed', {
        failureClass: Option.some('broker_fault'),
        hasPatch: Option.some(false),
      }),
    )
    expect(zeroWork).toEqual({
      label: 'Broker fault',
      evidence: 'no patch',
    })
  })

  it('returns null for non-failed jobs and keeps unknown evidence out of the line', () =>
  {
    expect(workerFailureView(workerJob('completed'))).toBeNull()

    const legacy = workerFailureView(workerJob('failed', { failureClass: Option.some('unknown') }))
    expect(legacy).toEqual({ label: 'Unclassified', evidence: null })
  })

  it('summarizes run failure classes independently of patch outcomes', () =>
  {
    const jobs = [
      workerJob('completed'),
      workerJob('failed', {
        jobId: 'a',
        failureClass: Option.some('environment'),
        hasPatch: Option.some(true),
      }),
      workerJob('failed', {
        jobId: 'b',
        failureClass: Option.some('environment'),
        hasPatch: Option.some(true),
      }),
      workerJob('failed', {
        jobId: 'c',
        failureClass: Option.some('broker_fault'),
        hasPatch: Option.some(false),
      }),
      workerJob('rejected', { jobId: 'd', failureClass: Option.some('unknown') }),
    ]
    expect(workerRunFailureBreakdown(jobs)).toBe('2 environment · 1 broker fault · 1 unclassified')
    expect(workerRunFailureBreakdown([workerJob('completed')])).toBeNull()
  })
})
