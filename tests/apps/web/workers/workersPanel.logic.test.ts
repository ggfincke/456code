// tests/apps/web/workers/workersPanel.logic.test.ts
// verifies worker timing and lifecycle derivations used across the panel

import type { WorkersJobSummary } from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vite-plus/test'

import {
  workerElapsedLabel,
  workerFailureView,
  workerJobElapsedLabel,
  workerJobIsActive,
  workerRunFailureBreakdown,
  workerRunIsSettled,
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
    error: Option.none(),
    createdAt: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
    elapsedMs: Option.none(),
    changedFileCount: Option.none(),
    verification: Option.none(),
    scopeViolationCount: 0,
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

describe('failure classification views', () =>
{
  it('separates an env-failed job with a patch from a zero-work broker fault', () =>
  {
    const salvageable = workerFailureView(
      workerJob('failed', {
        failureClass: Option.some('environment'),
        hasPatch: Option.some(true),
        changedFileCount: Option.some(12),
        verificationExitCodes: [Option.some(127)],
      }),
    )
    expect(salvageable).toEqual({
      label: 'Environment',
      salvageable: true,
      evidence: 'patch available · 12 files · verify exit 127',
    })

    const zeroWork = workerFailureView(
      workerJob('failed', {
        failureClass: Option.some('broker_fault'),
        hasPatch: Option.some(false),
      }),
    )
    expect(zeroWork).toEqual({
      label: 'Broker fault',
      salvageable: false,
      evidence: 'no patch',
    })
  })

  it('returns null for non-failed jobs and keeps unknown evidence out of the line', () =>
  {
    expect(workerFailureView(workerJob('completed'))).toBeNull()

    const legacy = workerFailureView(workerJob('failed', { failureClass: Option.some('unknown') }))
    expect(legacy).toEqual({ label: 'Unclassified', salvageable: false, evidence: null })
  })

  it('summarizes run failures as salvageable work plus zero-work causes', () =>
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
    expect(workerRunFailureBreakdown(jobs)).toBe(
      '2 patch available · 1 broker fault · 1 unclassified',
    )
    expect(workerRunFailureBreakdown([workerJob('completed')])).toBeNull()
  })
})
