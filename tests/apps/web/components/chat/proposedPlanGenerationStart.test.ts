// tests/apps/web/components/chat/proposedPlanGenerationStart.test.ts
// verifies durable proposal generation start transitions and stale-result fencing
import type { EnvironmentId, ProposalGeneration } from '@t3tools/contracts'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  claimManualProposalGenerationStart,
  completeProposalGenerationStart,
  createProposalGenerationStartTarget,
  failProposalGenerationStart,
  proposalGenerationStartBaselineGenerationId,
  readProposalGenerationStartState,
  recordObservedProposalGenerationFailure,
  resetProposalGenerationStartStoreForTests,
  type ProposalGenerationStartTarget,
} from '../../../../../apps/web/src/components/chat/proposedPlanGenerationStart'

const environmentId = 'environment-generation-start' as EnvironmentId

function generation(
  generationId: string,
  state: ProposalGeneration['state'] = 'queued',
  errorCode: string | null = null,
): ProposalGeneration
{
  return {
    generationId,
    proposalId: 'proposal-generation-start',
    revisionId: 'proposal-generation-start:1',
    revision: 1,
    threadId: 'thread-generation-start',
    state,
    authority: 'authoritative',
    freshness: 'fresh',
    workspaceSnapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
    analyzerVersion: 'test-analyzer',
    baseGraphArtifact: null,
    proposedGraphArtifact: null,
    impactArtifact: null,
    errorCode,
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
  } as ProposalGeneration
}

function target(index = 0): ProposalGenerationStartTarget
{
  return createProposalGenerationStartTarget({
    environmentId,
    threadId: 'thread-generation-start' as ProposalGeneration['threadId'],
    proposalId: `proposal-generation-start-${index}` as ProposalGeneration['proposalId'],
    revision: 1,
  })
}

beforeEach(resetProposalGenerationStartStoreForTests)

