// tests/apps/web/components/chat/composerSlashMenuItems.test.ts
// verify build composer slash menu items behavior

import { describe, expect, it } from 'vite-plus/test'
import { ProviderDriverKind, type ServerProviderSkill } from '@t3tools/contracts'

import { replaceTextRange } from '../../../../../apps/web/src/composer-logic'
import {
  buildComposerSlashMenuItems,
  composerSkillInsertionText,
} from '../../../../../apps/web/src/components/chat/composerSlashMenuItems'

function makeSkill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, 'name'>)
{
  return {
    path: `/tmp/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill
}

const builtInItems = [
  {
    id: 'slash:model',
    type: 'slash-command' as const,
    command: 'model' as const,
    label: '/model',
    description: 'Switch response model for this thread',
  },
  {
    id: 'slash:plan',
    type: 'slash-command' as const,
    command: 'plan' as const,
    label: '/plan',
    description: 'Switch this thread into plan mode',
  },
]

describe('buildComposerSlashMenuItems', () =>
{
  const claudeDriver = ProviderDriverKind.make('claudeAgent')

  it('includes skills in the / menu and omits colliding provider slash commands', () =>
  {
    const items = buildComposerSlashMenuItems({
      provider: claudeDriver,
      query: '',
      builtInItems,
      slashCommands: [
        { name: 'ui', description: 'Provider slash UI' },
        { name: 'compact', description: 'Real provider command' },
      ],
      skills: [
        makeSkill({
          name: 'ui',
          displayName: 'Ui',
          shortDescription: 'Explore, build, and refine UI.',
        }),
        makeSkill({
          name: 'frontend-design',
          displayName: 'Frontend Design',
        }),
      ],
    })

    expect(items.map((item) => item.id)).toEqual([
      'slash:model',
      'slash:plan',
      'provider-slash-command:claudeAgent:compact',
      'skill:claudeAgent:ui',
      'skill:claudeAgent:frontend-design',
    ])
    expect(items.some((item) => item.id === 'provider-slash-command:claudeAgent:ui')).toBe(false)
  })

  it('filters skills and commands by query together', () =>
  {
    const items = buildComposerSlashMenuItems({
      provider: claudeDriver,
      query: 'ui',
      builtInItems,
      slashCommands: [
        { name: 'ui', description: 'Provider slash UI' },
        { name: 'compact', description: 'Shrink context' },
      ],
      skills: [
        makeSkill({
          name: 'ui',
          displayName: 'Ui',
          shortDescription: 'Explore, build, and refine UI.',
        }),
        makeSkill({ name: 'frontend-design', displayName: 'Frontend Design' }),
      ],
    })

    expect(items.map((item) => item.id)).toEqual(['skill:claudeAgent:ui'])
  })

  it('inserts $name when selecting a skill from the slash menu', () =>
  {
    const items = buildComposerSlashMenuItems({
      provider: claudeDriver,
      query: 'ui',
      builtInItems,
      slashCommands: [{ name: 'ui' }],
      skills: [makeSkill({ name: 'ui', displayName: 'Ui' })],
    })
    const skillItem = items.find((item) => item.type === 'skill')
    expect(skillItem?.type).toBe('skill')
    if (skillItem?.type !== 'skill')
    {
      throw new Error('expected skill item')
    }

    const text = '$review-follow-up /ui'
    const rangeStart = '$review-follow-up '.length
    const replacement = composerSkillInsertionText(skillItem.skill.name)
    const result = replaceTextRange(text, rangeStart, text.length, replacement)

    expect(replacement).toBe('$ui ')
    expect(result.text).toBe('$review-follow-up $ui ')
  })
})
