// apps/web/src/components/cartographer/proposalGenerationFailure.ts
// formats durable proposal generation failures for retry surfaces
import type { ProposalGeneration } from '@t3tools/contracts'

export function formatProposalGenerationFailure(generation: ProposalGeneration): string
{
  if (generation.errorCode === 'server-restarted')
  {
    return 'The server restarted before architecture analysis finished. Retry to start a new analysis.'
  }

  switch (generation.state)
  {
    case 'failed':
      return generation.errorCode
        ? `Exact architecture analysis failed: ${generation.errorCode.replaceAll('-', ' ')}.`
        : 'Exact architecture analysis failed.'
    case 'cancelled':
      return 'Exact architecture analysis was cancelled by a newer generation.'
    case 'abandoned':
      return 'Exact architecture analysis stopped before it completed.'
    default:
      return 'Exact architecture analysis is unavailable.'
  }
}
