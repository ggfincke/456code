// tests/apps/web/providerSkillSearch.test.ts
// verify search provider skills and install-source presentation

import { describe, expect, it } from 'vite-plus/test'

import type { ServerProviderSkill } from '@t3tools/contracts'

import { formatProviderSkillInstallSource } from '../../../apps/web/src/providerSkillPresentation'
import { searchProviderSkills } from '../../../apps/web/src/providerSkillSearch'

function makeSkill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, 'name'>)
{
  return {
    path: `/tmp/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill
}

describe('searchProviderSkills', () =>
{
  it('uses the same first-definition precedence for dollar and slash skill menus', () =>
  {
    const projectSkill = makeSkill({ name: 'Review', path: '/project/skills/review/SKILL.md' })
    const skills = [projectSkill, makeSkill({ name: 'review' }), makeSkill({ name: 'other' })]
    expect(searchProviderSkills(skills, '$review')).toEqual([projectSkill])
    expect(
      searchProviderSkills(skills, '').filter((skill) => skill.name.toLowerCase() === 'review'),
    ).toEqual([projectSkill])
  })

  it('moves exact ui matches ahead of broader ui matches', () =>
  {
    const skills = [
      makeSkill({
        name: 'agent-browser',
        displayName: 'Agent Browser',
        shortDescription: 'Browser automation CLI for AI agents',
      }),
      makeSkill({
        name: 'building-native-ui',
        displayName: 'Building Native Ui',
        shortDescription: 'Complete guide for building beautiful apps with Expo Router',
      }),
      makeSkill({
        name: 'ui',
        displayName: 'Ui',
        shortDescription: 'Explore, build, and refine UI.',
      }),
    ]

    expect(searchProviderSkills(skills, 'ui').map((skill) => skill.name)).toEqual([
      'ui',
      'building-native-ui',
    ])
  })

  it('uses fuzzy ranking for abbreviated queries', () =>
  {
    const skills = [
      makeSkill({ name: 'gh-fix-ci', displayName: 'Gh Fix Ci' }),
      makeSkill({ name: 'github', displayName: 'Github' }),
      makeSkill({ name: 'agent-browser', displayName: 'Agent Browser' }),
    ]

    expect(searchProviderSkills(skills, 'gfc').map((skill) => skill.name)).toEqual(['gh-fix-ci'])
  })

  it('omits skills the user cannot invoke', () =>
  {
    const skills = [
      makeSkill({ name: 'ui', displayName: 'Ui', enabled: false }),
      makeSkill({ name: 'private-ui', displayName: 'Private Ui', userInvocable: false }),
      makeSkill({ name: 'frontend-design', displayName: 'Frontend Design' }),
    ]

    expect(searchProviderSkills(skills, 'ui').map((skill) => skill.name)).toEqual([])
    expect(searchProviderSkills(skills, '').map((skill) => skill.name)).toEqual(['frontend-design'])
  })
})

describe('formatProviderSkillInstallSource', () =>
{
  it('marks plugin-backed skills as app installs', () =>
  {
    expect(
      formatProviderSkillInstallSource({
        path: '/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md',
        scope: 'user',
      }),
    ).toBe('App')
  })
})
