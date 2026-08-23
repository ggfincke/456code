// tests/apps/mobile/lib/modelOptions.test.ts
// verify mobile model options behavior

import { describe, expect, it } from 'vite-plus/test'

import { ProviderInstanceId, type ServerConfig } from '@t3tools/contracts'

import { buildModelOptions } from '../../../../apps/mobile/src/lib/modelOptions'

describe('mobile model options', () =>
{
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
