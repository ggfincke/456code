// apps/server/src/environment/accessHost.ts
// classify access hosts and format connection URLs

import * as NodeOS from 'node:os'

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>

export const isLoopbackHost = (host: string | undefined): boolean =>
{
  if (!host || host.length === 0)
  {
    return true
  }

  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.')
  )
}

export const isWildcardHost = (host: string | undefined): boolean =>
  host === '0.0.0.0' || host === '::' || host === '[::]'

export const formatHostForUrl = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host

const normalizeHost = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

const isIpv4Family = (family: string | number): boolean => family === 'IPv4' || family === 4

const isIpv6Family = (family: string | number): boolean => family === 'IPv6' || family === 6

export const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string =>
{
  if (!host)
  {
    return 'localhost'
  }

  if (!isWildcardHost(host))
  {
    return normalizeHost(host)
  }

  const interfaceEntries = Object.values(interfaces).flatMap((entries) => entries ?? [])
  const externalIpv4 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv4Family(entry.family),
  )
  if (externalIpv4)
  {
    return externalIpv4.address
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  )
  return externalIpv6 ? normalizeHost(externalIpv6.address) : 'localhost'
}

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): string =>
{
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces)
  return `http://${formatHostForUrl(connectionHost)}:${port}`
}

export const resolveListeningPort = (address: unknown, fallbackPort: number): number =>
{
  if (
    typeof address === 'object' &&
    address !== null &&
    'port' in address &&
    typeof address.port === 'number'
  )
  {
    return address.port
  }
  return fallbackPort
}

export const buildPairingUrl = (connectionString: string, token: string): string =>
{
  const url = new URL(connectionString)
  url.pathname = '/pair'
  url.searchParams.delete('token')
  url.hash = new URLSearchParams([['token', token]]).toString()
  return url.toString()
}
