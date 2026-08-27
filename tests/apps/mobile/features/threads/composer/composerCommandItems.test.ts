// tests/apps/mobile/features/threads/composer/composerCommandItems.test.ts
// verify mobile skill discovery and insertion preserve the selected skill

import type { ServerProviderSkill } from '@t3tools/contracts'
import { detectComposerTrigger, replaceTextRange } from '@t3tools/shared/composerTrigger'
import { describe, expect, it } from 'vite-plus/test'
import {
  composerCommandReplacement,
  groupCommandItems,
  searchMobileComposerSkills,
} from '../../../../../../apps/mobile/src/features/threads/composer/composerCommandItems'

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
  })
})
