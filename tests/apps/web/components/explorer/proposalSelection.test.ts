// tests/apps/web/components/explorer/proposalSelection.test.ts
// verifies deterministic proposal selection stays inside explorer scope

import type { EnvironmentId, ProjectId, Proposal, ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { selectLatestScopedProposal } from '../../../../../apps/web/src/components/explorer/proposalSelection'

const environmentId = 'environment-explorer' as EnvironmentId
const projectId = 'project-explorer' as ProjectId
const threadId = 'thread-explorer' as ThreadId

function proposal(
  proposalId: string,
  updatedAt: string,
  scope: {
    readonly environmentId?: EnvironmentId
    readonly projectId?: ProjectId
    readonly threadId?: ThreadId
  } = {},
): Proposal
{
  return {
    proposalId,
    environmentId: scope.environmentId ?? environmentId,
    projectId: scope.projectId ?? projectId,
    sourceThreadId: scope.threadId ?? threadId,
    updatedAt,
  } as Proposal
}

describe('selectLatestScopedProposal', () =>
{
  it('chooses the newest deterministic proposal without crossing scope', () =>
  {
    const selected = selectLatestScopedProposal(
      [
        proposal('proposal-z', '2026-07-27T12:00:00.000Z'),
        proposal('proposal-b', '2026-07-27T13:00:00.000Z'),
        proposal('proposal-a', '2026-07-27T13:00:00.000Z'),
        proposal('proposal-newer-other-thread', '2026-07-27T14:00:00.000Z', {
          threadId: 'thread-other' as ThreadId,
        }),
      ],
      { environmentId, projectId, threadId },
    )

    expect(selected?.proposalId).toBe('proposal-a')
  })
})
