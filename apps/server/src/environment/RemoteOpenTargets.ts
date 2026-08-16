// apps/server/src/environment/RemoteOpenTargets.ts
// resolves ssh hostnames an environment can advertise for remote editor links

import { type RemoteOpenTarget } from '@t3tools/contracts'
import { HostProcessHostname } from '@t3tools/shared/hostProcess'
import * as NetService from '@t3tools/shared/Net'
import { readTailscaleStatus } from '@t3tools/tailscale'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

const SSH_PORT = 22

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>
  }
>()('456code/environment/RemoteOpenTargets')
{}

export const make = Effect.gen(function* ()
{
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const net = yield* NetService.NetService

  const resolveTargets = Effect.fn('RemoteOpenTargets.resolveTargets')(function* ()
  {
    // an advertised hostname is actionable only when this machine accepts ssh locally.
    const [ipv4Listening, ipv6Listening] = yield* Effect.all(
      [net.hasListenerOnHost(SSH_PORT, '127.0.0.1'), net.hasListenerOnHost(SSH_PORT, '::1')],
      { concurrency: 2 },
    )
    if (!ipv4Listening && !ipv6Listening)
    {
      return []
    }

    const targets: Array<RemoteOpenTarget> = []
    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    )
    if (magicDnsName !== null)
    {
      targets.push({ kind: 'tailscale', host: magicDnsName })
    }

    const hostname = yield* HostProcessHostname
    const shortHostname = hostname.split('.')[0]?.trim()
    if (shortHostname !== undefined && shortHostname.length > 0)
    {
      targets.push({ kind: 'mdns', host: `${shortHostname}.local` })
    }

    return targets
  })

  return RemoteOpenTargets.of({ resolveTargets })
})

export const layer = Layer.effect(RemoteOpenTargets, make)