describe('proposal generation start transitions', () =>
{
  it('keeps a failed manual attempt visible until an explicit retry', () =>
  {
    const owner = target()
    expect(readProposalGenerationStartState(owner).status).toBe('idle')
    const attempt = claimManualProposalGenerationStart(owner, null)
    const starting = readProposalGenerationStartState(owner)
    expect(failProposalGenerationStart(attempt!, 'start failed')).toBe(true)
    const failed = readProposalGenerationStartState(owner)

    expect(starting).toEqual({
      status: 'starting',
      error: null,
      generation: null,
      attemptId: 1,
      baselineGenerationId: null,
    })
    expect(failed).toEqual({
      status: 'failed',
      error: 'start failed',
      generation: null,
      attemptId: 1,
      baselineGenerationId: null,
    })
    const retry = claimManualProposalGenerationStart(owner, null)
    expect(retry?.attemptId).toBe(2)
    expect(readProposalGenerationStartState(owner)).toMatchObject({
      status: 'starting',
      attemptId: 2,
    })
  })

  it('bumps manual attempt IDs and ignores stale attempt completions', () =>
  {
    const owner = target()
    const first = claimManualProposalGenerationStart(owner, null)
    expect(first?.attemptId).toBe(1)
    expect(failProposalGenerationStart(first!, 'start failed')).toBe(true)

    const retry = claimManualProposalGenerationStart(owner, null)
    expect(retry?.attemptId).toBe(2)
    expect(completeProposalGenerationStart(first!, generation('generation-stale'))).toBe(false)
    expect(completeProposalGenerationStart(retry!, generation('generation-current'))).toBe(true)
    expect(readProposalGenerationStartState(owner)).toMatchObject({
      status: 'started',
      attemptId: 2,
      generation: { generationId: 'generation-current' },
    })
  })

  it('tombstones observed terminal generations without superseding newer attempts', () =>
  {
    const owner = target()
    const terminal = generation('generation-terminal', 'abandoned', 'server-restarted')
    const terminalMessage =
      'The server restarted before architecture analysis finished. Retry to start a new analysis.'
    expect(recordObservedProposalGenerationFailure(owner, 0, terminal, terminalMessage)).toBe(true)
    const observed = readProposalGenerationStartState(owner)

    expect(observed).toMatchObject({
      status: 'failed',
      attemptId: 0,
      generation: { generationId: 'generation-terminal' },
    })
    const retry = claimManualProposalGenerationStart(owner, terminal)!
    expect(
      recordObservedProposalGenerationFailure(owner, 0, terminal, 'stale terminal failure'),
    ).toBe(false)
    expect(readProposalGenerationStartState(owner)).toMatchObject({
      status: 'starting',
      attemptId: retry.attemptId,
    })

    const currentGeneration = generation('generation-current')
    expect(completeProposalGenerationStart(retry, currentGeneration)).toBe(true)
    const started = readProposalGenerationStartState(owner)
    expect(
      recordObservedProposalGenerationFailure(
        owner,
        retry.attemptId,
        terminal,
        'stale terminal failure',
      ),
    ).toBe(false)
    expect(readProposalGenerationStartState(owner)).toBe(started)

    const currentTerminal = generation('generation-current', 'failed', 'analysis-failed')
    expect(
      recordObservedProposalGenerationFailure(
        owner,
        retry.attemptId,
        currentTerminal,
        'Exact architecture analysis failed: analysis failed.',
      ),
    ).toBe(true)
    expect(readProposalGenerationStartState(owner)).toMatchObject({
      status: 'failed',
      error: 'Exact architecture analysis failed: analysis failed.',
      generation: { generationId: 'generation-current' },
      attemptId: retry.attemptId,
    })
  })

  it('persists a pre-existing terminal generation until explicit retry', () =>
  {
    const owner = target()
    const terminal = generation('generation-existing', 'failed', 'analysis-failed')

    expect(
      recordObservedProposalGenerationFailure(
        owner,
        0,
        terminal,
        'Exact architecture analysis failed: analysis failed.',
      ),
    ).toBe(true)
    expect(readProposalGenerationStartState(owner)).toMatchObject({
      status: 'failed',
      error: 'Exact architecture analysis failed: analysis failed.',
      generation: { generationId: 'generation-existing' },
      attemptId: 0,
    })
    expect(claimManualProposalGenerationStart(owner, terminal)).toMatchObject({ attemptId: 1 })
  })

  it('reconciles a lost start response with the observed restarted generation', () =>
  {
    const owner = target()
    const attempt = claimManualProposalGenerationStart(owner, null)!
    expect(failProposalGenerationStart(attempt, 'The start request lost its response.')).toBe(true)

    const restarted = generation('generation-restarted', 'abandoned', 'server-restarted')
    const restartMessage =
      'The server restarted before architecture analysis finished. Retry to start a new analysis.'
    expect(
      recordObservedProposalGenerationFailure(owner, attempt.attemptId, restarted, restartMessage),
    ).toBe(true)
    expect(readProposalGenerationStartState(owner)).toEqual({
      status: 'failed',
      error: restartMessage,
      generation: restarted,
      attemptId: attempt.attemptId,
      baselineGenerationId: null,
    })

    const retry = claimManualProposalGenerationStart(owner, restarted)!
    expect(
      recordObservedProposalGenerationFailure(owner, attempt.attemptId, restarted, restartMessage),
    ).toBe(false)
    expect(readProposalGenerationStartState(owner)).toMatchObject({
      status: 'starting',
      attemptId: retry.attemptId,
    })
  })

  it('does not attach the pre-attempt terminal generation to a failed retry', () =>
  {
    const owner = target()
    const terminal = generation('generation-existing', 'abandoned', 'server-restarted')
    recordObservedProposalGenerationFailure(
      owner,
      0,
      terminal,
      'The previous analysis stopped when the server restarted.',
    )
    const retry = claimManualProposalGenerationStart(owner, terminal)!
    expect(failProposalGenerationStart(retry, 'The retry was rejected before admission.')).toBe(
      true,
    )

    expect(
      recordObservedProposalGenerationFailure(
        owner,
        retry.attemptId,
        terminal,
        'The previous analysis stopped when the server restarted.',
      ),
    ).toBe(false)
    expect(readProposalGenerationStartState(owner)).toMatchObject({
      status: 'failed',
      error: 'The retry was rejected before admission.',
      generation: null,
      attemptId: retry.attemptId,
      baselineGenerationId: terminal.generationId,
    })
  })

  it('prefers the exact bound generation over a stale latest-generation query', () =>
  {
    const owner = target()
    const bound = generation('generation-bound', 'abandoned', 'server-restarted')
    const staleLatest = generation('generation-stale-latest', 'failed', 'analysis-failed')
    recordObservedProposalGenerationFailure(
      owner,
      0,
      bound,
      'The bound analysis stopped when the server restarted.',
    )

    expect(
      proposalGenerationStartBaselineGenerationId(
        readProposalGenerationStartState(owner),
        staleLatest,
      ),
    ).toBe(bound.generationId)
  })

  it('retains the stored baseline when the latest-generation query is unavailable', () =>
  {
    const owner = target()
    const retained = generation('generation-retained', 'failed', 'analysis-failed')
    recordObservedProposalGenerationFailure(owner, 0, retained, 'The analysis failed.')
    const retry = claimManualProposalGenerationStart(owner, null)
    failProposalGenerationStart(retry!, 'The retry was rejected before admission.')

    expect(
      proposalGenerationStartBaselineGenerationId(readProposalGenerationStartState(owner), null),
    ).toBe(retained.generationId)
  })
})
