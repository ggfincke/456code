// apps/server/src/mcp/toolkits/architecture/handlers.ts
// authorizes architecture tools and delegates evaluation to the query service

import { ArchitectureToolError } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'

import * as ArchitectureQueryService from '../../../cartographer/ArchitectureQueryService.ts'
import * as PlannedImpactService from '../../../architecture/PlannedImpactService.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
import { resolveActivePlanningTurnAuthority } from '../../PlanningTurnAuthority.ts'
import { ArchitectureToolkit } from './tools.ts'

type ArchitectureOperation =
  | 'architecture_blast_radius'
  | 'architecture_graph_diff'
  | 'architecture_propose_patch'
  | 'architecture_plan_impact_upsert'

const requireArchitectureCapability = Effect.fn(
  'ArchitectureToolkit.requireArchitectureCapability',
)(function* (operation: ArchitectureOperation, authorityScope: 'session' | 'active-turn')
{
  const invocation = yield* McpInvocationContext.McpInvocationContext
  if (!invocation.capabilities.has('architecture'))
  {
    return yield* new ArchitectureToolError({
      operation,
      code: 'capability-unavailable',
      detail: 'The authenticated MCP session does not grant the architecture capability.',
    })
  }
  return {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    ...(authorityScope === 'session' || invocation.activeTurnId === undefined
      ? {}
      : { activeTurnId: invocation.activeTurnId }),
  } satisfies ArchitectureQueryService.ArchitectureQueryAuthority
})

export const architectureToolkitHandlers = {
  architecture_blast_radius: (input) =>
    Effect.gen(function* ()
    {
      const authority = yield* requireArchitectureCapability('architecture_blast_radius', 'session')
      const service = yield* ArchitectureQueryService.ArchitectureQueryService
      return yield* service.blastRadius(authority, input)
    }),
  architecture_graph_diff: (input) =>
    Effect.gen(function* ()
    {
      const authority = yield* requireArchitectureCapability('architecture_graph_diff', 'session')
      const service = yield* ArchitectureQueryService.ArchitectureQueryService
      return yield* service.graphDiff(authority, input)
    }),
  architecture_propose_patch: (input) =>
    Effect.gen(function* ()
    {
      const authority = yield* requireArchitectureCapability(
        'architecture_propose_patch',
        'active-turn',
      )
      const service = yield* ArchitectureQueryService.ArchitectureQueryService
      return yield* service.proposePatch(authority, input)
    }),
  architecture_plan_impact_upsert: (input) =>
    Effect.gen(function* ()
    {
      const invocation = yield* McpInvocationContext.McpInvocationContext
      if (
        !invocation.capabilities.has('architecture') ||
        !invocation.capabilities.has('proposal')
      )
      {
        return yield* new ArchitectureToolError({
          operation: 'architecture_plan_impact_upsert',
          code: 'capability-unavailable',
          detail:
            'The authenticated MCP session must grant both architecture and proposal capabilities.',
        })
      }
      const authority = yield* resolveActivePlanningTurnAuthority({
        scope: invocation,
        ...(input.orchestratePlan === undefined ? {} : { orchestratePlan: input.orchestratePlan }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ArchitectureToolError({
              operation: 'architecture_plan_impact_upsert',
              code: cause.code,
              detail: cause.detail,
            }),
        ),
      )
      const { orchestratePlan: _orchestratePlan, ...claims } = input
      const service = yield* PlannedImpactService.PlannedImpactService
      return yield* service.upsert({
        environmentId: invocation.environmentId,
        projectId: authority.projectId,
        sourceThreadId: invocation.threadId,
        turnId: authority.turnId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
        plan: authority.plan,
        workspaceRoot: authority.workspaceRoot,
        claims,
      })
    }),
} satisfies Parameters<typeof ArchitectureToolkit.toLayer>[0]

export const ArchitectureToolkitHandlersLive = ArchitectureToolkit.toLayer(
  architectureToolkitHandlers,
)
