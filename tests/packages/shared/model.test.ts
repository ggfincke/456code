// tests/packages/shared/model.test.ts
// verify descriptor helpers behavior

import { describe, expect, it } from 'vite-plus/test'
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from '@t3tools/contracts'

import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  readCustomModelEntries,
} from '../../../packages/shared/src/model.ts'

it('retains legacy slug storage while applying only matching validated custom metadata', () =>
{
  const options = {
    optionDescriptors: [{ id: 'fastMode', label: 'Fast mode', type: 'boolean' as const }],
  }
  const slugs = ['legacy', 'custom', 'custom']
  expect(
    readCustomModelEntries(slugs, {
      custom: { name: 'Private model', capabilities: options },
      orphan: { name: 'Removed model', capabilities: options },
    }),
  ).toEqual([
    { slug: 'legacy', name: 'legacy', capabilities: null },
    { slug: 'custom', name: 'Private model', capabilities: createModelCapabilities(options) },
  ])
  expect(slugs).toEqual(['legacy', 'custom', 'custom'])
})

it('preserves extended Claude slash commands without treating absolute paths as commands', () =>
{
  for (const command of ['/compact', '/plugin:review changes', '/deploy.prod staging'])
  {
    expect(applyClaudePromptEffortPrefix(command, 'ultrathink')).toBe(command)
    expect(applyClaudePromptEffortPrefix(command, 'ultrathink', false)).toBe(
      `Ultrathink:\n${command}`,
    )
  }
  expect(applyClaudePromptEffortPrefix('/home/user/file.ts', 'ultrathink')).toBe(
    'Ultrathink:\n/home/user/file.ts',
  )
  expect(applyClaudePromptEffortPrefix('Review changes', 'ultrathink')).toBe(
    'Ultrathink:\nReview changes',
  )
})

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: 'reasoningEffort',
      label: 'Reasoning',
      type: 'select',
      options: [
        { id: 'xhigh', label: 'Extra High' },
        { id: 'high', label: 'High', isDefault: true },
      ],
      currentValue: 'high',
    },
    {
      id: 'fastMode',
      label: 'Fast Mode',
      type: 'boolean',
    },
  ],
})

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: 'effort',
      label: 'Reasoning',
      type: 'select',
      options: [
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High', isDefault: true },
        { id: 'ultrathink', label: 'Ultrathink' },
      ],
      currentValue: 'high',
      promptInjectedValues: ['ultrathink'],
    },
    {
      id: 'contextWindow',
      label: 'Context Window',
      type: 'select',
      options: [
        { id: '200k', label: '200k' },
        { id: '1m', label: '1M', isDefault: true },
      ],
      currentValue: '1m',
    },
  ],
})

describe('descriptor helpers', () =>
{
  it('applies, wires, and reads typed option selection values', () =>
  {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: 'effort', value: 'medium' },
          { id: 'contextWindow', value: '200k' },
        ],
      }),
    ).toEqual([
      {
        id: 'effort',
        label: 'Reasoning',
        type: 'select',
        options: [
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High', isDefault: true },
          { id: 'ultrathink', label: 'Ultrathink' },
        ],
        currentValue: 'medium',
        promptInjectedValues: ['ultrathink'],
      },
      {
        id: 'contextWindow',
        label: 'Context Window',
        type: 'select',
        options: [
          { id: '200k', label: '200k' },
          { id: '1m', label: '1M', isDefault: true },
        ],
        currentValue: '200k',
      },
    ])

    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: 'reasoningEffort', value: 'high' },
        { id: 'fastMode', value: true },
      ],
    })
    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: 'reasoningEffort', value: 'high' },
      { id: 'fastMode', value: true },
    ])

    const selection = createModelSelection(ProviderInstanceId.make('codex'), 'gpt-5.4', [
      { id: 'reasoningEffort', value: 'high' },
      { id: 'fastMode', value: true },
    ])
    expect(getProviderOptionStringSelectionValue(selection.options, 'reasoningEffort')).toBe('high')
    expect(getProviderOptionStringSelectionValue(selection.options, 'fastMode')).toBeUndefined()
    expect(getProviderOptionBooleanSelectionValue(selection.options, 'fastMode')).toBe(true)
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, 'reasoningEffort'),
    ).toBeUndefined()
    expect(getModelSelectionStringOptionValue(selection, 'reasoningEffort')).toBe('high')
    expect(getModelSelectionBooleanOptionValue(selection, 'fastMode')).toBe(true)
  })
})

describe('model slug normalization', () =>
{
  it('preserves exact custom slugs instead of expanding provider aliases', () =>
  {
    const claude = ProviderDriverKind.make('claudeAgent')

    expect(normalizeModelSlug('opus', claude)).toBe('claude-opus-5')
    expect(normalizeCustomModelSlug(' opus ')).toBe('opus')
  })
})
