// tests/apps/server/provider/opencodeRuntime.cliParsers.test.ts
// verify parse models cli output behavior

import * as NodeAssert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import {
  parseModelsCliOutput,
  parseAgentListCliOutput,
} from '../../../../apps/server/src/provider/opencodeRuntime.ts'

describe('parseModelsCliOutput', () =>
{
  it.each([
    {
      name: '1-provider',
      stdout: [
        'anthropic/claude-sonnet-4-5',
        JSON.stringify({
          id: 'claude-sonnet-4-5',
          providerID: 'anthropic',
          name: 'Claude Sonnet 4.5',
          capabilities: { temperature: true, reasoning: true, toolcall: true },
          cost: { input: 3, output: 15 },
          limit: { context: 200000, output: 8192 },
          status: 'active',
          options: {},
          headers: {},
          release_date: '2025-01-01',
          variants: { none: {}, low: {}, medium: {}, high: {} },
        }),
      ].join('\n'),
      expectedProviders: 1,
      expectedConnected: ['anthropic'],
      expectedModelCounts: { anthropic: 1 },
      expectedModel: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        expectVariants: true,
      },
    },
    {
      name: 'N-provider',
      stdout: [
        'anthropic/claude-sonnet-4-5',
        JSON.stringify({ id: 'claude-sonnet-4-5', providerID: 'anthropic', name: 'Sonnet 4.5' }),
        'anthropic/claude-haiku-4-5',
        JSON.stringify({ id: 'claude-haiku-4-5', providerID: 'anthropic', name: 'Haiku 4.5' }),
        'openai/gpt-4o',
        JSON.stringify({ id: 'gpt-4o', providerID: 'openai', name: 'GPT-4o' }),
      ].join('\n'),
      expectedProviders: 2,
      expectedConnected: ['anthropic', 'openai'],
      expectedModelCounts: { anthropic: 2, openai: 1 },
    },
  ])(
    'parses models for $name',
    ({ stdout, expectedProviders, expectedConnected, expectedModelCounts, expectedModel }) =>
    {
      const result = parseModelsCliOutput(stdout)
      NodeAssert.equal(result.providers.size, expectedProviders)
      NodeAssert.equal(result.connected.length, expectedConnected.length)
      NodeAssert.equal([...result.connected].sort().join(','), expectedConnected.join(','))

      for (const [providerId, modelCount] of Object.entries(expectedModelCounts))
      {
        const provider = result.providers.get(providerId)!
        NodeAssert.ok(provider)
        NodeAssert.equal(provider.id, providerId)
        NodeAssert.equal(provider.name, providerId)
        NodeAssert.equal(Object.keys(provider.models).length, modelCount)
      }

      if (expectedModel)
      {
        const model = result.providers.get(expectedModel.providerId)!.models[expectedModel.modelId]!
        NodeAssert.ok(model)
        NodeAssert.equal(model.id, expectedModel.modelId)
        NodeAssert.equal(model.providerID, expectedModel.providerId)
        NodeAssert.equal(model.name, expectedModel.name)
        if (expectedModel.expectVariants)
        {
          NodeAssert.ok(model.variants)
          NodeAssert.equal(model.variants!['medium'] !== undefined, true)
          NodeAssert.equal(model.capabilities?.reasoning, true)
        }
      }
    },
  )

  it('keeps a model whose compact JSON body contains a slash', () =>
  {
    const stdout = [
      'openrouter/qwen/qwen3-coder',
      JSON.stringify({
        id: 'qwen/qwen3-coder',
        providerID: 'openrouter',
        name: 'qwen3-coder',
        status: 'active',
      }),
    ].join('\n')

    const result = parseModelsCliOutput(stdout)
    NodeAssert.deepEqual(result.connected, ['openrouter'])
    NodeAssert.equal(
      result.providers.get('openrouter')?.models['qwen/qwen3-coder']?.id,
      'qwen/qwen3-coder',
    )
  })

  it('handles empty input', () =>
  {
    const result = parseModelsCliOutput('')
    NodeAssert.equal(result.providers.size, 0)
    NodeAssert.equal(result.connected.length, 0)
  })

  it('skips unparseable JSON blocks', () =>
  {
    const stdout = [
      'anthropic/claude-sonnet-4-5',
      'this is not valid json {{{',
      'anthropic/claude-haiku-4-5',
      JSON.stringify({ id: 'claude-haiku-4-5', providerID: 'anthropic', name: 'Haiku 4.5' }),
    ].join('\n')

    const result = parseModelsCliOutput(stdout)
    NodeAssert.equal(result.providers.size, 1)
    const provider = result.providers.get('anthropic')!
    NodeAssert.equal(Object.keys(provider.models).length, 1)
    NodeAssert.ok(provider.models['claude-haiku-4-5'])
  })

  it('handles Windows-style CRLF line endings', () =>
  {
    const stdout =
      'anthropic/claude-sonnet-4-5\r\n' +
      JSON.stringify({ id: 'claude-sonnet-4-5', providerID: 'anthropic', name: 'Sonnet' }) +
      '\r\n'

    const result = parseModelsCliOutput(stdout)
    NodeAssert.equal(result.providers.size, 1)
    NodeAssert.ok(result.providers.get('anthropic')!.models['claude-sonnet-4-5'])
  })
})

