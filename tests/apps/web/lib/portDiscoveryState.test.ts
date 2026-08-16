// tests/apps/web/lib/portDiscoveryState.test.ts
// verify configured preview discovery payload bounds

import { CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS, PREVIEW_URL_MAX_LENGTH } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { boundConfiguredLocalServerUrls } from '../../../../apps/web/src/lib/portDiscoveryState'

describe('boundConfiguredLocalServerUrls', () =>
{
  it('filters unsafe inputs before enforcing the RPC item limit', () =>
  {
    const urls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
      (_, index) => `http://localhost:${3_000 + index}`,
    )
    urls.unshift(
      'https://example.com',
      'not a URL',
      `http://localhost/${'a'.repeat(PREVIEW_URL_MAX_LENGTH)}`,
    )

    const bounded = boundConfiguredLocalServerUrls(urls)

    expect(bounded).toHaveLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
    expect(bounded.every((url) => url.startsWith('http://localhost:'))).toBe(true)
  })

  it('deduplicates fragment variants without crowding out another server', () =>
  {
    const fragments = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:3000/docs#section-${index}`,
    )

    expect(boundConfiguredLocalServerUrls([...fragments, 'http://localhost:4000/app'])).toEqual([
      'http://localhost:3000/docs#section-0',
      'http://localhost:4000/app',
    ])
  })
})
