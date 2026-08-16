// tests/apps/web/browser/browserFaviconLogic.test.ts
// verify canonical favicon keys and persisted-state sanitization

import { describe, expect, it } from 'vite-plus/test'

import {
  BROWSER_FAVICON_MAX_ENTRIES,
  type BrowserFaviconEntry,
  evictExcessFavicons,
  faviconKey,
  faviconStorageLocation,
  migratePersistedBrowserFaviconState,
} from '../../../../apps/web/src/browser/browserFaviconLogic'

const PNG = 'data:image/png;base64,AAAA'

const entry = (capturedAt = 0): BrowserFaviconEntry => ({ dataUrl: PNG, capturedAt })

describe('browser favicon logic', () =>
{
  it('isolates physical project and origin while canonicalizing environment hosts', () =>
  {
    expect(faviconKey('env:project', 'http://192.168.64.2:3000/app', '192.168.64.2')).toBe(
      faviconKey('env:project', 'http://localhost:3000/other', '192.168.64.2'),
    )
    expect(faviconStorageLocation('env:project', 'http://localhost:3000/', '192.168.64.2')).toEqual(
      {
        aliases: ['192.168.64.2'],
        key: faviconKey('env:project', 'http://localhost:3000/', null),
      },
    )
    const isolatedKeys = [
      faviconKey('env-a:project', 'http://localhost:3000/', null),
      faviconKey('env-b:project', 'http://localhost:3000/', null),
      faviconKey('env-a:other', 'http://localhost:3000/', null),
      faviconKey('env-a:project', 'https://localhost:3000/', null),
      faviconKey('env-a:project', 'http://localhost:5173/', null),
    ]
    expect(new Set(isolatedKeys).size).toBe(isolatedKeys.length)
    expect(faviconKey('env with spaces:project name', 'http://localhost:3000/', null)).toBe(
      'favicon:v1:["env with spaces:project name","http://localhost:3000"]',
    )
    expect(faviconKey('é'.repeat(3_000), 'http://localhost:3000/', null)).toBeNull()
  })

  it('migrates and sanitizes v1 data, then keeps only the 40 newest records', () =>
  {
    const localhostKey = faviconKey('env:project', 'http://localhost:3000/', null)!
    const aliasesKey = faviconKey('env:project', 'http://localhost:3001/', null)!
    const spacedScope = 'env with spaces:project name'
    const spacedKey = faviconKey(spacedScope, 'https://example.com/', null)!
    const structuredScope = 'structured env:project'
    const structuredKey = faviconKey(structuredScope, 'http://example.net/', null)!
    const nonCanonicalStructuredKey = `favicon:v1:${JSON.stringify([
      structuredScope,
      'http://EXAMPLE.NET',
    ])}`
    expect(
      migratePersistedBrowserFaviconState({
        byKey: {
          'env:project http://local:3000': entry(4),
          'env:project http://localhost:3000': entry(5),
          'env:project http://localhost:3001': {
            ...entry(6),
            aliases: [
              '192.168.64.2',
              '192.168.64.2',
              '192.168.64.3',
              '192.168.64.4',
              '192.168.64.5',
              '192.168.64.6',
              'Not Normalized',
            ],
          },
          'env:project http://localhost:3002': { dataUrl: 'bad', capturedAt: 7 },
          [`${spacedScope} https://EXAMPLE.COM`]: entry(7),
          [nonCanonicalStructuredKey]: entry(8),
          'env:project http://example.com/dead-path': entry(9),
          ['x'.repeat(5_000)]: entry(8),
        },
      }),
    ).toEqual({
      byKey: {
        [localhostKey]: entry(5),
        [aliasesKey]: {
          ...entry(6),
          aliases: ['192.168.64.2', '192.168.64.3', '192.168.64.4', '192.168.64.5'],
        },
        [spacedKey]: entry(7),
        [structuredKey]: entry(8),
      },
    })

    const bounded = evictExcessFavicons(
      Object.fromEntries(
        Array.from({ length: BROWSER_FAVICON_MAX_ENTRIES + 2 }, (_, index) => [
          `key-${index}`,
          entry(index),
        ]),
      ),
    )
    expect(Object.keys(bounded)).toHaveLength(BROWSER_FAVICON_MAX_ENTRIES)
    expect(bounded['key-0']).toBeUndefined()
    expect(bounded['key-1']).toBeUndefined()
  })
})
