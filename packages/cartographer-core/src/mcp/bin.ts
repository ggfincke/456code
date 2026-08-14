#!/usr/bin/env node
// packages/cartographer-core/src/mcp/bin.ts
// launches the Cartographer MCP stdio server from package-manager bin shims

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { mcpServer } from './server.js'

async function main(): Promise<void>
{
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
}

main().catch((error: unknown) =>
{
  console.error('cartographer failed to start:', error)
  process.exit(1)
})
