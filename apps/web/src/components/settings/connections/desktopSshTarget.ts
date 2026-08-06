// apps/web/src/components/settings/connections/desktopSshTarget.ts
// parse and format desktop ssh connection targets

import type { DesktopSshEnvironmentTarget } from '@t3tools/contracts'

export function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string
{
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname
  return target.port ? `${authority}:${target.port}` : authority
}

export function parseManualDesktopSshTarget(input: {
  readonly host: string
  readonly username: string
  readonly port: string
}): DesktopSshEnvironmentTarget
{
  const rawHost = input.host.trim()
  if (rawHost.length === 0)
  {
    throw new Error('SSH host or alias is required.')
  }

  let hostname = rawHost
  let username = input.username.trim() || null
  let port: number | null = null

  const atIndex = hostname.lastIndexOf('@')
  if (atIndex > 0)
  {
    const inlineUsername = hostname.slice(0, atIndex).trim()
    hostname = hostname.slice(atIndex + 1).trim()
    if (!username && inlineUsername.length > 0)
    {
      username = inlineUsername
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname)
  if (bracketedHostMatch)
  {
    hostname = bracketedHostMatch[1]!.trim()
    if (bracketedHostMatch[2])
    {
      port = Number.parseInt(bracketedHostMatch[2], 10)
    }
  }
  else
  {
    const colonSegments = hostname.split(':')
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? ''))
    {
      hostname = colonSegments[0]!.trim()
      port = Number.parseInt(colonSegments[1]!, 10)
    }
  }

  const rawPort = input.port.trim()
  if (rawPort.length > 0)
  {
    port = Number.parseInt(rawPort, 10)
  }

  if (hostname.length === 0)
  {
    throw new Error('SSH host or alias is required.')
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535))
  {
    throw new Error('SSH port must be between 1 and 65535.')
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  }
}

export function formatDesktopSshConnectionError(error: unknown): string
{
  const fallback = 'Failed to connect SSH host.'
  const rawMessage = error instanceof Error ? error.message : fallback
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    '',
  )
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, '')
  return withoutTaggedErrorPrefix.trim() || fallback
}
