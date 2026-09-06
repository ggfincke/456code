// tests/apps/web/onboarding/providerReadiness.logic.test.ts
// verifies native onboarding commands and repository grouping

import {
  DEFAULT_SERVER_SETTINGS,
  type ImportScanCandidate,
  ProviderInstanceId,
  type ServerProvider,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from '../../../../apps/web/src/onboarding/providerReadiness.logic.ts'
import {
  groupOnboardingImportCandidates,
  recentOnboardingImportCandidateKeys,
} from '../../../../apps/web/src/onboarding/projectImport.logic.ts'

function candidate(
  sourcePath: string,
  cwd: string,
  canonicalKey: string | null,
): ImportScanCandidate
{
  return {
    source: 'codex-cli',
    sourcePath,
    providerInstanceIds: [ProviderInstanceId.make('codex')],
    nativeSessionId: null,
    title: null,
    cwd,
    gitBranch: null,
    model: null,
    messageCount: 1,
    modifiedAt: '2026-09-09T12:00:00.000Z',
    alreadyImportedThreadId: null,
    alreadyImportedProviderInstanceId: null,
    alreadyImportedArchived: false,
    matchedProjectId: null,
    repositoryIdentity:
      canonicalKey === null
        ? null
        : {
            canonicalKey,
            locator: {
              source: 'git-remote',
              remoteName: 'origin',
              remoteUrl: `https://${canonicalKey}`,
            },
            displayName: 'example/project',
          },
    resumable: false,
  }
}

describe('onboarding provider setup', () =>
{
  it('uses official standalone installers without Node or npm', () =>
  {
    expect(resolveOnboardingProviderInstallCommand('claudeAgent', 'darwin')).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    )
    expect(resolveOnboardingProviderInstallCommand('codex', 'windows')).toBe(
      'irm https://chatgpt.com/codex/install.ps1 | iex',
    )
  })

  it('quotes a configured provider binary before preparing sign-in', () =>
  {
    const provider = {
      driver: 'codex',
      instanceId: ProviderInstanceId.make('codex'),
    } as ServerProvider
    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              binaryPath: '/Applications/Codex Preview/bin/codex',
            },
          },
        },
        'darwin',
      ),
    ).toBe("'/Applications/Codex Preview/bin/codex' login")
  })
})

describe('onboarding imports', () =>
{
  it('groups clones by repository while retaining standalone directories', () =>
  {
    const candidates = [
      candidate('/one.jsonl', '/work/one', 'github.com/example/project'),
      candidate('/two.jsonl', '/work/two', 'github.com/example/project'),
      candidate('/three.jsonl', '/work/notes', null),
    ]
    const groups = groupOnboardingImportCandidates(candidates)

    expect(groups).toHaveLength(2)
    expect(groups.find((group) => group.key.startsWith('repository:'))?.candidates).toHaveLength(2)
    expect(recentOnboardingImportCandidateKeys(candidates)).toEqual(
      new Set(['codex-cli\0/one.jsonl', 'codex-cli\0/two.jsonl', 'codex-cli\0/three.jsonl']),
    )
  })
})
