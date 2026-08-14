// apps/server/src/mcp/McpProviderSession.ts
// define mcp provider session config

import type { EnvironmentId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'

export interface McpProviderSessionConfig
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly providerSessionId: string
  readonly providerInstanceId: ProviderInstanceId
  readonly providerSessionGeneration: number
  readonly endpoint: string
  readonly authorizationHeader: string
}
