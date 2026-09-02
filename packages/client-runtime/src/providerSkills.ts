// packages/client-runtime/src/providerSkills.ts
// share provider skill selection rules across clients

import type { ServerProviderSkill, ServerProviderSlashCommand } from '@t3tools/contracts'

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[]
{
  const seenNames = new Set<string>()
  return skills.filter((skill) =>
  {
    const normalizedName = skill.name.trim().toLowerCase()
    if (seenNames.has(normalizedName))
    {
      return false
    }
    seenNames.add(normalizedName)
    return true
  })
}

export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, 'enabled' | 'userInvocable'>,
): boolean
{
  return skill.enabled && skill.userInvocable !== false
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[]
{
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills).filter(isProviderSkillUserInvocable)
    : []
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[]
{
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()))
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()))
}
