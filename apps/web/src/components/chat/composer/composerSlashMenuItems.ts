// apps/web/src/components/chat/composer/composerSlashMenuItems.ts
// expose composer skill insertion text

import type {
  ProviderDriverKind,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from '@t3tools/contracts'
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from '@t3tools/client-runtime/providerSkills'

import { formatProviderSkillDisplayName } from '../../../providerSkillPresentation'
import { searchProviderSkills } from '../../../providerSkillSearch'
import type { ComposerCommandItem } from './ComposerCommandMenu'
import { searchSlashCommandItems } from './composerSlashCommandSearch'

// insertion text when a skill is picked from the `/` or `$` menu.
export function composerSkillInsertionText(skillName: string): string
{
  return `$${skillName} `
}

// build `/` menu items: built-ins + provider slash commands + skills.
// provider commands whose names collide with a visible skill are omitted
// so Claude dual-surfaced skills appear once under Skills (`$name` chips).
export function buildComposerSlashMenuItems(input: {
  provider: ProviderDriverKind
  query: string
  showProviderSlashCommands: boolean
  builtInItems: ReadonlyArray<Extract<ComposerCommandItem, { type: 'slash-command' }>>
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>
  skills: ReadonlyArray<ServerProviderSkill>
}): ComposerCommandItem[]
{
  const visibleSkills = getProviderSkillsForSlashMenu(input.skills, true)
  const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
    input.showProviderSlashCommands ? input.slashCommands : [],
    visibleSkills,
  ).map((command) => ({
    id: `provider-slash-command:${input.provider}:${command.name}`,
    type: 'provider-slash-command' as const,
    provider: input.provider,
    command,
    label: `/${command.name}`,
    description: command.description ?? command.input?.hint ?? 'Run provider command',
  }))

  const slashCommandItems = [...input.builtInItems, ...providerSlashCommandItems]
  const skillItems = searchProviderSkills(visibleSkills, input.query).map((skill) => ({
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
