// tests/apps/web/lib/favicon.test.ts
// verify privacy-safe public favicon fallback URLs

import { describe, expect, it } from 'vite-plus/test'

import { faviconUrlForOrigin } from '../../../../apps/web/src/lib/favicon'

describe('faviconUrlForOrigin', () =>
{
  it('uses only the preview origin conventional icon path', () =>
  {
    const cases = [
      ['http://localhost:3000/app', 'http://localhost:3000/favicon.ico'],
      ['http://192.168.1.20:5173/admin', 'http://192.168.1.20:5173/favicon.ico'],
      ['https://example.com/path?query=1', 'https://example.com/favicon.ico'],
      ['http://[fd00::1]:8080/', 'http://[fd00::1]:8080/favicon.ico'],
    ] as const
    for (const [url, expected] of cases)
    {
      const result = faviconUrlForOrigin(url)
      expect(result).toBe(expected)
      expect(result).not.toContain('google')
    }
    expect(faviconUrlForOrigin('ftp://example.com/icon')).toBeNull()
    expect(faviconUrlForOrigin('not a url')).toBeNull()
  })
})
