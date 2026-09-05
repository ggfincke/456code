// tests/packages/shared/favicon.test.ts
// verify privacy-gated third-party favicon urls

import { describe, expect, it } from 'vite-plus/test'

import { faviconUrlForOrigin } from '../../../packages/shared/src/favicon.ts'

describe('faviconUrlForOrigin', () =>
{
  it.each([
    'http://localhost:3000',
    'http://192.168.1.10:8080',
    'https://box.tailnet.ts.net',
    'https://api.internal',
    'http://198.51.100.1',
    'http://[2001:db8::1]',
    'http://127.1',
    'http://0x7f000001',
    'http://127.1..',
  ])('does not disclose %s to the favicon provider', (origin) =>
  {
    expect(faviconUrlForOrigin(origin)).toBeNull()
  })

  it('preserves a public host, port, and requested size without leaking its path', () =>
  {
    expect(faviconUrlForOrigin('https://github.com:8443/private/path?secret=query', 64)).toBe(
      'https://www.google.com/s2/favicons?domain=github.com%3A8443&sz=64',
    )
  })

  it.each([null, undefined, '', 'invalid URL', 'file:///tmp/private'])(
    'rejects an invalid or unsupported origin %s',
    (origin) =>
    {
      expect(faviconUrlForOrigin(origin)).toBeNull()
    },
  )
})
