import { describe, expect, it } from 'vite-plus/test'

import { parsePullRequestReference } from '../../../apps/web/src/pullRequestReference'

describe('parsePullRequestReference', () =>
{
  it.each([
    ['https://github.com/pingdotgg/t3code/pull/42', 'https://github.com/pingdotgg/t3code/pull/42'],
    [
      'https://dev.azure.com/acme/project/_git/t3code/pullrequest/42',
      'https://dev.azure.com/acme/project/_git/t3code/pullrequest/42',
    ],
    [
      'https://gitlab.com/group/project/-/merge_requests/42',
      'https://gitlab.com/group/project/-/merge_requests/42',
    ],
    ['#42', '42'],
    ['gh pr checkout 42', '42'],
    ['glab mr checkout 42', '42'],
    ['az repos pr checkout --id 42', '42'],
  ])('accepts %s', (input, expected) =>
  {
    expect(parsePullRequestReference(input)).toBe(expected)
  })

  it('rejects non-pull-request input', () =>
  {
    expect(parsePullRequestReference('feature/my-branch')).toBeNull()
  })
})
