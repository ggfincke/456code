// tests/apps/web/lib/openPullRequestLink.test.ts
// verify open pull request link behavior

import { describe, expect, it, vi } from 'vite-plus/test'

import {
  openPullRequestLink,
  PullRequestLinkOpenError,
} from '../../../../apps/web/src/lib/openPullRequestLink'

describe('openPullRequestLink', () =>
{
  it('reports bridge failures with a safe target origin', async () =>
  {
    const cause = new Error('desktop shell unavailable')
    const targetUrl = 'https://github.com/pingdotgg/t3code/pull/123?token=secret'
    const openExternal = vi.fn(async () => Promise.reject(cause))

    const result = openPullRequestLink({ openExternal }, targetUrl)

    await expect(result).rejects.toEqual(
      new PullRequestLinkOpenError({
        targetOrigin: 'https://github.com',
        cause,
      }),
    )
    await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining('secret'))
  })
})