describe('parseAgentListCliOutput', () =>
{
  it('parses multiple agents with permissions', () =>
  {
    const nestedPermissions = [
      { permission: '*', action: 'allow', pattern: '*' },
      {
        permission: 'external_directory',
        pattern: 'C:\\Users\\test\\.local\\*',
        action: 'allow',
      },
      { permission: 'read', pattern: '*.env', action: 'ask' },
    ]
    const stdout = [
      'build (primary)',
      '  ' + JSON.stringify(nestedPermissions),
      'explore (subagent)',
      '  ' + JSON.stringify([{ permission: 'read', action: 'allow', pattern: '*' }]),
      'plan (primary)',
      '  ' + JSON.stringify([{ permission: 'edit', action: 'ask', pattern: '*.md' }]),
    ].join('\n')

    const result = parseAgentListCliOutput(stdout)
    NodeAssert.equal(result.length, 3)
    NodeAssert.equal(result[0]!.name, 'build')
    NodeAssert.equal(result[0]!.mode, 'primary')
    NodeAssert.equal(result[0]!.permission.length, 3)
    NodeAssert.equal(result[0]!.permission[2]!.action, 'ask')
    NodeAssert.equal(result[1]!.name, 'explore')
    NodeAssert.equal(result[1]!.mode, 'subagent')
    NodeAssert.equal(result[2]!.name, 'plan')
    NodeAssert.equal(result[2]!.mode, 'primary')
  })

  it('handles empty input', () =>
  {
    const result = parseAgentListCliOutput('')
    NodeAssert.equal(result.length, 0)
  })

  it('skips agents with unparseable permission JSON', () =>
  {
    const stdout = [
      'build (primary)',
      '  not valid json {',
      'explore (subagent)',
      '  ' + JSON.stringify([{ permission: 'read', action: 'allow', pattern: '*' }]),
    ].join('\n')

    const result = parseAgentListCliOutput(stdout)
    NodeAssert.equal(result.length, 1)
    NodeAssert.equal(result[0]!.name, 'explore')
  })

  it('handles agent names with spaces', () =>
  {
    const stdout = [
      'code reviewer (subagent)',
      '  ' + JSON.stringify([{ permission: 'read', action: 'allow', pattern: '*' }]),
      'my custom agent (primary)',
      '  ' + JSON.stringify([{ permission: 'edit', action: 'ask', pattern: '*.ts' }]),
    ].join('\n')

    const result = parseAgentListCliOutput(stdout)
    NodeAssert.equal(result.length, 2)
    NodeAssert.equal(result[0]!.name, 'code reviewer')
    NodeAssert.equal(result[0]!.mode, 'subagent')
    NodeAssert.equal(result[1]!.name, 'my custom agent')
    NodeAssert.equal(result[1]!.mode, 'primary')
  })

  it('marks known hidden agents', () =>
  {
    const stdout = [
      'compaction (primary)',
      '  ' + JSON.stringify([{ permission: '*', action: 'allow', pattern: '*' }]),
      'build (primary)',
      '  ' + JSON.stringify([{ permission: '*', action: 'allow', pattern: '*' }]),
    ].join('\n')

    const result = parseAgentListCliOutput(stdout)
    NodeAssert.equal(result[0]!.hidden, true)
    NodeAssert.equal(result[1]!.hidden, false)
  })
})
