// tests/apps/server/vcs/gitRefParse.test.ts
// verify remote-ref parse helpers

import { describe, expect, it } from '@effect/vitest'

import {
  extractBranchNameFromRemoteRef,
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from '../../../../apps/server/src/vcs/gitRefParse.ts'

describe('gitRefParse', () =>
{
  it('preserves git remote order and sorts by name length for matching', () =>
  {
    const stdout = 'origin\ncompany-fork\n'
    expect(parseRemoteNamesInGitOrder(stdout)).toEqual(['origin', 'company-fork'])
    expect(parseRemoteNames(stdout)).toEqual(['company-fork', 'origin'])
  })

  it('matches the longest remote name prefix first', () =>
  {
    const remoteNames = parseRemoteNames('origin\norigin-fork\n')
    expect(parseRemoteRefWithRemoteNames('origin-fork/feature', remoteNames)).toEqual({
      remoteRef: 'origin-fork/feature',
      remoteName: 'origin-fork',
      branchName: 'feature',
    })
  })

  it('extracts branch names from remote-tracking refs', () =>
  {
    expect(
      extractBranchNameFromRemoteRef('refs/remotes/origin/main', {
        remoteNames: ['origin'],
      }),
    ).toBe('main')
    expect(
      extractBranchNameFromRemoteRef('origin/feature/x', {
        remoteName: 'origin',
      }),
    ).toBe('feature/x')
  })
})
