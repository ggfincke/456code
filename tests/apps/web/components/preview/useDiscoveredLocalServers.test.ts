// tests/apps/web/components/preview/useDiscoveredLocalServers.test.ts
// verify live server projection and separate preview history

import type { DiscoveredLocalServer } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  mergeServers,
  recentlySeenServers,
} from '../../../../../apps/web/src/components/preview/useDiscoveredLocalServers'

const scannerServer = (
  overrides: Partial<DiscoveredLocalServer & { requestedUrl: string }>,
): DiscoveredLocalServer & { requestedUrl: string } => ({
  host: 'localhost',
  port: 5173,
  url: 'http://localhost:5173/',
  requestedUrl: overrides.url ?? 'http://localhost:5173/',
  processName: 'vite',
  pid: 1234,
  terminal: null,
  ...overrides,
})

describe('mergeServers', () =>
{
  it('returns only server-confirmed live entries', () =>
  {
    const result = mergeServers({
      scanner: [scannerServer({})],
      configuredUrls: ['http://localhost:8080/docs'],
      configuredUrlProbing: true,
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      port: 5173,
      source: 'scanner',
      requestedUrl: 'http://localhost:5173/',
      processName: 'vite',
    })
  })

  it('matches every loopback alias and preserves verified paths', () =>
  {
    for (const host of ['127.0.0.1', '0.0.0.0', '[::1]'])
    {
      const result = mergeServers({
        scanner: [
          scannerServer({
            requestedUrl: 'http://localhost:5173/dashboard?mode=test#results',
          }),
        ],
        configuredUrls: [`http://${host}:5173/dashboard?mode=test#results`],
        configuredUrlProbing: true,
      })
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        source: 'configured',
        requestedUrl: 'http://localhost:5173/dashboard?mode=test#results',
      })
    }
  })

  it('overlays a configured path only for older TCP-only servers', () =>
  {
    const scanner = [scannerServer({ requestedUrl: 'http://localhost:5173/' })]
    const configuredUrls = ['https://localhost:5173/docs?mode=test#results']

    expect(
      mergeServers({ scanner, configuredUrls, configuredUrlProbing: false })[0]?.requestedUrl,
    ).toBe('https://localhost:5173/docs?mode=test#results')
    expect(
      mergeServers({ scanner, configuredUrls, configuredUrlProbing: true })[0]?.requestedUrl,
    ).toBe('http://localhost:5173/')
  })

  it('keeps environment-resolved navigation distinct from the requested URL', () =>
  {
    const result = mergeServers({
      scanner: [
        scannerServer({
          url: 'https://env-42.example.dev:5173/',
          requestedUrl: 'http://localhost:5173/',
        }),
      ],
      configuredUrls: [],
      configuredUrlProbing: true,
    })

    expect(result[0]?.url).toBe('https://env-42.example.dev:5173/')
    expect(result[0]?.requestedUrl).toBe('http://localhost:5173/')
  })

  it('sorts configured live servers before scanner-only servers', () =>
  {
    const result = mergeServers({
      scanner: [scannerServer({ port: 3000 }), scannerServer({ port: 8080 })],
      configuredUrls: ['http://localhost:8080'],
      configuredUrlProbing: true,
    })

    expect(result.map((server) => `${server.source}:${server.port}`)).toEqual([
      'configured:8080',
      'scanner:3000',
    ])
  })
})

describe('recentlySeenServers', () =>
{
  it('keeps local history separate and never duplicates a live server', () =>
  {
    const liveServers = mergeServers({
      scanner: [scannerServer({})],
      configuredUrls: [],
      configuredUrlProbing: true,
    })
    const recent = recentlySeenServers({
      urls: [
        'http://127.0.0.1:5173/older-path',
        'http://localhost:8080/app',
        'https://example.com',
      ],
      liveServers,
    })

    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({
      port: 8080,
      source: 'recent',
      requestedUrl: 'http://localhost:8080/app',
    })
  })
})
