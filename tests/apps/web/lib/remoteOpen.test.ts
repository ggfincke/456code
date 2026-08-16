// tests/apps/web/lib/remoteOpen.test.ts
// verify local and remote editor route resolution

// @vitest-environment happy-dom

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from '@t3tools/client-runtime/connection'
import {
  buildRemoteOpenUrl,
  type DesktopBridge,
  type EditorId,
  EnvironmentId,
} from '@t3tools/contracts'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  __resetRemoteEditorProbeForTests,
  resolveRemoteOpenState,
  useRemoteCapableEditors,
} from '../../../../apps/web/src/lib/remoteOpen'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const environmentId = EnvironmentId.make('environment-1')

const primaryTarget = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({
    environmentId,
    label: 'sol',
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace('http', 'ws'),
  })

const REMOTE_TARGETS = [
  { kind: 'tailscale', host: 'sol.tail1234.ts.net' },
  { kind: 'mdns', host: 'sol.local' },
] as const

describe('resolveRemoteOpenState', () =>
{
  it('keeps a browser loopback primary local', () =>
  {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget('http://127.0.0.1:8000'),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: REMOTE_TARGETS,
      }),
    ).toEqual({ mode: 'local-exec' })
  })

  it('uses the advertised tailscale host for a network primary', () =>
  {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget('https://sol.tail1234.ts.net'),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: REMOTE_TARGETS,
      }),
    ).toEqual({
      mode: 'remote-links',
      host: { kind: 'tailscale', host: 'sol.tail1234.ts.net' },
    })
  })

  it('keeps the desktop primary local on a wsl nat url', () =>
  {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget('http://172.29.112.1:14369'),
        sshAlias: null,
        isDesktopRenderer: true,
        remoteOpenTargets: REMOTE_TARGETS,
      }),
    ).toEqual({ mode: 'local-exec' })
  })

  it('keeps managed desktop wsl backends local', () =>
  {
    expect(
      resolveRemoteOpenState({
        target: new BearerConnectionTarget({
          environmentId,
          label: 'WSL (Ubuntu)',
          connectionId: 'local:wsl-1',
        }),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: REMOTE_TARGETS,
      }),
    ).toEqual({ mode: 'local-exec' })
  })

  it('prefers an ssh catalog alias over advertised hosts', () =>
  {
    expect(
      resolveRemoteOpenState({
        target: new SshConnectionTarget({
          environmentId,
          label: 'sol',
          connectionId: 'ssh-1',
        }),
        sshAlias: 'sol',
        isDesktopRenderer: true,
        remoteOpenTargets: REMOTE_TARGETS,
      }),
    ).toEqual({ mode: 'remote-links', host: { kind: 'ssh-alias', host: 'sol' } })
  })

  it('uses mdns when it is the only advertised target', () =>
  {
    expect(
      resolveRemoteOpenState({
        target: new RelayConnectionTarget({ environmentId, label: 'sol' }),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: [{ kind: 'mdns', host: 'sol.local' }],
      }),
    ).toEqual({ mode: 'remote-links', host: { kind: 'mdns', host: 'sol.local' } })
  })

  it('reports unavailable when a remote environment has no advertised host', () =>
  {
    for (const remoteOpenTargets of [[], undefined] as const)
    {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: 'sol' }),
          sshAlias: null,
          isDesktopRenderer: false,
          remoteOpenTargets,
        }),
      ).toEqual({ mode: 'remote-unavailable' })
    }
  })

  it('preserves local exec when the catalog has no entry', () =>
  {
    expect(
      resolveRemoteOpenState({
        target: null,
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: undefined,
      }),
    ).toEqual({ mode: 'local-exec' })
  })
})

describe('buildRemoteOpenUrl', () =>
{
  it('builds encoded vscode remote links', () =>
  {
    expect(
      buildRemoteOpenUrl({
        editor: 'vscode',
        host: 'sol.tail1234.ts.net',
        absolutePath: '/home/theo/code/my repo',
      }),
    ).toBe('vscode://vscode-remote/ssh-remote+sol.tail1234.ts.net/home/theo/code/my%20repo')
  })

  it('uses the selected editor scheme', () =>
  {
    expect(buildRemoteOpenUrl({ editor: 'cursor', host: 'sol', absolutePath: '/tmp/x' })).toBe(
      'cursor://vscode-remote/ssh-remote+sol/tmp/x',
    )
  })

  it('roots windows paths', () =>
  {
    expect(
      buildRemoteOpenUrl({ editor: 'vscode', host: 'sol', absolutePath: 'C:\\Users\\theo' }),
    ).toBe('vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo')
  })

  it('rejects editors without remote support', () =>
  {
    expect(buildRemoteOpenUrl({ editor: 'zed', host: 'sol', absolutePath: '/tmp/x' })).toBe(
      undefined,
    )
  })
})

describe('useRemoteCapableEditors', () =>
{
  it('restores a deferred probe result after re-enabling without a remount', async () =>
  {
    __resetRemoteEditorProbeForTests()
    let resolveProbe!: (editors: readonly EditorId[]) => void
    const probePromise = new Promise<readonly EditorId[]>((resolve) =>
    {
      resolveProbe = resolve
    })
    const probeRemoteEditors = vi.fn(() => probePromise)
    window.desktopBridge = { probeRemoteEditors } as unknown as DesktopBridge

    let renderedEditors: ReadonlyArray<EditorId> = []
    const Harness = ({ enabled }: { readonly enabled: boolean }) =>
    {
      renderedEditors = useRemoteCapableEditors(enabled)
      return null
    }

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try
    {
      await act(async () =>
      {
        root.render(createElement(Harness, { enabled: true }))
        await Promise.resolve()
      })
      expect(probeRemoteEditors).toHaveBeenCalledOnce()
      expect(renderedEditors).toEqual([])

      await act(async () => root.render(createElement(Harness, { enabled: false })))
      await act(async () =>
      {
        resolveProbe(['cursor'])
        await probePromise
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(renderedEditors).toEqual([])

      await act(async () => root.render(createElement(Harness, { enabled: true })))
      expect(renderedEditors).toEqual(['cursor'])
      expect(probeRemoteEditors).toHaveBeenCalledOnce()
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
      Reflect.deleteProperty(window, 'desktopBridge')
      __resetRemoteEditorProbeForTests()
    }
  })
})
