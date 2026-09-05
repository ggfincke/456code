// tests/packages/shared/hostClassification.test.ts
// verify privacy-sensitive public favicon host classification

import { describe, expect, it } from 'vite-plus/test'

import { isPublicFaviconHost } from '../../../packages/shared/src/hostClassification.ts'

describe('isPublicFaviconHost', () =>
{
  it('allows representative globally routable hosts', () =>
  {
    for (const host of ['github.com', '8.8.8.8', '2606:4700:4700::1111'])
    {
      expect(isPublicFaviconHost(host), host).toBe(true)
    }
  })

  it('rejects private, Tailscale, special-purpose, reserved, and malformed hosts', () =>
  {
    for (const host of [
      'localhost',
      '192.168.1.10',
      '100.100.100.100',
      'box.tailnet.ts.net',
      'api.internal',
      '198.51.100.1',
      '2001:db8::1',
      '127.1..',
      'not:a:valid:ipv6',
    ])
    {
      expect(isPublicFaviconHost(host), host).toBe(false)
    }
  })
})
