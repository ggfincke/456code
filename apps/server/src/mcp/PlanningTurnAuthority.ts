// apps/server/src/mcp/PlanningTurnAuthority.ts
// resolves one authenticated active Plan or exact Orchestrate revision

import {
  normalizeCollaborationMode,
  type ArchitecturePlanImpactOrchestrateTarget,
  type ArchitecturePlannedImpactPlanIdentity,
  type OrchestrationProposedPlanId,
  type ProjectId,
  type TurnId,
} from '@t3tools/contracts'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { proposedPlanIdForTurn } from '../orchestration/proposedPlanIdentity.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import type { McpInvocationScope } from './McpInvocationContext.ts'

export class PlanningTurnAuthorityError extends Data.TaggedError('PlanningTurnAuthorityError')<{
  readonly code: 'identity-mismatch' | 'not-found' | 'persistence-failed'
  readonly detail: string
}>
{}

export interface ActivePlanningTurnAuthority
{
  readonly projectId: ProjectId
  readonly turnId: TurnId
  readonly workspaceRoot: string
  readonly plan: ArchitecturePlannedImpactPlanIdentity
  readonly planId?: OrchestrationProposedPlanId
  readonly orchestratePlan?: ArchitecturePlanImpactOrchestrateTarget & {
    readonly turnId: TurnId
  }
}

const authorityError = (
  code: PlanningTurnAuthorityError['code'],
  detail: string,
): PlanningTurnAuthorityError => new PlanningTurnAuthorityError({ code, detail })

export const resolveActivePlanningTurnAuthority = Effect.fn('PlanningTurnAuthority.resolveActive')(
  function* (input: {
    readonly scope: McpInvocationScope
    readonly orchestratePlan?: ArchitecturePlanImpactOrchestrateTarget
  })
  {
    if (input.scope.activeTurnId === undefined)
    {
      return yield* authorityError(
        'identity-mismatch',
        'The authenticated MCP session is not bound to an active provider turn.',
      )
    }

    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
    const threadOption = yield* snapshots
      .getThreadDetailById(input.scope.threadId)
      .pipe(
        Effect.mapError(() =>
          authorityError(
            'persistence-failed',
            'The authenticated source thread could not be resolved.',
          ),
        ),
      )
    if (Option.isNone(threadOption))
    {
      return yield* authorityError('not-found', 'The authenticated source thread is not active.')
    }
    const thread = threadOption.value
    if (
      thread.session?.status !== 'running' ||
      thread.session.activeTurnId !== input.scope.activeTurnId ||
      thread.latestTurn?.state !== 'running' ||
      thread.latestTurn.turnId !== input.scope.activeTurnId
    )
    {
      return yield* authorityError(
        'identity-mismatch',
        "The authenticated MCP turn does not match the thread's active projected turn.",
      )
    }

    const collaborationMode = normalizeCollaborationMode(thread.interactionMode, thread.orchestrate)
    const isPlanMode = collaborationMode.baseMode === 'plan'
    const isOrchestrateMode =
      collaborationMode.baseMode === 'default' && collaborationMode.orchestrate
    if (!isPlanMode && !isOrchestrateMode)
    {
      return yield* authorityError(
        'identity-mismatch',
        'Planning metadata requires an authenticated Plan or Orchestrate turn.',
      )
    }
    if (isPlanMode && input.orchestratePlan !== undefined)
    {
      return yield* authorityError(
        'identity-mismatch',
        'Plan-mode metadata cannot target an Orchestrate plan revision.',
      )
    }
    if (isOrchestrateMode && input.orchestratePlan === undefined)
    {
      return yield* authorityError(
        'identity-mismatch',
        'Orchestrate-mode metadata requires an exact Orchestrate plan revision.',
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
    if (isOrchestrateMode && orchestratePlan === undefined)
    {
      return yield* authorityError(
        'not-found',
        'The exact projected Orchestrate plan revision does not exist.',
      )
    }
    if (
      orchestratePlan !== undefined &&
      (orchestratePlan.turnId !== input.scope.activeTurnId || orchestratePlan.source !== 'tool')
    )
    {
      return yield* authorityError(
        'identity-mismatch',
        'The Orchestrate plan revision must be tool-sourced from the active turn.',
      )
    }

    const projectOption = yield* snapshots
      .getProjectShellById(thread.projectId)
      .pipe(
        Effect.mapError(() =>
          authorityError(
            'persistence-failed',
            'The authenticated source project could not be resolved.',
          ),
        ),
      )
    if (Option.isNone(projectOption))
    {
      return yield* authorityError('not-found', 'The authenticated source project is not active.')
    }

    if (isPlanMode)
    {
      const planId = proposedPlanIdForTurn(input.scope.threadId, input.scope.activeTurnId)
      return {
        projectId: thread.projectId,
        turnId: input.scope.activeTurnId,
        workspaceRoot: thread.worktreePath ?? projectOption.value.workspaceRoot,
        plan: { _tag: 'plan', planId },
        planId,
      } satisfies ActivePlanningTurnAuthority
    }

    return {
      projectId: thread.projectId,
      turnId: input.scope.activeTurnId,
      workspaceRoot: thread.worktreePath ?? projectOption.value.workspaceRoot,
      plan: {
        _tag: 'orchestrate',
        runId: input.orchestratePlan!.runId,
        revision: input.orchestratePlan!.revision,
      },
      orchestratePlan: {
        ...input.orchestratePlan!,
        turnId: input.scope.activeTurnId,
      },
    } satisfies ActivePlanningTurnAuthority
  },
)
