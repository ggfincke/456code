// tests/packages/client-runtime/providerSkills.test.ts
// verify shared provider skill selection rules

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from '../../../packages/client-runtime/src/providerSkills.ts'

const skill = (
  name: string,
  options?: Partial<Pick<ServerProviderSkill, 'enabled' | 'userInvocable'>>,
): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: options?.enabled ?? true,
  ...(options?.userInvocable === undefined ? {} : { userInvocable: options.userInvocable }),
})

const provider = {
  instanceId: ProviderInstanceId.make('codex'),
  driver: ProviderDriverKind.make('codex'),
  enabled: true,
  installed: true,
  version: '1.0.0',
  status: 'ready',
  auth: { status: 'authenticated' },
  checkedAt: '2026-09-08T00:00:00.000Z',
  models: [],
  slashCommands: [{ name: 'global' }],
  skills: [skill('global')],
  workspaceSnapshots: [
    {
      cwd: '/workspace/project-a',
      checkedAt: '2026-09-08T00:01:00.000Z',
      slashCommands: [{ name: 'project' }],
      skills: [{ ...skill('project'), path: '/workspace/project-a/SKILL.md' }],
    },
  ],
} satisfies ServerProvider

describe('provider skill selection', () =>
{
  it('keeps the first skill name and excludes disabled or agent-only skills', () =>
  {
    const visible = getProviderSkillsForSlashMenu(
      [
        skill('Review'),
        skill('review'),
        skill('disabled', { enabled: false }),
        skill('agent', { userInvocable: false }),
      ],
      true,
    )

    expect(visible.map((entry) => entry.name)).toEqual(['Review'])
    expect(isProviderSkillUserInvocable(skill('user-only'))).toBe(true)
    expect(dedupeProviderSkillsByName([skill('Review'), skill('review')])).toHaveLength(1)
  })

  it('does not reveal a lower-priority duplicate hidden by an authoritative skill', () =>
  {
    const visible = getProviderSkillsForSlashMenu(
      [
        skill('deploy', { enabled: false }),
        skill('DEPLOY'),
        skill('release', { userInvocable: false }),
        skill('RELEASE'),
      ],
      true,
    )

    expect(visible).toEqual([])
  })

  it('removes provider commands already represented by a visible skill', () =>
  {
    expect(
      getProviderSlashCommandsForSlashMenu(
        [{ name: 'review' }, { name: 'model' }],
        [skill('Review')],
      ),
    ).toEqual([{ name: 'model' }])
  })

  it('selects an exact cwd snapshot and otherwise retains machine metadata', () =>
  {
    expect(resolveProviderSkillsForCwd(provider, '/workspace/project-a')).toEqual([
      { name: 'project', path: '/workspace/project-a/SKILL.md', enabled: true },
    ])
    expect(resolveProviderSlashCommandsForCwd(provider, '/workspace/project-a')).toEqual([
      { name: 'project' },
    ])
    expect(resolveProviderSkillsForCwd(provider, '/workspace/project-b')).toEqual(provider.skills)
    expect(resolveProviderSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands)
  })
})
