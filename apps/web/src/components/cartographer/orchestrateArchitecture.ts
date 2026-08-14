// apps/web/src/components/cartographer/orchestrateArchitecture.ts
// validates exact orchestrate proposal links and derives card strip states

import type { ProposalGeneration, ProposalOrchestratePlanLookupResult } from '@t3tools/contracts'

import type { ExplorerTarget } from '../../stores/rightPanelStore'

export type OrchestrateExplorerTarget = Extract<ExplorerTarget, { kind: 'orchestrate' }>

export function selectExactOrchestrateProposalLookup(
  result: ProposalOrchestratePlanLookupResult | null,
  target: OrchestrateExplorerTarget,
): ProposalOrchestratePlanLookupResult | null
{
  if (
    result === null ||
    result.link.sourceThreadId !== target.threadId ||
    result.link.runId !== target.runId ||
    result.link.revision !== target.revision ||
    result.proposal.sourceThreadId !== target.threadId ||
    result.proposal.proposalId !== result.link.proposalId ||
    result.revision.proposalId !== result.link.proposalId ||
    result.revision.revision !== result.link.proposalRevision ||
    result.orchestratePlan.runId !== target.runId ||
    result.orchestratePlan.revision !== target.revision
  )
  {
    return null
  }
  return result
}

export type OrchestrateArchitectureState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'no-link' }
  | { readonly kind: 'linked-no-generation' }
  | { readonly kind: 'active'; readonly generation: ProposalGeneration }
  | { readonly kind: 'ready'; readonly generation: ProposalGeneration }
  | { readonly kind: 'terminal'; readonly generation: ProposalGeneration }
  | { readonly kind: 'error'; readonly message: string }

// null is a valid settled result for both queries, so the settled flags — not the pending
// overlay — decide the null branches. keying off pending would return every three-second
// revalidation to 'pending' and flicker a stable no-link or linked-no-generation strip
export function resolveOrchestrateArchitectureState(input: {
  readonly lookup: ProposalOrchestratePlanLookupResult | null
  readonly lookupSettled: boolean
  readonly lookupError: string | null
  readonly generation: ProposalGeneration | null
  readonly generationSettled: boolean
  readonly generationError: string | null
}): OrchestrateArchitectureState
{
  if (input.lookup === null)
  {
    if (input.lookupError !== null) return { kind: 'error', message: input.lookupError }
    return input.lookupSettled ? { kind: 'no-link' } : { kind: 'pending' }
  }
  if (input.generation === null)
  {
    if (input.generationError !== null)
    {
      return { kind: 'error', message: input.generationError }
    }
    return input.generationSettled ? { kind: 'linked-no-generation' } : { kind: 'pending' }
  }
  switch (input.generation.state)
  {
    case 'queued':
    case 'preparing':
    case 'analyzing':
      return { kind: 'active', generation: input.generation }
    case 'ready':
      return { kind: 'ready', generation: input.generation }
    case 'failed':
    case 'cancelled':
    case 'abandoned':
      return { kind: 'terminal', generation: input.generation }
  }
}
