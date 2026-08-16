// apps/web/src/lib/remoteOpen.ts
// resolve remote editor routes on the viewing machine

import type { ConnectionTarget } from '@t3tools/client-runtime/connection'
import {
  REMOTE_CAPABLE_EDITOR_IDS,
  type EditorId,
  type EnvironmentId,
  type RemoteOpenTarget,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { isDesktopLocalConnectionTarget } from '~/connection/desktopLocal'
import { isLoopbackHostname } from '~/environments/primary/target'
import { useLocalStorage } from '~/hooks/useLocalStorage'
import { useEnvironmentPresentation } from '~/state/presentation'

export interface RemoteOpenHost
{
  readonly kind: 'ssh-alias' | RemoteOpenTarget['kind']
  readonly host: string
}

export type RemoteOpenState =
  | { readonly mode: 'local-exec' }
  | { readonly mode: 'remote-links'; readonly host: RemoteOpenHost }
  | { readonly mode: 'remote-unavailable' }

export type RemoteOpenMode = RemoteOpenState['mode']

const LOCAL_EXEC: RemoteOpenState = { mode: 'local-exec' }
const REMOTE_UNAVAILABLE: RemoteOpenState = { mode: 'remote-unavailable' }

function parseHostname(url: string): string | null
{
  try
  {
    return new URL(url).hostname
  }
  catch
  {
    return null
  }
}

export function resolveRemoteOpenState(input: {
  readonly target: ConnectionTarget | null
  readonly sshAlias: string | null
  readonly remoteOpenTargets: ReadonlyArray<RemoteOpenTarget> | undefined
  readonly isDesktopRenderer: boolean
}): RemoteOpenState
{
  const { target } = input
  if (target === null)
  {
    return LOCAL_EXEC
  }
  if (target._tag === 'PrimaryConnectionTarget')
  {
    // the desktop owns its primary even when wsl-only mode uses a nat url.
    if (input.isDesktopRenderer)
    {
      return LOCAL_EXEC
    }
    const hostname = parseHostname(target.httpBaseUrl)
    if (hostname !== null && isLoopbackHostname(hostname))
    {
      return LOCAL_EXEC
    }
  }
  else if (isDesktopLocalConnectionTarget(target))
  {
    return LOCAL_EXEC
  }

  if (input.sshAlias !== null && input.sshAlias.length > 0)
  {
    return { mode: 'remote-links', host: { kind: 'ssh-alias', host: input.sshAlias } }
  }
  const advertised = input.remoteOpenTargets?.[0]
  return advertised === undefined ? REMOTE_UNAVAILABLE : { mode: 'remote-links', host: advertised }
}

export function useRemoteOpenState(environmentId: EnvironmentId | null): RemoteOpenState
{
  const { presentation } = useEnvironmentPresentation(environmentId)

  return useMemo(() =>
  {
    if (presentation === null)
    {
      return LOCAL_EXEC
    }
    const profile = Option.getOrNull(presentation.entry.profile)
    const sshAlias =
      profile !== null && profile._tag === 'SshConnectionProfile' ? profile.target.alias : null
    return resolveRemoteOpenState({
      target: presentation.entry.target,
      sshAlias,
      remoteOpenTargets: presentation.serverConfig?.remoteOpenTargets,
      isDesktopRenderer: window.desktopBridge !== undefined,
    })
  }, [presentation])
}

const REMOTE_FALLBACK_EDITORS: ReadonlyArray<EditorId> = ['vscode']

let cachedProbedEditors: ReadonlyArray<EditorId> | null = null
let pendingEditorProbe: Promise<ReadonlyArray<EditorId>> | null = null

export function __resetRemoteEditorProbeForTests(): void
{
  cachedProbedEditors = null
  pendingEditorProbe = null
}

function normalizeRemoteEditors(ids: readonly EditorId[]): ReadonlyArray<EditorId>
{
  return [...new Set(ids.filter((id) => REMOTE_CAPABLE_EDITOR_IDS.includes(id)))]
}

export function useRemoteCapableEditors(enabled: boolean): ReadonlyArray<EditorId>
{
  const bridgeProbe = window.desktopBridge?.probeRemoteEditors
  const [editors, setEditors] = useState<ReadonlyArray<EditorId>>(() =>
  {
    if (cachedProbedEditors !== null)
    {
      return cachedProbedEditors
    }
    return window.desktopBridge === undefined || bridgeProbe === undefined
      ? REMOTE_FALLBACK_EDITORS
      : []
  })

  useEffect(() =>
  {
    if (!enabled)
    {
      return
    }
    if (cachedProbedEditors !== null)
    {
      setEditors(cachedProbedEditors)
      return
    }
    if (bridgeProbe === undefined)
    {
      cachedProbedEditors = REMOTE_FALLBACK_EDITORS
      setEditors(cachedProbedEditors)
      return
    }

    let cancelled = false
    pendingEditorProbe ??= Promise.resolve()
      .then(bridgeProbe)
      .then(normalizeRemoteEditors, () => [])
    void pendingEditorProbe.then((availableEditors) =>
    {
      cachedProbedEditors = availableEditors
      pendingEditorProbe = null
      if (!cancelled)
      {
        setEditors(availableEditors)
      }
    })
    return () =>
    {
      cancelled = true
    }
  }, [bridgeProbe, enabled])

  return editors
}

export async function openRemoteEditorUrl(url: string): Promise<boolean>
{
  try
  {
    const bridge = window.desktopBridge
    if (bridge !== undefined)
    {
      return await bridge.openExternal(url)
    }
    window.location.assign(url)
    return true
  }
  catch
  {
    return false
  }
}

const REMOTE_OPEN_HINT_KEY = '456code.remoteOpenHintSeen'

export function useRemoteOpenHint(): readonly [seen: boolean, markSeen: () => void]
{
  const [seen, setSeen] = useLocalStorage(REMOTE_OPEN_HINT_KEY, false, Schema.Boolean)
  const markSeen = useCallback(() => setSeen(true), [setSeen])
  return [seen, markSeen] as const
}
