// packages/shared/src/Net.ts
// define net error

import * as NodeNet from 'node:net'

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Context from 'effect/Context'

export class NetError extends Data.TaggedError('NetError')<{
  readonly message: string
  readonly cause?: unknown
}>
{}

const closeServer = (server: NodeNet.Server) =>
{
  try
  {
    server.close()
  }
  catch
  {
    // ignore close failures during cleanup.
  }
}

export interface NetServiceShape
{
  // returns true when a TCP server can bind to {host, port}.
  readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>

  // checks loopback availability on both IPv4 and IPv6 localhost addresses.
  readonly isPortAvailableOnLoopback: (port: number) => Effect.Effect<boolean>

  // reserve an ephemeral loopback port and release it immediately.
  readonly reserveLoopbackPort: (host?: string) => Effect.Effect<number, NetError>

  // resolve an available listening port, preferring the provided port first.
  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, NetError>
}

/**
 * NetService - Service tag for startup networking helpers.
 */
export class NetService extends Context.Service<NetService, NetServiceShape>()(
  '@t3tools/shared/Net/NetService',
)
{}

export const make = () =>
{
  // returns true when a TCP server can bind to {host, port}.
  const canListenOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) =>
    {
      const server = NodeNet.createServer()
      let settled = false

      const settle = (value: boolean) =>
      {
        if (settled) return
        settled = true
        resume(Effect.succeed(value))
      }

      server.unref()

      server.once('error', (cause) =>
      {
        settle(false)
      })

      server.once('listening', () =>
      {
        server.close(() =>
        {
          settle(true)
        })
      })

      server.listen({ host, port })

      return Effect.sync(() =>
      {
        closeServer(server)
      })
    })

  const hasListenerOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) =>
    {
      const socket = NodeNet.createConnection({ host, port })
      let settled = false

      const settle = (value: boolean) =>
      {
        if (settled) return
        settled = true
        socket.destroy()
        resume(Effect.succeed(value))
      }

      socket.unref()
      socket.setTimeout(250)
      socket.once('connect', () =>
      {
        settle(true)
      })
      socket.once('error', () =>
      {
        settle(false)
      })
      socket.once('timeout', () =>
      {
        settle(false)
      })

      return Effect.sync(() =>
      {
        socket.destroy()
      })
    })

  const isPortAvailableOnLoopback = (port: number): Effect.Effect<boolean> =>
    Effect.gen(function* ()
    {
      const hasListener = yield* Effect.zipWith(
        hasListenerOnHost(port, '127.0.0.1'),
        hasListenerOnHost(port, '::1'),
        (ipv4, ipv6) => ipv4 || ipv6,
      )
      if (hasListener)
      {
        return false
      }

      return yield* Effect.zipWith(
        canListenOnHost(port, '127.0.0.1'),
        canListenOnHost(port, '::1'),
        (ipv4, ipv6) => ipv4 || ipv6,
      )
    })

  // reserve an ephemeral loopback port and release it immediately.
  // returns the reserved port number.
  const reserveLoopbackPort = (host = '127.0.0.1'): Effect.Effect<number, NetError> =>
    Effect.callback<number, NetError>((resume) =>
    {
      const probe = NodeNet.createServer()
      let settled = false

      const settle = (effect: Effect.Effect<number, NetError>) =>
      {
        if (settled) return
        settled = true
        resume(effect)
      }

      probe.once('error', (cause) =>
      {
        settle(Effect.fail(new NetError({ message: 'Failed to reserve loopback port', cause })))
      })

      probe.listen(0, host, () =>
      {
        const address = probe.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        probe.close(() =>
        {
          if (port > 0)
          {
            settle(Effect.succeed(port))
            return
          }
          settle(Effect.fail(new NetError({ message: 'Failed to reserve loopback port' })))
        })
      })

      return Effect.sync(() =>
      {
        closeServer(probe)
      })
    })

  return {
    canListenOnHost,
    isPortAvailableOnLoopback,
    reserveLoopbackPort,
    findAvailablePort: (preferred) =>
      Effect.gen(function* ()
      {
        if (preferred > 0 && (yield* isPortAvailableOnLoopback(preferred)))
        {
          return preferred
        }
        return yield* reserveLoopbackPort()
      }),
  } satisfies NetServiceShape
}

export const layer = Layer.sync(NetService, make)
