// tests/packages/shared/sourceControl.test.ts
// verify source control presentation behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  isSshRemoteUrl,
  resolveChangeRequestPresentation,
} from '../../../packages/shared/src/sourceControl.ts'

describe('source control presentation', () =>
{
  it.each([
    {
      label: 'GitLab merge requests',
      kind: 'gitlab' as const,
      expected: { shortLabel: 'MR', singular: 'merge request' },
    },
    {
      label: 'GitHub pull requests',
      kind: 'github' as const,
      expected: { shortLabel: 'PR', singular: 'pull request' },
    },
    {
      label: 'Azure DevOps pull requests',
      kind: 'azure-devops' as const,
      expected: { shortLabel: 'PR', singular: 'pull request' },
    },
    {
      label: 'Bitbucket pull requests',
      kind: 'bitbucket' as const,
      expected: { shortLabel: 'PR', singular: 'pull request' },
    },
  ])('uses $label terminology', ({ kind, expected }) =>
  {
    expect(getChangeRequestTerminologyForKind(kind)).toEqual(expected)
  })

  it('falls back to generic change request copy for unknown providers', () =>
  {
    expect(
      resolveChangeRequestPresentation({ kind: 'unknown', name: 'forge', baseUrl: '' }),
    ).toEqual(
      expect.objectContaining({
        shortName: 'change request',
        longName: 'change request',
      }),
    )
  })
})

describe('detectSourceControlProviderFromRemoteUrl', () =>
{
  it('detects common source control hosts', () =>
  {
    expect(detectSourceControlProviderFromRemoteUrl('git@github.com:owner/repo.git')?.kind).toBe(
      'github',
    )
    expect(
      detectSourceControlProviderFromRemoteUrl('https://gitlab.com/group/repo.git')?.kind,
    ).toBe('gitlab')
    expect(
      detectSourceControlProviderFromRemoteUrl('https://dev.azure.com/org/project/_git/repo')?.kind,
    ).toBe('azure-devops')
    expect(
      detectSourceControlProviderFromRemoteUrl('git@bitbucket.org:workspace/repo.git')?.kind,
    ).toBe('bitbucket')
  })

  it('detects Azure DevOps SSH remotes', () =>
  {
    expect(
      detectSourceControlProviderFromRemoteUrl('git@ssh.dev.azure.com:v3/org/project/repo')?.kind,
    ).toBe('azure-devops')
    expect(
      detectSourceControlProviderFromRemoteUrl('ssh://git@ssh.dev.azure.com:22/v3/org/project/repo')
        ?.kind,
    ).toBe('azure-devops')
    expect(
      detectSourceControlProviderFromRemoteUrl('git@vs-ssh.visualstudio.com:v3/org/project/repo')
        ?.kind,
    ).toBe('azure-devops')
  })

  it('preserves ports while classifying by hostname', () =>
  {
    expect(
      detectSourceControlProviderFromRemoteUrl('https://gitlab.com:8443/group/repo.git'),
    ).toEqual({
      kind: 'gitlab',
      name: 'GitLab',
      baseUrl: 'https://gitlab.com:8443',
    })
    expect(
      detectSourceControlProviderFromRemoteUrl(
        'https://self-hosted.example.test:8443/group/repo.git',
      ),
    ).toEqual({
      kind: 'unknown',
      name: 'self-hosted.example.test:8443',
      baseUrl: 'https://self-hosted.example.test:8443',
    })
  })

  it('matches self-hosted providers only by complete DNS labels', () =>
  {
    expect(
      detectSourceControlProviderFromRemoteUrl('https://github.example.com/owner/repo.git')?.kind,
    ).toBe('github')
    expect(
      detectSourceControlProviderFromRemoteUrl('https://gitlab.example.com/group/repo.git')?.kind,
    ).toBe('gitlab')
    expect(
      detectSourceControlProviderFromRemoteUrl('https://bitbucket.example.com/workspace/repo.git')
        ?.kind,
    ).toBe('bitbucket')

    expect(
      detectSourceControlProviderFromRemoteUrl('https://notgithub.example.com/owner/repo.git')
        ?.kind,
    ).toBe('unknown')
    expect(
      detectSourceControlProviderFromRemoteUrl('https://notgitlab.example.com/group/repo.git')
        ?.kind,
    ).toBe('unknown')
    expect(
      detectSourceControlProviderFromRemoteUrl(
        'https://notbitbucket.example.com/workspace/repo.git',
      )?.kind,
    ).toBe('unknown')
  })

  it('detects SSH remotes with arbitrary SSH usernames', () =>
  {
    expect(
      detectSourceControlProviderFromRemoteUrl('gitlab@gitlab.example.com:group/project.git'),
    ).toEqual({
      kind: 'gitlab',
      name: 'GitLab Self-Hosted',
      baseUrl: 'https://gitlab.example.com',
    })
    expect(detectSourceControlProviderFromRemoteUrl('deploy@github.com:owner/repo.git')?.kind).toBe(
      'github',
    )
  })
})

describe('isSshRemoteUrl', () =>
{
  it('recognizes SCP-like and ssh protocol remotes without misclassifying other paths', () =>
  {
    expect(isSshRemoteUrl('git@github.com:owner/repo.git')).toBe(true)
    expect(isSshRemoteUrl('gitlab@gitlab.example.com:group/project.git')).toBe(true)
    expect(isSshRemoteUrl('deploy@bitbucket.org:workspace/repo.git')).toBe(true)
    expect(isSshRemoteUrl('SSH://git@gitlab.example.com/group/project.git')).toBe(true)
    expect(isSshRemoteUrl('https://gitlab.example.com/group/project.git')).toBe(false)
    expect(isSshRemoteUrl('/home/user/repos/project')).toBe(false)
    expect(isSshRemoteUrl('deploy@github.com/project/repo')).toBe(false)
  })
})
