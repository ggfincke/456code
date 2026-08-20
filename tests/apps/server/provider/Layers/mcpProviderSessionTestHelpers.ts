// tests/apps/server/provider/Layers/mcpProviderSessionTestHelpers.ts
// builds one shared mcp launch contract for provider adapter tests

import { EnvironmentId, type ProviderInstanceId, type ThreadId } from '@t3tools/contracts'

import type { McpProviderSessionConfig } from '../../../../../apps/server/src/mcp/McpProviderSession.ts'

export const TEST_MCP_ENDPOINT = 'http://127.0.0.1:43123/mcp'
export const TEST_MCP_AUTHORIZATION = 'Bearer provider-session-test-token'

export function makeTestMcpProviderSession(
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): McpProviderSessionConfig
{
  return {
    environmentId: EnvironmentId.make('environment-provider-adapter-test'),
    threadId,
    providerSessionId: 'provider-session-adapter-test',
    providerInstanceId,
    providerSessionGeneration: 1,
    endpoint: TEST_MCP_ENDPOINT,
    authorizationHeader: TEST_MCP_AUTHORIZATION,
    previewToolsAvailable: true,
  }
}
