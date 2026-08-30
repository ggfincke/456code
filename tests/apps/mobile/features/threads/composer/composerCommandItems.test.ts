// tests/apps/mobile/features/threads/composer/composerCommandItems.test.ts
// verify shared mobile menu policy, source routing, and cursor-safe insertions

import {
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerConfig,
  type ServerProvider,
  type ServerProviderSkill,
} from '@t3tools/contracts'
import { detectComposerTrigger, replaceTextRange } from '@t3tools/shared/composerTrigger'
import { describe, expect, it } from 'vite-plus/test'
import {
  composerCommandReplacement,
  buildMobileComposerCommandItems,
  groupCommandItems,
  searchMobileComposerSkills,
} from '../../../../../../apps/mobile/src/features/threads/composer/composerCommandItems'
import { buildModelOptions } from '../../../../../../apps/mobile/src/lib/modelOptions'

describe('mobile composer menu policy', () =>
{
  it('keeps feedback thread-only and preserves capability gates and skill collisions', () =>
  {
    const provider = {
      driver: 'codex',
      capabilities: {
        ...CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
        supportedInteractionModes: ['default', 'plan'],
        orchestrateInstructionDelivery: 'prompt-prefix',
        orchestrateBaseModes: ['default'],
      },
      slashCommands: [{ name: 'feedback' }, { name: 'UI' }, { name: 'disabled' }],
      skills: [
        { name: 'ui', path: '/skills/ui', enabled: true },
        { name: 'disabled', path: '/skills/disabled', enabled: false },
        { name: 'orchestrate', path: '/skills/orchestrate', enabled: true },
      ],
    } as unknown as ServerProvider
    const input = {
      trigger: detectComposerTrigger('/', 1),
      selectedProviderStatus: provider,
      modelOptions: [],
      interactionMode: { baseMode: 'default', orchestrate: false } as const,
      hasThread: false,
      pathEntries: [],
    }
    const draftItems = buildMobileComposerCommandItems(input)
    expect(draftItems.map((item) => item.id)).toEqual([
      'cmd:model',
      'cmd:plan',
      'cmd:orchestrate',
      'cmd:default',
      'pcmd:disabled',
      'skill:ui',
    ])
    expect(
      buildMobileComposerCommandItems({ ...input, hasThread: true }).map((item) => item.id),
    ).toContain('pcmd:feedback')
    expect(
      buildMobileComposerCommandItems({
        ...input,
        selectedProviderStatus: { ...provider, driver: ProviderDriverKind.make('opencode') },
      }).map((item) => item.id),
    ).toContain('pcmd:feedback')
    expect(
      buildMobileComposerCommandItems({
        ...input,
        interactionMode: { baseMode: 'plan', orchestrate: false },
      }).map((item) => item.id),
    ).not.toContain('cmd:orchestrate')
    expect(
      buildMobileComposerCommandItems({
        ...input,
        selectedProviderStatus: null,
      }).map((item) => item.id),
    ).toEqual(['cmd:model', 'cmd:default'])
  })

  it('searches model sources without changing the selected instance or model options', () =>
  {
    const selection = {
      instanceId: ProviderInstanceId.make('opencode-work'),
      model: 'github-copilot/claude',
      options: [{ id: 'reasoningEffort', value: 'high' }],
    }
    const config = {
      providers: [
        {
          instanceId: selection.instanceId,
          driver: 'opencode',
          displayName: 'OpenCode Work',
          enabled: true,
          installed: true,
          auth: { status: 'authenticated' },
          models: [
            {
              slug: selection.model,
              name: 'Claude',
              subProvider: 'GitHub Copilot',
              capabilities: null,
            },
            {
              slug: 'anthropic/claude',
              name: 'Claude',
              subProvider: 'Anthropic',
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig
    const draft = '/model github copilot'
    const items = buildMobileComposerCommandItems({
      trigger: detectComposerTrigger(draft, draft.length),
      selectedProviderStatus: config.providers[0]!,
      modelOptions: buildModelOptions(config, selection),
      interactionMode: { baseMode: 'default', orchestrate: false },
      hasThread: false,
      pathEntries: [],
    })
    expect(items).toEqual([
      {
        id: `model:opencode-work:${selection.model}`,
        type: 'model',
        selection,
        label: 'Claude',
        description: 'GitHub Copilot',
      },
    ])
  })
})

describe('mobile composer skills', () =>
{
  it('ranks enabled skills, groups them apart from commands, and inserts the selected name', () =>
  {
    const skills: ServerProviderSkill[] = [
      { name: 'building-native-ui', path: '/skills/native', enabled: true },
      { name: 'ui', displayName: 'UI design', path: '/skills/ui', enabled: true },
      { name: 'ui-disabled', path: '/skills/disabled', enabled: false },
      { name: 'backend', path: '/skills/backend', enabled: true },
    ]
    const items = searchMobileComposerSkills(skills, '$ui')
    expect(items.map((item) => item.id)).toEqual(['skill:ui', 'skill:building-native-ui'])
    const groups = groupCommandItems(
      [
        { id: 'cmd:plan', type: 'slash-command', command: 'plan', label: '/plan', description: '' },
        ...items,
      ],
      'slash-command',
    )
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['Commands', ['cmd:plan']],
      ['Skills', ['skill:ui', 'skill:building-native-ui']],
    ])
    expect(groupCommandItems(items, 'skill')[0]?.label).toBe('Skills')

    const draft = '$ui keep this context'
    const trigger = detectComposerTrigger(draft, 3)
    expect(trigger?.kind).toBe('skill')
    if (!trigger) throw new Error('expected a skill trigger')
    const selected = groups[1]!.items[0]!
    const insertion = replaceTextRange(
      draft,
      trigger.rangeStart,
      trigger.rangeEnd,
      composerCommandReplacement(selected),
    )
    expect(insertion.text).toBe('$ui  keep this context')
    expect(insertion.cursor).toBe(4)
    expect(skills[0]?.name).toBe('building-native-ui')

    const pathDraft = 'read @src keep this context'
    const pathTrigger = detectComposerTrigger(pathDraft, 9)
    if (!pathTrigger) throw new Error('expected a path trigger')
    const pathItems = buildMobileComposerCommandItems({
      trigger: pathTrigger,
      selectedProviderStatus: null,
      modelOptions: [],
      interactionMode: { baseMode: 'default', orchestrate: false },
      hasThread: false,
      pathEntries: [{ path: 'src/my file.ts', kind: 'file' }],
    })
    const pathInsertion = replaceTextRange(
      pathDraft,
      pathTrigger.rangeStart,
      pathTrigger.rangeEnd,
      composerCommandReplacement(pathItems[0]!),
    )
    expect(pathInsertion.text).toBe('read [my file.ts](src/my%20file.ts)  keep this context')
    expect(pathInsertion.text.slice(pathInsertion.cursor)).toBe(' keep this context')
  })
})
