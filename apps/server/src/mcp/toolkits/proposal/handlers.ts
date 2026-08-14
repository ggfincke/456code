// apps/server/src/mcp/toolkits/proposal/handlers.ts
// derives proposal authority from MCP context and persists exact revisions

import { normalizeCollaborationMode, ProposalError, type ProposalId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { compileSafeDocumentSource } from '../../../mdx/WorkspaceMdxDocument.ts'
import { proposedPlanIdForTurn } from '../../../orchestration/proposedPlanIdentity.ts'
import * as ProjectionSnapshotQuery from '../../../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProposalService from '../../../proposal/ProposalService.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
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
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
      const proposals = yield* ProposalService.ProposalService

      if (scope.activeTurnId === undefined)
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_plan',
          'identity-mismatch',
          'The authenticated MCP session is not bound to an active provider turn.',
          input.proposalId,
        )
      }

      const threadOption = yield* snapshots
        .getThreadDetailById(scope.threadId)
        .pipe(
          Effect.mapError(() =>
            proposalError(
              'proposal_preview_upsert.resolve_thread',
              'persistence-failed',
              'The authenticated source thread could not be resolved.',
              input.proposalId,
            ),
          ),
        )
      if (Option.isNone(threadOption))
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_thread',
          'not-found',
          'The authenticated source thread is not active.',
          input.proposalId,
        )
      }
      const thread = threadOption.value
      if (
        thread.session?.status !== 'running' ||
        thread.session.activeTurnId !== scope.activeTurnId ||
        thread.latestTurn?.state !== 'running' ||
        thread.latestTurn.turnId !== scope.activeTurnId
      )
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_plan',
          'identity-mismatch',
          "The authenticated MCP turn does not match the thread's active projected turn.",
          input.proposalId,
        )
      }
      const collaborationMode = normalizeCollaborationMode(
        thread.interactionMode,
        thread.orchestrate,
      )
      const planId =
        collaborationMode.baseMode === 'plan'
          ? proposedPlanIdForTurn(scope.threadId, scope.activeTurnId)
          : undefined
      const isOrchestrateMode =
        collaborationMode.baseMode === 'default' && collaborationMode.orchestrate
      if (collaborationMode.baseMode === 'plan' && input.orchestratePlan !== undefined)
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_plan',
          'identity-mismatch',
          'Plan-mode proposal previews cannot target an orchestrate-plan revision.',
          input.proposalId,
        )
      }
      if (isOrchestrateMode && input.orchestratePlan === undefined)
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_plan',
          'identity-mismatch',
          'Orchestrate-mode proposal previews require an exact orchestrate-plan revision.',
          input.proposalId,
        )
      }
      const orchestratePlan =
        isOrchestrateMode && input.orchestratePlan !== undefined
          ? thread.orchestratePlans.find(
              (candidate) =>
                candidate.runId === input.orchestratePlan?.runId &&
                candidate.revision === input.orchestratePlan.revision,
            )
          : undefined
      if (
        isOrchestrateMode &&
        input.orchestratePlan !== undefined &&
        orchestratePlan === undefined
      )
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_plan',
          'not-found',
          'The exact projected orchestrate-plan revision does not exist.',
          input.proposalId,
        )
      }
      if (
        orchestratePlan !== undefined &&
        (orchestratePlan.turnId !== scope.activeTurnId || orchestratePlan.source !== 'tool')
      )
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_plan',
          'identity-mismatch',
          'The orchestrate-plan revision must be tool-sourced from the active turn.',
          input.proposalId,
        )
      }
      if (collaborationMode.baseMode !== 'plan' && !collaborationMode.orchestrate)
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_plan',
          'identity-mismatch',
          'Proposal previews require an authenticated plan or orchestrate turn.',
          input.proposalId,
        )
      }

      const projectOption = yield* snapshots
        .getProjectShellById(thread.projectId)
        .pipe(
          Effect.mapError(() =>
            proposalError(
              'proposal_preview_upsert.resolve_project',
              'persistence-failed',
              'The authenticated source project could not be resolved.',
              input.proposalId,
            ),
          ),
        )
      if (Option.isNone(projectOption))
      {
        return yield* proposalError(
          'proposal_preview_upsert.resolve_project',
          'not-found',
          'The authenticated source project is not active.',
          input.proposalId,
        )
      }

      if (input.narrativeMdx !== undefined)
      {
        yield* compileSafeDocumentSource({
          threadId: scope.threadId,
          relativePath: 'proposal-narrative.mdx',
          source: input.narrativeMdx,
        })
      }

      return yield* proposals.upsert({
        ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
        environmentId: scope.environmentId,
        projectId: thread.projectId,
        sourceThreadId: scope.threadId,
        producer: {
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        },
        cwd: thread.worktreePath ?? projectOption.value.workspaceRoot,
        changes: input.changes,
        ...(input.narrativeMdx === undefined ? {} : { narrativeMdx: input.narrativeMdx }),
        ...(planId === undefined ? {} : { planId }),
        ...(input.orchestratePlan === undefined
          ? {}
          : {
              orchestratePlan: {
                ...input.orchestratePlan,
                turnId: scope.activeTurnId,
              },
            }),
      })
    }),
} satisfies Parameters<typeof ProposalToolkit.toLayer>[0]

export const ProposalToolkitHandlersLive = ProposalToolkit.toLayer(proposalToolkitHandlers)
