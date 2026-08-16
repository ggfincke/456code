// tests/apps/server/environment/RemoteOpenTargets.test.ts
// verifies bounded remote editor target discovery behind the local ssh gate

import { it } from '@effect/vitest'
import { HostProcessHostname } from '@t3tools/shared/hostProcess'
import * as NetService from '@t3tools/shared/Net'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect } from 'vite-plus/test'

import * as RemoteOpenTargets from '../../../../apps/server/src/environment/RemoteOpenTargets.ts'

const encoder = new TextEncoder()
const TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { DNSName: 'workstation.tail1234.ts.net.', TailscaleIPs: ['100.64.1.2'] },
})

const spawnerLayer = (input: {
  readonly exitCode: number
  readonly stdout: string
  readonly onSpawn?: () => void
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() =>
      {
        input.onSpawn?.()
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(input.stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        })
      }),
    ),
  )

const netLayer = (input: { readonly ipv4: boolean; readonly ipv6: boolean }) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: (_port, host) => Effect.succeed(host === '::1' ? input.ipv6 : input.ipv4),
    reserveLoopbackPort: () => Effect.succeed(40_000),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  })

const resolveTargets = (input: {
  readonly sshd: { readonly ipv4: boolean; readonly ipv6: boolean }
  readonly tailscale: {
    readonly exitCode: number
    readonly stdout: string
    readonly onSpawn?: () => void
  }
  readonly hostname: string
}) =>
  Effect.flatMap(RemoteOpenTargets.RemoteOpenTargets, (service) => service.resolveTargets()).pipe(
    Effect.provideService(HostProcessHostname, input.hostname),
    Effect.provide(
      RemoteOpenTargets.layer.pipe(
        Layer.provide(Layer.mergeAll(netLayer(input.sshd), spawnerLayer(input.tailscale))),
      ),
    ),
  )

describe('RemoteOpenTargets', () =>
{
  it.effect('advertises nothing and skips name discovery without a loopback ssh listener', () =>
    Effect.gen(function* ()
    {
      let spawnCount = 0
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: { exitCode: 0, stdout: TAILSCALE_STATUS_JSON, onSpawn: () => spawnCount++ },
        hostname: 'workstation',
      })

      expect(targets).toEqual([])
      expect(spawnCount).toBe(0)
    }),
  )

  it.effect('accepts either loopback family and orders MagicDNS before mDNS', () =>
    Effect.gen(function* ()
    {
      for (const sshd of [
        { ipv4: true, ipv6: false },
        { ipv4: false, ipv6: true },
      ])
      {
        const targets = yield* resolveTargets({
          sshd,
          tailscale: { exitCode: 0, stdout: TAILSCALE_STATUS_JSON },
          hostname: 'workstation',
        })

        expect(targets).toEqual([
          { kind: 'tailscale', host: 'workstation.tail1234.ts.net' },
          { kind: 'mdns', host: 'workstation.local' },
        ])
      }
    }),
  )

  it.effect('falls back to a short mDNS hostname when Tailscale fails', () =>
    Effect.gen(function* ()
    {
      for (const tailscale of [
        { exitCode: 1, stdout: '' },
        { exitCode: 0, stdout: '{malformed' },
      ])
      {
        const targets = yield* resolveTargets({
          sshd: { ipv4: true, ipv6: true },
          tailscale,
          hostname: 'workstation.example.com',
        })

        expect(targets).toEqual([{ kind: 'mdns', host: 'workstation.local' }])
      }
    }),
  )
})
