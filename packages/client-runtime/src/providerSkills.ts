// packages/client-runtime/src/providerSkills.ts
// share provider skill selection rules across clients

import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from '@t3tools/contracts'

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

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
): NonNullable<ServerProvider['workspaceSnapshots']>[number] | undefined
{
  if (!cwd) return undefined
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider['skills']
{
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider['slashCommands']
{
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands
}
