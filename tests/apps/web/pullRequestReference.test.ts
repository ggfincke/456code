// tests/apps/web/pullRequestReference.test.ts
// verify parse pull request reference behavior

import { describe, expect, it } from 'vite-plus/test'

import { parsePullRequestReference } from '../../../apps/web/src/pullRequestReference'

describe('parsePullRequestReference', () =>
{
  it.each([
    ['https://github.com/pingdotgg/t3code/pull/42', 'https://github.com/pingdotgg/t3code/pull/42'],
    ['#42', '42'],
    ['gh pr checkout 42', '42'],
  ])('accepts %s', (input, expected) =>
  {
    expect(parsePullRequestReference(input)).toBe(expected)
  })

  it('rejects non-pull-request input', () =>
  {
    expect(parsePullRequestReference('feature/my-branch')).toBeNull()
  })
})
