// apps/web/src/components/chat/composerSlashMenuItems.ts
// expose composer skill insertion text

import type {
  ProviderDriverKind,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from '@t3tools/contracts'

import { formatProviderSkillDisplayName } from '../../providerSkillPresentation'
import { searchProviderSkills } from '../../providerSkillSearch'
import type { ComposerCommandItem } from './ComposerCommandMenu'
import { searchSlashCommandItems } from './composerSlashCommandSearch'

// insertion text when a skill is picked from the `/` or `  menu.
export function composerSkillInsertionText(skillName: string): string
{
  return `$${skillName} `
}

function enabledSkillNames(
  skills: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'enabled'>>,
): Set<string>
{
  const names = new Set<string>()
  for (const skill of skills)
  {
    if (skill.enabled)
    {
      names.add(skill.name.toLowerCase())
    }
  }
  return names
}

// build `/` menu items: built-ins + provider slash commands + skills.
// provider commands whose names collide with an enabled skill are omitted
// so Claude dual-surfaced skills appear once under Skills (`$name` chips).
export function buildComposerSlashMenuItems(input: {
  provider: ProviderDriverKind
  query: string
  builtInItems: ReadonlyArray<Extract<ComposerCommandItem, { type: 'slash-command' }>>
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>
  skills: ReadonlyArray<ServerProviderSkill>
}): ComposerCommandItem[]
{
  const collidingNames = enabledSkillNames(input.skills)
  const providerSlashCommandItems = input.slashCommands
    .filter((command) => !collidingNames.has(command.name.toLowerCase()))
    .map((command) => ({
      id: `provider-slash-command:${input.provider}:${command.name}`,
      type: 'provider-slash-command' as const,
      provider: input.provider,
      command,
      label: `/${command.name}`,
      description: command.description ?? command.input?.hint ?? 'Run provider command',
    }))

  const slashCommandItems = [...input.builtInItems, ...providerSlashCommandItems]
  const skillItems = searchProviderSkills(input.skills, input.query).map((skill) => ({
    id: `skill:${input.provider}:${skill.name}`,
    type: 'skill' as const,
    provider: input.provider,
    skill,
    label: formatProviderSkillDisplayName(skill),
    description:
      skill.shortDescription ??
      skill.description ??
      (skill.scope ? `${skill.scope} skill` : 'Run provider skill'),
  }))

  const query = input.query.trim().toLowerCase()
  if (!query)
  {
    return [...slashCommandItems, ...skillItems]
  }

  return [...searchSlashCommandItems(slashCommandItems, query), ...skillItems]
}
