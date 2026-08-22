// tests/apps/server/http.test.ts
// verify http dev routing behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  assetResponseHeaders,
  isLoopbackHostname,
  resolveDevRedirectUrl,
  staticFileContentType,
} from '../../../apps/server/src/http.ts'

describe('http dev routing', () =>
{
  it.each([
    ['127.0.0.1', true],
    ['[::1]', true],
    ['example.local', false],
  ] as const)('isLoopbackHostname(%s) -> %s', (hostname, expected) =>
  {
    expect(isLoopbackHostname(hostname)).toBe(expected)
  })

  it('preserves path and query when redirecting to the dev server', () =>
  {
    const devUrl = new URL('http://127.0.0.1:5173/')
    const requestUrl = new URL('http://127.0.0.1:3774/pair?token=test-token')

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      'http://127.0.0.1:5173/pair?token=test-token',
    )
  })
})

describe('assetResponseHeaders', () =>
{
  it('sandboxes SVG assets', () =>
  {
    expect(assetResponseHeaders('/attachments/user-image.svg')).toMatchObject({
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; sandbox`,
      'X-Content-Type-Options': 'nosniff',
    })
    expect(assetResponseHeaders('/attachments/user-image.SVG')).toHaveProperty(
      'Content-Security-Policy',
    )
  })

  it('does not apply document policy to raster images', () =>
  {
    expect(assetResponseHeaders('/attachments/user-image.png')).toEqual({
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  it('declares utf-8 for HTML assets so non-ASCII content renders correctly', () =>
  {
    expect(assetResponseHeaders('/workspace/page.html')).toHaveProperty(
      'Content-Type',
      'text/html; charset=utf-8',
    )
    expect(assetResponseHeaders('/workspace/PAGE.HTM')).toHaveProperty(
      'Content-Type',
      'text/html; charset=utf-8',
    )
  })
})

describe('staticFileContentType', () =>
{
  it('appends utf-8 to html mime lookups', () =>
  {
    expect(staticFileContentType('/workspace/index.html')).toBe('text/html; charset=utf-8')
    expect(staticFileContentType('/workspace/INDEX.HTM')).toBe('text/html; charset=utf-8')
  })

  it('leaves non-html mime lookups untouched', () =>
  {
    expect(staticFileContentType('/workspace/logo.svg')).toBe('image/svg+xml')
    expect(staticFileContentType('/workspace/data')).toBe('application/octet-stream')
  })
})
