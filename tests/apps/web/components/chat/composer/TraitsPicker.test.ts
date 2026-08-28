// tests/apps/web/components/chat/composer/TraitsPicker.test.ts
// verify build traits trigger display behavior

import { describe, expect, it } from 'vite-plus/test'
import type { ProviderOptionDescriptor } from '@t3tools/contracts'
import {
  buildTraitsTriggerDisplay,
  buildUnavailableModelOptionDescriptors,
  TraitsMenuContent,
} from '../../../../../../apps/web/src/components/chat/composer/TraitsPicker'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProviderDriverKind } from '@t3tools/contracts'
import { Menu } from '../../../../../../apps/web/src/components/ui/menu'

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: 'select' }>
{
  return { id, label: id, type: 'select', options: [...options], currentValue }
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: 'boolean' }>
{
  return { id: 'fastMode', label: 'Fast Mode', type: 'boolean', currentValue }
}

const EFFORT = selectDescriptor(
  'effort',
  [
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' },
  ],
  'high',
)
const CONTEXT_WINDOW = selectDescriptor(
  'contextWindow',
  [
    { id: '200k', label: '200k' },
    { id: '1m', label: '1M' },
  ],
  '1m',
)

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>, fastModeEnabled: boolean)
{
  return buildTraitsTriggerDisplay({
    descriptors,
    primarySelectDescriptorId: 'effort',
    ultrathinkPromptControlled: false,
    fastModeEnabled,
  })
}

describe('buildTraitsTriggerDisplay', () =>
{
  it('shows saved unavailable traits read-only and restores controls with metadata', () =>
  {
    const saved = [
      { id: 'variant', value: 'high' },
      { id: 'customToggle', value: true },
    ]
    const descriptors = buildUnavailableModelOptionDescriptors(saved)
    expect(descriptors).toEqual([
      {
        id: 'variant',
        label: 'Variant',
        type: 'select',
        options: [{ id: 'high', label: 'high' }],
        currentValue: 'high',
      },
      { id: 'customToggle', label: 'Custom Toggle', type: 'boolean', currentValue: true },
    ])
    const props = {
      provider: ProviderDriverKind.make('opencode'),
      model: 'vendor/saved',
      models: [],
      prompt: '',
      onPromptChange: () =>
      {},
      onModelOptionsChange: () =>
      {},
      modelOptions: saved,
    }
    const render = (models: Parameters<typeof TraitsMenuContent>[0]['models']) =>
      renderToStaticMarkup(
        createElement(Menu, null, createElement(TraitsMenuContent, { ...props, models })),
      )
    const unavailable = render([])
    expect(unavailable).toContain('Variant')
    expect(unavailable).toContain('high')
    expect(unavailable).toContain('Custom Toggle')
    expect(unavailable).not.toContain('menuitemradio')
    const recovered = render([
      {
        slug: props.model,
        name: 'Saved',
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: 'variant',
              label: 'Variant',
              type: 'select',
              options: [
                { id: 'high', label: 'High' },
                { id: 'low', label: 'Low' },
              ],
            },
          ],
        },
      },
    ])
    expect(recovered).toContain('menuitemradio')
    expect(recovered).toContain('Low')
  })

  it('omits fast mode from the label entirely when it is off', () =>
  {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW], false)).toEqual({
      label: 'High · 1M',
      showFastModeIcon: false,
    })
  })

  it('shows the bolt instead of a text label when fast mode is on', () =>
  {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW], true)).toEqual({
      label: 'High · 1M',
      showFastModeIcon: true,
    })
  })

  it('keeps non-fastMode booleans as text labels', () =>
  {
    const thinking: Extract<ProviderOptionDescriptor, { type: 'boolean' }> = {
      id: 'thinking',
      label: 'Thinking',
      type: 'boolean',
      currentValue: true,
    }
    expect(display([EFFORT, thinking], false)).toEqual({
      label: 'High · Thinking On',
      showFastModeIcon: false,
    })
  })

  it('falls back to a text label when fast mode is the only trait', () =>
  {
    expect(display([fastModeDescriptor(true)], true)).toEqual({
      label: 'Fast',
      showFastModeIcon: false,
    })
    expect(display([fastModeDescriptor(false)], false)).toEqual({
      label: 'Normal',
      showFastModeIcon: false,
    })
  })

  it('stays blank when descriptors resolve to no label and there is no fast mode', () =>
  {
    // a select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: 'select' }> = {
      id: 'effort',
      label: 'effort',
      type: 'select',
      options: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
    }
    expect(display([unresolved], false)).toEqual({ label: '', showFastModeIcon: false })
  })

  it('still renders the prompt-controlled ultrathink label alongside the bolt', () =>
  {
    expect(
      buildTraitsTriggerDisplay({
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: 'effort',
        ultrathinkPromptControlled: true,
        fastModeEnabled: true,
      }),
    ).toEqual({ label: 'Ultrathink', showFastModeIcon: true })
  })
})
