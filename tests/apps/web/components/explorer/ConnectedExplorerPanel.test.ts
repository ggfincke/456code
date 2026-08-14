// tests/apps/web/components/explorer/ConnectedExplorerPanel.test.ts
// verifies Proposal Review discovery and exact target scoping
import {
  ThreadId,
  type ArchitectureImpactResult,
  type ProposalGenerationId,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  isExplorerTargetScopedToThread,
  isProposalDiscoverySettled,
  selectExactProposalDiffSources,
} from '../../../../../apps/web/src/components/explorer/ConnectedExplorerPanel'

describe('ConnectedExplorerPanel proposal selection', () =>
{
  it('keeps a negative proposal lookup settled across polling refreshes', () =>
  {
    expect(
      isProposalDiscoverySettled({
        settledKey: 'environment:thread:plan-1',
        key: 'environment:thread:plan-1',
        settledNow: false,
      }),
    ).toBe(true)
    expect(
      isProposalDiscoverySettled({
        settledKey: 'environment:thread:plan-1',
        key: 'environment:thread:plan-2',
        settledNow: false,
      }),
    ).toBe(false)
    expect(
      isProposalDiscoverySettled({
        settledKey: null,
        key: 'environment:thread:plan-1',
        settledNow: true,
      }),
    ).toBe(true)
  })

  it('rejects an orchestrate target persisted under a different thread', () =>
  {
    const target = {
      kind: 'orchestrate' as const,
      threadId: ThreadId.make('thread-B'),
      runId: 'run-1',
      revision: 1,
    }
    expect(isExplorerTargetScopedToThread(target, ThreadId.make('thread-A'))).toBe(false)
    expect(isExplorerTargetScopedToThread(target, ThreadId.make('thread-B'))).toBe(true)
  })

  it('accepts only matching v2 proposal identities and preserves unavailable sides', () =>
  {
    const threadId = ThreadId.make('thread-exact-proposal-source')
    const generationId = 'generation-exact-proposal-source' as ProposalGenerationId
    const baseSource = {
      kind: 'proposal-generation',
      threadId,
      generationId,
      side: 'base',
      graphDigest: `sha256:${'a'.repeat(64)}`,
    } as const
    const result = {
      version: 2,
      comparison: { kind: 'proposal-generation', generationId },
      baseSource,
      headSource: {
        kind: 'diff-analysis',
        threadId,
        diffAnalysisId: 'unrelated-diff-analysis',
        side: 'head',
        graphDigest: `sha256:${'b'.repeat(64)}`,
      },
    } as unknown as ArchitectureImpactResult

    expect(selectExactProposalDiffSources(null, { generationId, threadId })).toBeNull()
    expect(
      selectExactProposalDiffSources(result, {
        generationId: 'different-generation' as ProposalGenerationId,
        threadId,
      }),
    ).toBeNull()
    expect(selectExactProposalDiffSources(result, { generationId, threadId })).toEqual({
      beforeSource: baseSource,
      proposedSource: null,
    })
  })
})
