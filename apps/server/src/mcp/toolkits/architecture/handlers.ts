// apps/server/src/mcp/toolkits/architecture/handlers.ts
// authorizes architecture tools and delegates evaluation to the query service

import { ArchitectureToolError } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'

import * as ArchitectureQueryService from '../../../cartographer/ArchitectureQueryService.ts'
import * as McpInvocationContext from '../../McpInvocationContext.ts'
import { ArchitectureToolkit } from './tools.ts'

type ArchitectureOperation =
  'architecture_blast_radius' | 'architecture_graph_diff' | 'architecture_propose_patch'

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
} satisfies Parameters<typeof ArchitectureToolkit.toLayer>[0]

export const ArchitectureToolkitHandlersLive = ArchitectureToolkit.toLayer(
  architectureToolkitHandlers,
)
