// tests/apps/server/provider/Layers/ClaudeCapabilitiesProbe.test.ts
// verifies Claude's no-prompt initialization and structured plan usage probe
import { ClaudeSettings } from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  mapClaudeAccountUsage,
  probeClaudeCapabilities,
} from '../../../../../apps/server/src/provider/Layers/ClaudeProvider.ts'

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings)

it('normalizes aggregate and scoped Claude usage windows', () =>
{
  const usage = mapClaudeAccountUsage(
    {
      status: 'available',
      rateLimits: {
        five_hour: { utilization: 62, resets_at: '2026-04-10T05:00:00.000Z' },
        seven_day: { utilization: 84, resets_at: '2026-04-17T00:00:00.000Z' },
        seven_day_opus: { utilization: 101, resets_at: null },
        model_scoped: [
          {
            display_name: 'Fable',
            utilization: 35,
            resets_at: '2026-04-17T00:00:00.000Z',
          },
        ],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 20,
          utilization: 20,
        },
      },
    },
    '2026-04-10T00:00:00.000Z',
  )

  assert.deepEqual(usage, {
    status: 'available',
    observedAt: '2026-04-10T00:00:00.000Z',
    windows: [
      {
        id: 'five-hour',
        label: '5h',
        usedPercent: 62,
        resetsAt: '2026-04-10T05:00:00.000Z',
      },
      {
        id: 'seven-day',
        label: 'Week',
        usedPercent: 84,
        resetsAt: '2026-04-17T00:00:00.000Z',
      },
      {
        id: 'seven-day-opus',
        label: 'Week',
        scopeLabel: 'Opus',
        usedPercent: 100,
        resetsAt: null,
      },
      {
        id: 'seven-day-model:fable',
        label: 'Week',
        scopeLabel: 'Fable',
        usedPercent: 35,
        resetsAt: '2026-04-17T00:00:00.000Z',
      },
      {
        id: 'extra-usage',
        label: 'Month',
        scopeLabel: 'Extra usage',
        usedPercent: 20,
        resetsAt: null,
      },
    ],
  })
})

it('isolates Claude capability probes without dropping workspace setting sources', () =>
{
  const abortController = new AbortController()
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: '/usr/bin/claude',
    abortController,
    environment: {
      HOME: '/home/user',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
    },
    cwd: '/workspace/project',
  })

  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.cwd, '/workspace/project')
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES])
  assert.deepEqual(options.settings, { disableAllHooks: true })
  assert.deepEqual(options.allowedTools, [])
  assert.equal(options.persistSession, false)
  assert.equal(options.pathToClaudeCodeExecutable, '/usr/bin/claude')
  assert.equal(options.abortController, abortController)
  assert.equal(options.env?.HOME, '/home/user')
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
})

it.layer(NodeServices.layer)('Claude capability probe SDK boundary', (it) =>
{
  it.effect('serializes strict no-MCP options and still resolves account capabilities', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-probe-sdk-' })
      const executablePath = path.join(tempDir, 'fake-claude.mjs')
      const invocationPath = path.join(tempDir, 'invocation.json')
      const workspaceCwd = path.join(tempDir, 'workspace')
      yield* fs.makeDirectory(workspaceCwd, { recursive: true })

      yield* fs.writeFileString(
        executablePath,
        [
          '#!/usr/bin/env node',
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          'const args = process.argv.slice(2);',
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          'const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;',
          'let mcpConfig;',
          'if (rawMcpConfig) {',
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          '  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }',
          '}',
          'const receivedTypes = [];',
          'const persistInvocation = () => writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({',
          '  args,',
          '  cwd: process.cwd(),',
          '  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,',
          '  mcpConfig,',
          '  receivedTypes,',
          '}));',
          'persistInvocation();',
          'const lines = createInterface({ input: process.stdin });',
          'lines.on("line", (line) => {',
          '  const message = JSON.parse(line);',
          '  receivedTypes.push(message.type);',
          '  persistInvocation();',
          '  if (message.type !== "control_request") return;',
          '  if (message.request?.subtype === "get_usage") {',
          '    process.stdout.write(JSON.stringify({',
          '      type: "control_response",',
          '      response: {',
          '        subtype: "success",',
          '        request_id: message.request_id,',
          '        response: {',
          '          subtype: "get_usage",',
          '          session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },',
          '          subscription_type: "pro",',
          '          rate_limits_available: true,',
          '          rate_limits: {',
          '            five_hour: { utilization: 62, resets_at: "2026-04-10T05:00:00.000Z" },',
          '            seven_day: { utilization: 84, resets_at: "2026-04-17T00:00:00.000Z" },',
          '            model_scoped: [{ display_name: "Fable", utilization: 35, resets_at: "2026-04-17T00:00:00.000Z" }],',
          '          },',
          '          behaviors: null,',
          '        },',
          '      },',
          '    }) + "\\n");',
          '    return;',
          '  }',
          '  if (message.request?.subtype !== "initialize") return;',
          '  process.stdout.write(JSON.stringify({',
          '    type: "control_response",',
          '    response: {',
          '      subtype: "success",',
          '      request_id: message.request_id,',
          '      response: {',
          '        commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          '        agents: [],',
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          '        models: [],',
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          '      },',
          '    },',
          '  }) + "\\n");',
          '});',
          'setInterval(() => {}, 1_000);',
          '',
        ].join('\n'),
      )
      yield* fs.chmod(executablePath, 0o755)

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
        },
        workspaceCwd,
      )

      assert.deepEqual(capabilities, {
        email: 'dev@example.com',
        subscriptionType: 'pro',
        tokenSource: 'oauth',
        apiProvider: undefined,
        planUsage: {
          status: 'available',
          rateLimits: {
            five_hour: {
              utilization: 62,
              resets_at: '2026-04-10T05:00:00.000Z',
            },
            seven_day: {
              utilization: 84,
              resets_at: '2026-04-17T00:00:00.000Z',
            },
            model_scoped: [
              {
                display_name: 'Fable',
                utilization: 35,
                resets_at: '2026-04-17T00:00:00.000Z',
              },
            ],
          },
        },
        slashCommands: [
          {
            name: 'review',
            description: 'Review changes',
            input: { hint: '[path]' },
          },
        ],
      })

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>
        readonly cwd: string
        readonly connectorEnv: string
        readonly mcpConfig: unknown
        readonly receivedTypes: ReadonlyArray<string>
      }
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd))
      assert.equal(invocation.connectorEnv, 'false')
      assert.equal(invocation.args.includes('--strict-mcp-config'), true)
      assert.equal(invocation.args.includes('--mcp-config'), false)
      assert.equal(invocation.mcpConfig, undefined)
      assert.deepEqual(invocation.receivedTypes, ['control_request', 'control_request'])

      assert.equal(invocation.args.includes('--setting-sources=user,project,local'), true)
      const settingsFlagIndex = invocation.args.indexOf('--settings')
      assert.notEqual(settingsFlagIndex, -1)
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? '{}') as {
        readonly disableAllHooks?: boolean
      }
      assert.equal(flagSettings.disableAllHooks, true)
    }).pipe(Effect.scoped),
  )
})
