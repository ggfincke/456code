// apps/server/src/mcp/McpInvocationContext.ts
// tracks authenticated model context for one request
import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

export type McpCapability = 'preview' | 'proposal'

export interface McpInvocationScope
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly providerSessionId: string
  readonly providerInstanceId: ProviderInstanceId
  readonly activeTurnId?: TurnId
  readonly capabilities: ReadonlySet<McpCapability>
  readonly issuedAt: number
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()('456code/mcp/McpInvocationContext')
{}

export const requireMcpCapability = Effect.fn('mcp.requireCapability')(function* (
  capability: McpCapability,
)
{
  const invocation = yield* McpInvocationContext
  if (!invocation.capabilities.has(capability))
  {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    })
  }
  return invocation
})
