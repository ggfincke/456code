// tests/apps/mobile/lib/modelOptions.test.ts
// verify mobile model options behavior

import { describe, expect, it } from 'vite-plus/test'

import { ProviderInstanceId, type ServerConfig } from '@t3tools/contracts'

import {
  buildModelMenuActions,
  buildModelOptions,
  filterModelOptions,
  groupByProvider,
  resolveNewTaskModelSelection,
} from '../../../../apps/mobile/src/lib/modelOptions'

describe('mobile model options', () =>
{
  it('resolves draft then project then sticky defaults without changing explicit routing or options', () =>
  {
    const selection = {
      instanceId: ProviderInstanceId.make('custom-instance'),
      model: 'unavailable-model',
      options: [{ id: 'reasoningEffort', value: 'xhigh' }],
    }
    const draftSelection = { ...selection, model: 'draft-model' }
    const projectDefaultSelection = { ...selection, model: 'project-model' }
    const stickySelection = { ...selection, model: 'sticky-model' }
    const config = {
      providers: [
        {
          instanceId: 'codex',
          driver: 'codex',
          enabled: true,
          installed: true,
          auth: { status: 'authenticated' },
          models: [
            { slug: 'first-model', name: 'First' },
            { slug: 'provider-default', name: 'Default', isDefault: true },
          ].map((model) => ({ isCustom: false, capabilities: null, ...model })),
        },
      ],
    } as unknown as ServerConfig
    const modelOptions = buildModelOptions(config, draftSelection)
    const input = { draftSelection, projectDefaultSelection, stickySelection, modelOptions }

    expect(resolveNewTaskModelSelection(input)).toBe(draftSelection)
    expect(resolveNewTaskModelSelection({ ...input, draftSelection: null })).toBe(
      projectDefaultSelection,
    )
    expect(
      resolveNewTaskModelSelection({
        ...input,
        draftSelection: null,
        projectDefaultSelection: null,
      }),
    ).toBe(stickySelection)
    const providerInput = {
      draftSelection: null,
      projectDefaultSelection: null,
      stickySelection: null,
      modelOptions,
    }
    expect(resolveNewTaskModelSelection(providerInput)?.model).toBe('provider-default')
    expect(
      resolveNewTaskModelSelection({ ...providerInput, modelOptions: modelOptions.slice(0, 1) })
        ?.model,
    ).toBe('first-model')
    expect(resolveNewTaskModelSelection({ ...providerInput, modelOptions: [] })).toBeNull()
    expect(modelOptions.at(-1)?.selection).toBe(draftSelection)
  })

  it('distinguishes and searches same-name OpenCode sources without changing their routing', () =>
  {
    const sources = [
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'github-copilot', label: 'GitHub Copilot' },
      { id: 'opencode', label: 'OpenCode Zen' },
    ]
    const config = {
      providers: [
        {
          instanceId: 'opencode_work',
          driver: 'opencode',
          displayName: 'OpenCode Work',
          enabled: true,
          installed: true,
          auth: { status: 'authenticated' },
          models: [
            ...sources.map((source) => ({
              slug: `${source.id}/claude-fable-5`,
              name: 'Claude Fable 5',
              subProvider: source.label,
              isCustom: false,
              capabilities: null,
            })),
            { slug: 'custom', name: 'Custom', isCustom: true, capabilities: null },
          ],
        },
      ],
    } as unknown as ServerConfig
    const selection = {
      instanceId: ProviderInstanceId.make('opencode_work'),
      model: 'github-copilot/claude-fable-5',
    }
    const options = buildModelOptions(config, selection)

    expect(options.slice(0, sources.length)).toMatchObject(
      sources.map((source) => ({
        key: `opencode_work:${source.id}/claude-fable-5`,
        label: 'Claude Fable 5',
        subtitle: source.label,
        providerLabel: 'OpenCode Work',
        selection: {
          instanceId: 'opencode_work',
          model: `${source.id}/claude-fable-5`,
        },
      })),
    )
    expect(groupByProvider(options)).toEqual([
      { providerKey: 'opencode_work', providerLabel: 'OpenCode Work', models: options },
    ])
    expect(filterModelOptions(options, 'GITHUB COPILOT').map((option) => option.selection)).toEqual(
      [selection],
    )
    expect(filterModelOptions(options, 'OpenCode Work')).toEqual(options)
    const [menu] = buildModelMenuActions(groupByProvider(options), selection)
    expect(menu?.subactions?.slice(0, sources.length)).toEqual(
      sources.map((source) => ({
        id: `model:opencode_work:${source.id}/claude-fable-5`,
        title: 'Claude Fable 5',
        subtitle: source.label,
        state: source.id === 'github-copilot' ? 'on' : undefined,
      })),
    )
    expect(options.at(-1)?.subtitle).toBe('')
    expect(menu?.subactions?.at(-1)?.subtitle).toBeUndefined()
    expect(buildModelOptions(config, { ...selection, model: 'missing' }).at(-1)?.subtitle).toBe('')
  })

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
