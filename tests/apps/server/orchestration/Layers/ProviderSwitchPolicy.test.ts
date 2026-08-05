// tests/apps/server/orchestration/Layers/ProviderSwitchPolicy.test.ts
// verifies compaction-model selection against provider catalog shapes

import { ProviderDriverKind } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { resolveProviderSwitchCompactionModel } from '../../../../../apps/server/src/orchestration/Layers/ProviderSwitchPolicy.ts'

describe('resolveProviderSwitchCompactionModel', () =>
{
  it('selects the canonical Claude compaction model from the standard catalog', () =>
  {
    expect(
      resolveProviderSwitchCompactionModel({
        driverKind: ProviderDriverKind.make('claudeAgent'),
        currentModel: 'claude-opus-5',
        availableModels: ['claude-opus-5', 'claude-sonnet-5'],
      }),
    ).toBe('claude-sonnet-5')
  })

  it.each([
    {
      driverKind: ProviderDriverKind.make('grok'),
      currentModel: 'grok-build',
      availableModels: ['grok-build'],
    },
    {
      driverKind: ProviderDriverKind.make('cursor'),
      currentModel: 'auto',
      availableModels: ['auto', 'composer-2'],
    },
  ])('keeps the current model for $driverKind', (input) =>
  {
    expect(resolveProviderSwitchCompactionModel(input)).toBe(input.currentModel)
  })

  it('falls back to the current model when the candidate is absent', () =>
  {
    expect(
      resolveProviderSwitchCompactionModel({
        driverKind: ProviderDriverKind.make('claudeAgent'),
        currentModel: 'claude-opus-5',
        availableModels: ['claude-opus-5'],
      }),
    ).toBe('claude-opus-5')
  })

  it('preserves the Codex compaction candidate', () =>
  {
    expect(
      resolveProviderSwitchCompactionModel({
        driverKind: ProviderDriverKind.make('codex'),
        currentModel: 'gpt-5.6-sol',
        availableModels: ['gpt-5.6-sol', 'gpt-5.6-luna'],
      }),
    ).toBe('gpt-5.6-luna')
  })
})
