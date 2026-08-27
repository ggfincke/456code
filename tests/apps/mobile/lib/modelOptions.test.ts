// tests/apps/mobile/lib/modelOptions.test.ts
// verify mobile model options behavior

import { describe, expect, it } from 'vite-plus/test'

import { ProviderInstanceId, type ServerConfig } from '@t3tools/contracts'

import {
  buildModelMenuActions,
  buildModelOptions,
  groupByProvider,
} from '../../../../apps/mobile/src/lib/modelOptions'

describe('mobile model options', () =>
{
  it('groups only explicit legacy models and retains selected legacy and missing fallback choices', () =>
  {
    const selected = { instanceId: ProviderInstanceId.make('codex'), model: 'superseded' }
    const config = {
      providers: [
        {
          instanceId: 'codex',
          driver: 'codex',
          enabled: true,
          installed: true,
          auth: { status: 'authenticated' },
          models: [
            { slug: 'superseded', name: 'Superseded', isLegacy: true },
            { slug: 'future', name: 'Future', isDefault: true },
            { slug: 'old-wire', name: 'Old wire' },
            { slug: 'custom', name: 'Custom', isCustom: true, isLegacy: true },
          ].map((model) => ({ isCustom: false, capabilities: null, ...model })),
        },
      ],
    } as unknown as ServerConfig
    const options = buildModelOptions(config, selected)
    const [menu, legacyMenu] = buildModelMenuActions(groupByProvider(options), selected)
    expect(legacyMenu?.subtitle).toBe('Superseded')
    expect(legacyMenu?.title).toBe('Codex · Legacy models')
    expect(menu?.subactions?.map((action) => action.id)).toEqual([
      'model:codex:future',
      'model:codex:old-wire',
      'model:codex:custom',
    ])
    expect(legacyMenu?.subactions).toEqual([
      { id: 'model:codex:superseded', title: 'Superseded', state: 'on' },
    ])
    expect(options.find((option) => option.key === 'codex:future')?.isDefault).toBe(true)
    const fallback = { ...selected, model: 'missing-older-model' }
    const [fallbackMenu] = buildModelMenuActions(
      groupByProvider(buildModelOptions(null, fallback)),
      fallback,
    )
    expect(fallbackMenu?.subactions).toEqual([
      { id: 'model:codex:missing-older-model', title: 'missing-older-model', state: 'on' },
    ])
  })

  it('labels Antigravity as experimental and preserves its reported capabilities', () =>
  {
    const config = {
      providers: [
        {
          instanceId: 'antigravity',
          driver: 'antigravity',
          displayName: 'Antigravity',
          enabled: true,
          installed: true,
          auth: { status: 'authenticated' },
          models: [
            {
              slug: 'default',
              name: 'Antigravity Default',
              isCustom: false,
              capabilities: {
                defaultRuntimeMode: 'auto-accept-edits',
                supportedRuntimeModes: ['auto-accept-edits', 'full-access'],
                supportedAttachmentTypes: [],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig

    const [option] = buildModelOptions(config, null)

    expect(option).toMatchObject({
      providerLabel: 'Antigravity · Experimental',
      subtitle: 'Antigravity · Experimental',
      capabilities: {
        defaultRuntimeMode: 'auto-accept-edits',
        supportedAttachmentTypes: [],
      },
    })
  })

  it('normalizes a legacy fallback selection against current capabilities', () =>
  {
    const config = {
      providers: [
        {
          instanceId: 'codex',
          driver: 'codex',
          displayName: 'Codex',
          enabled: true,
          installed: true,
          auth: { status: 'authenticated' },
          models: [
            {
              slug: 'gpt-test',
              name: 'GPT Test',
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: 'serviceTier',
                    label: 'Service Tier',
                    type: 'select',
                    options: [
                      { id: 'default', label: 'Standard', isDefault: true },
                      { id: 'priority', label: 'Fast' },
                    ],
                    currentValue: 'default',
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-test',
      options: [{ id: 'fastMode', value: true }],
    })

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe('serviceTier')
    expect(option?.selection.options).toEqual([{ id: 'serviceTier', value: 'default' }])
  })
})
