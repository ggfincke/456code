// tests/apps/web/components/explorer/ConnectedExplorerPanel.test.ts
// verifies Proposal Review discovery and exact target scoping
import {
  ThreadId,
  type ArchitectureImpactProjectionResult,
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

  it('accepts only the matching verified proposal projection identity', () =>
  {
    const threadId = ThreadId.make('thread-exact-proposal-source')
    const generationId = 'generation-exact-proposal-source' as ProposalGenerationId
    const baseGraphDigest = `sha256:${'a'.repeat(64)}` as const
    const headGraphDigest = `sha256:${'b'.repeat(64)}` as const
    const result = {
      projection: {
        source: {
          kind: 'verified-proposal-impact',
          threadId,
          generationId,
          baseGraphDigest,
          headGraphDigest,
        },
      },
    } as unknown as ArchitectureImpactProjectionResult

    expect(selectExactProposalDiffSources(null, { generationId, threadId })).toBeNull()
    expect(
      selectExactProposalDiffSources(result, {
        generationId: 'different-generation' as ProposalGenerationId,
        threadId,
      }),
    ).toBeNull()
    expect(selectExactProposalDiffSources(result, { generationId, threadId })).toEqual({
      beforeSource: {
        kind: 'proposal-generation',
        threadId,
        generationId,
        side: 'base',
        graphDigest: baseGraphDigest,
      },
      proposedSource: {
        kind: 'proposal-generation',
        threadId,
        generationId,
        side: 'proposed',
        graphDigest: headGraphDigest,
      },
    })
  })
})
