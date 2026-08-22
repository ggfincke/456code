// apps/server/src/mcp/toolkits/proposal/handlers.ts
// derives proposal authority from MCP context and persists exact revisions

import { ProposalError, type ProposalId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'

import * as CartographerAnalyzer from '../../../cartographer/CartographerAnalyzer.ts'
import { compileSafeDocumentSource } from '../../../mdx/WorkspaceMdxDocument.ts'
import * as ProposalService from '../../../proposal/ProposalService.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
import {
  PlanningTurnAuthorityError,
  resolveActivePlanningTurnAuthority,
} from '../../PlanningTurnAuthority.ts'
import { ProposalToolkit } from './tools.ts'

function proposalError(
  operation: string,
  code: ConstructorParameters<typeof ProposalError>[0]['code'],
  detail: string,
  proposalId?: ProposalId,
): ProposalError
{
  return new ProposalError({
    operation,
    code,
    detail,
    ...(proposalId === undefined ? {} : { proposalId }),
  })
}

export const proposalToolkitHandlers = {
  proposal_preview_upsert: (input) =>
    Effect.gen(function* ()
    {
      const scope = yield* McpInvocationContext.requireMcpCapability('proposal')
      const proposals = yield* ProposalService.ProposalService
      const authority = yield* resolveActivePlanningTurnAuthority({
        scope,
        ...(input.orchestratePlan === undefined ? {} : { orchestratePlan: input.orchestratePlan }),
      }).pipe(
        Effect.mapError((cause: PlanningTurnAuthorityError) =>
          proposalError(
            'proposal_preview_upsert.resolve_plan',
            cause.code,
            cause.detail,
            input.proposalId,
          ),
        ),
      )

      if (input.narrativeMdx !== undefined)
      {
        yield* compileSafeDocumentSource({
          threadId: scope.threadId,
          relativePath: 'proposal-narrative.mdx',
          source: input.narrativeMdx,
        })
      }

      const analyzer = yield* CartographerAnalyzer.CartographerAnalyzer
      const analyzerFingerprint = yield* analyzer.identify.pipe(
        Effect.map((identity) => identity.fingerprint),
        Effect.mapError(() =>
          proposalError(
            'proposal_preview_upsert.resolve_analyzer',
            'analyzer-unavailable',
            'Exact proposal analysis is unavailable because the analyzer identity could not be resolved.',
            input.proposalId,
          ),
        ),
      )
      return yield* proposals.upsert({
        ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
        environmentId: scope.environmentId,
        projectId: authority.projectId,
        sourceThreadId: scope.threadId,
        producer: {
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        },
        cwd: authority.workspaceRoot,
        changes: input.changes,
        ...(input.narrativeMdx === undefined ? {} : { narrativeMdx: input.narrativeMdx }),
        ...(authority.planId === undefined ? {} : { planId: authority.planId }),
        ...(authority.orchestratePlan === undefined
          ? {}
          : { orchestratePlan: authority.orchestratePlan }),
        verifiedAnalyzerFingerprint: analyzerFingerprint,
      })
    }),
} satisfies Parameters<typeof ProposalToolkit.toLayer>[0]

export const ProposalToolkitHandlersLive = ProposalToolkit.toLayer(proposalToolkitHandlers)
