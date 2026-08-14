// apps/web/src/components/explorer/proposalSelection.ts
// selects the latest proposal within one explorer scope

import type { EnvironmentId, ProjectId, Proposal, ThreadId } from '@t3tools/contracts'

export function selectLatestScopedProposal(
  proposals: ReadonlyArray<Proposal>,
  scope: {
    readonly environmentId: EnvironmentId
    readonly projectId: ProjectId
    readonly threadId: ThreadId
  },
): Proposal | null
{
  let selected: Proposal | null = null
  for (const proposal of proposals)
  {
    if (
      proposal.environmentId !== scope.environmentId ||
      proposal.projectId !== scope.projectId ||
      proposal.sourceThreadId !== scope.threadId
    )
    {
      continue
    }
    if (
      selected === null ||
      proposal.updatedAt > selected.updatedAt ||
      (proposal.updatedAt === selected.updatedAt && proposal.proposalId < selected.proposalId)
    )
    {
      selected = proposal
    }
  }
  return selected
}
