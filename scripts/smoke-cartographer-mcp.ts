// scripts/smoke-cartographer-mcp.ts
// verify the built Cartographer MCP server exposes its public tool set

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Standalone Node smoke uses stdio and a bounded process timeout.
import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeReadline from 'node:readline'
import * as NodeTimers from 'node:timers'
import * as NodeURL from 'node:url'

const expectedTools = [
  'graph_repo',
  'graph_diff',
  'list_snapshots',
  'blast_radius',
  'annotate_files',
  'propose_patch',
  'get_patch',
  'list_patches',
] as const

const repoRoot = NodeURL.fileURLToPath(new URL('..', import.meta.url))
const executablePath =
  NodeProcess.argv[2] ??
  NodeURL.fileURLToPath(new URL('../packages/cartographer-core/dist/mcp/bin.js', import.meta.url))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function waitForCleanExit(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
): Promise<void>
{
  if (child.exitCode !== null)
  {
    NodeAssert.equal(child.exitCode, 0, 'Cartographer MCP server exited unsuccessfully')
    return
  }

  await new Promise<void>((resolve, reject) =>
  {
    const timeout = NodeTimers.setTimeout(() =>
    {
      child.kill('SIGTERM')
      reject(new Error('Cartographer MCP server did not close after stdin ended'))
    }, 5_000)

    child.once('error', (error) =>
    {
      NodeTimers.clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) =>
    {
      NodeTimers.clearTimeout(timeout)
      if (signal !== null)
      {
        reject(new Error(`Cartographer MCP server exited on signal ${signal}`))
        return
      }
      if (code !== 0)
      {
        reject(new Error(`Cartographer MCP server exited with code ${code}`))
        return
      }
      resolve()
    })
  })
}

async function main(): Promise<void>
{
  const child = NodeChildProcess.spawn(NodeProcess.execPath, [executablePath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))

  const stdout = NodeReadline.createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  const lines = stdout[Symbol.asyncIterator]()

  const send = (message: Record<string, unknown>): void =>
  {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  const readResponse = async (expectedId: number): Promise<Record<string, unknown>> =>
  {
    while (true)
    {
      const line = await lines.next()
      if (line.done)
      {
        throw new Error(
          `Cartographer MCP server closed before response ${expectedId}: ${stderr.join('').trim()}`,
        )
      }
      if (line.value.trim() === '')
      {
        continue
      }
      const message: unknown = JSON.parse(line.value)
      if (!isRecord(message) || message.id !== expectedId)
      {
        continue
      }
      if ('error' in message)
      {
        throw new Error(`MCP request ${expectedId} failed: ${JSON.stringify(message.error)}`)
      }
      return message
    }
  }

  try
  {
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: '456code-cartographer-smoke', version: '1.0.0' },
      },
    })
    const initializeResponse = await readResponse(1)
    NodeAssert.ok(isRecord(initializeResponse.result), 'initialize returned no result')

    send({ method: 'notifications/initialized', params: {} })
    send({ id: 2, method: 'tools/list', params: {} })
    const toolsResponse = await readResponse(2)
    NodeAssert.ok(isRecord(toolsResponse.result), 'tools/list returned no result')
    NodeAssert.ok(Array.isArray(toolsResponse.result.tools), 'tools/list returned no tools')

    const names = toolsResponse.result.tools.map((tool) =>
    {
      NodeAssert.ok(
        isRecord(tool) && typeof tool.name === 'string',
        'tools/list returned a bad tool',
      )
      return tool.name
    })
    NodeAssert.deepEqual(names, expectedTools)

    child.stdin.end()
    await waitForCleanExit(child)
    NodeProcess.stdout.write(`Cartographer MCP smoke passed (${names.length} tools).\n`)
  }
  finally
  {
    stdout.close()
    if (child.exitCode === null && child.signalCode === null)
    {
      child.kill('SIGTERM')
    }
  }
}

main().catch((error: unknown) =>
{
  NodeProcess.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  NodeProcess.exit(1)
})
