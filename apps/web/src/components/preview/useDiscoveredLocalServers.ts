// apps/web/src/components/preview/useDiscoveredLocalServers.ts
// manage previewable server through a React hook

import type { DiscoveredLocalServer } from '@t3tools/contracts'
import { isLoopbackHost } from '@t3tools/shared/preview'
import { useMemo } from 'react'

import type { EnvironmentId } from '@t3tools/contracts'
import { resolveDiscoveredServerUrl } from '~/browser/browserTargetResolver'
import { useDiscoveredPortsState } from '~/lib/portDiscoveryState'

export interface PreviewableServer extends DiscoveredLocalServer
{
  source: 'scanner' | 'configured'
  // keep the server-side loopback url distinct from the environment-resolved
  // navigation target so verified paths survive remote environment mapping.
  requestedUrl: string
}

export interface RecentlySeenPreviewServer extends DiscoveredLocalServer
{
  source: 'recent'
  requestedUrl: string
}

interface UseDiscoveredLocalServersInput
{
  environmentId: EnvironmentId
  configuredUrls?: ReadonlyArray<string> | undefined
}

// enrich the environment-level live snapshot with matching configured urls.
export function useDiscoveredLocalServers(
  input: UseDiscoveredLocalServersInput,
): ReadonlyArray<PreviewableServer>
{
  const scannerState = useDiscoveredPortsState(input.environmentId, input.configuredUrls)

  return useMemo(
    () =>
      mergeServers({
        scanner: scannerState.servers.map((server) => ({
          ...server,
          url: resolveDiscoveredServerUrl(input.environmentId, server.url),
          requestedUrl: server.url,
        })),
        configuredUrls: input.configuredUrls ?? [],
        configuredUrlProbing: scannerState.configuredUrlProbing,
      }),
    [input.configuredUrls, input.environmentId, scannerState],
  )
}

export function mergeServers(input: {
  scanner: ReadonlyArray<DiscoveredLocalServer & { readonly requestedUrl: string }>
  configuredUrls: ReadonlyArray<string>
  configuredUrlProbing?: boolean
}): ReadonlyArray<PreviewableServer>
{
  const configuredByServer = new Map<string, { host: string; port: number; url: string }>()

  for (const url of input.configuredUrls)
  {
    const parsed = parseLocalUrl(url)
    if (!parsed) continue
    const key = canonicalKey(parsed.host, parsed.port)
    if (!configuredByServer.has(key)) configuredByServer.set(key, parsed)
  }

  const live: PreviewableServer[] = []
  for (const server of input.scanner)
  {
    const key = canonicalKey(server.host, server.port)
    const configured = configuredByServer.get(key)
    live.push({
      ...server,
      requestedUrl:
        configured && input.configuredUrlProbing === false ? configured.url : server.requestedUrl,
      source: configured ? 'configured' : 'scanner',
    })
  }

  return live.toSorted((a, b) =>
  {
    const sourceOrder: Record<PreviewableServer['source'], number> = {
      configured: 0,
      scanner: 1,
    }
    if (sourceOrder[a.source] !== sourceOrder[b.source])
    {
      return sourceOrder[a.source] - sourceOrder[b.source]
    }
    return a.port - b.port
  })
}

export function recentlySeenServers(input: {
  urls: ReadonlyArray<string>
  liveServers: ReadonlyArray<PreviewableServer>
}): ReadonlyArray<RecentlySeenPreviewServer>
{
  const seen = new Set(input.liveServers.map((server) => canonicalKey(server.host, server.port)))
  const recent: RecentlySeenPreviewServer[] = []
  for (const raw of input.urls)
  {
    const parsed = parseLocalUrl(raw)
    if (!parsed) continue
    const key = canonicalKey(parsed.host, parsed.port)
    if (seen.has(key)) continue
    seen.add(key)
    recent.push({
      ...parsed,
      requestedUrl: parsed.url,
      processName: null,
      pid: null,
      terminal: null,
      source: 'recent',
    })
  }
  return recent.slice(0, 8)
}

function canonicalKey(host: string, port: number): string
{
  const normalizedHost = host.toLowerCase()
  return `${isLoopbackHost(normalizedHost) ? 'loopback' : normalizedHost}:${port}`
}

function parseLocalUrl(raw: string): { host: string; port: number; url: string } | null
{
  try
  {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!isLoopbackHost(parsed.hostname)) return null
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === 'http:'
        ? 80
        : 443
    if (!Number.isFinite(port) || port <= 0) return null
    return { host: parsed.hostname, port, url: parsed.href }
  }
  catch
  {
    return null
  }
}
