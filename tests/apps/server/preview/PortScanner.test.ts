// tests/apps/server/preview/PortScanner.test.ts
// verify browser-ready local server discovery

import * as NodeNet from 'node:net'

import { it as effectIt } from '@effect/vitest'
import type { DiscoveredLocalServer } from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Net from '@t3tools/shared/Net'
import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as TestClock from 'effect/testing/TestClock'
import { FetchHttpClient } from 'effect/unstable/http'
import { expect } from 'vite-plus/test'

import * as ProcessRunner from '../../../../apps/server/src/process/processRunner.ts'
import * as PortScanner from '../../../../apps/server/src/preview/PortScanner.ts'

const processProbeFailure: ProcessRunner.ProcessRunner['Service']['run'] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: 'NotFound',
        module: 'ChildProcess',
        method: 'spawn',
        description: 'PowerShell is not installed in the test environment',
      }),
    }),
  )

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
})

let integrationListeningPort: number | null = null

const TestIntegrationNet = Layer.succeed(Net.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: (port) => Effect.sync(() => port !== integrationListeningPort),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(40_000),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
})

const makeProbeFailureLayer = (
  run: ProcessRunner.ProcessRunner['Service']['run'],
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, 'linux'),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  )

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      TestIntegrationNet,
      Layer.succeed(HostProcessPlatform, 'win32'),
      FetchHttpClient.layer,
    ),
  ),
)

const LSOF_TEST_PORT = 43_123

const makeLsofScannerLayer = (input: {
  readonly pid: () => number
  readonly fetch: typeof globalThis.fetch
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: '',
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, 'linux'),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  )

const openServer = (
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) =>
  {
    const server = NodeNet.createServer(onConnection)
    server.once('error', () =>
    {
      resume(Effect.succeed(null))
    })
    server.listen(port, '127.0.0.1', () =>
    {
      resume(Effect.succeed(server))
    })
    return Effect.sync(() =>
    {
      server.close()
    })
  })

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) =>
  {
    server.close(() => resume(Effect.void))
  })

const openCommonDevServer = Effect.fn('PortScannerTest.openCommonDevServer')(function* (
  ports: ReadonlyArray<number>,
  onConnection: (socket: NodeNet.Socket) => void,
)
{
  for (const port of ports)
  {
    const server = yield* openServer(port, onConnection)
    if (server !== null) return { port, server }
  }
  return yield* Effect.die(
    new Error('No common development port was available for the preview scanner test'),
  )
})

const commonDevServer = (
  onConnection: (socket: NodeNet.Socket) => void,
  ports: ReadonlyArray<number> = PortScanner.COMMON_DEV_PORTS,
) =>
  Effect.acquireRelease(
    openCommonDevServer(ports, onConnection).pipe(
      Effect.tap(({ port }) =>
        Effect.sync(() =>
        {
          integrationListeningPort = port
        }),
      ),
    ),
    ({ server }) =>
      closeServer(server).pipe(
        Effect.ensuring(
          Effect.sync(() =>
          {
            integrationListeningPort = null
          }),
        ),
      ),
  )

effectIt.layer(TestPortDiscoveryLive)('PortDiscovery real listener classification', (it) =>
{
  it.effect(
    'includes a successful HTML server',
    Effect.fn('PortScannerTest.includesHtmlServer')(function* ()
    {
      const { port } = yield* commonDevServer((socket) =>
      {
        socket.once('data', () =>
        {
          socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello')
        })
      })
      const scanner = yield* PortScanner.PortDiscovery
      expect((yield* scanner.scan()).find((server) => server.port === port)).toMatchObject({
        host: 'localhost',
        port,
      })
    }),
  )

  it.effect(
    'excludes successful JSON and non-HTTP TCP listeners',
    Effect.fn('PortScannerTest.excludesNonBrowserServers')(function* ()
    {
      const json = yield* commonDevServer((socket) =>
      {
        socket.once('data', () =>
        {
          socket.end(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
          )
        })
      }, PortScanner.COMMON_DEV_PORTS.toReversed())
      const scanner = yield* PortScanner.PortDiscovery
      expect((yield* scanner.scan()).some((server) => server.port === json.port)).toBe(false)

      yield* Effect.scoped(
        commonDevServer((socket) =>
        {
          socket.on('error', () => undefined)
          socket.once('data', () => socket.end('MYSQL\r\n\r\n'))
        }, PortScanner.COMMON_DEV_PORTS.toReversed()).pipe(
          Effect.flatMap(({ port }) =>
            scanner.scan().pipe(
              Effect.map((servers) =>
              {
                expect(servers.some((server) => server.port === port)).toBe(false)
              }),
            ),
          ),
        ),
      )
    }),
  )
})

effectIt.effect('keeps a configured path, metadata, and cache identity', () =>
{
  let pid = 1_234
  const requested: string[] = []
  const configuredUrl = `http://0.0.0.0:${LSOF_TEST_PORT}/docs`
  const normalizedUrl = `http://localhost:${LSOF_TEST_PORT}/docs`
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
  {
    const url = String(input)
    requested.push(url)
    return Promise.resolve(
      url === normalizedUrl
        ? new Response('docs', { headers: { 'content-type': 'text/html' } })
        : new Response('missing', { status: 404 }),
    )
  }) as typeof globalThis.fetch
  const layer = makeLsofScannerLayer({ pid: () => pid, fetch: fetchFn })

  return Effect.gen(function* ()
  {
    const scanner = yield* PortScanner.PortDiscovery
    yield* scanner.registerTerminalProcesses({
      threadId: 'thread-1',
      terminalId: 'terminal-1',
      processIds: [pid],
    })
    const initial = yield* scanner.scan([configuredUrl])
    expect(initial).toHaveLength(1)
    expect(initial[0]).toMatchObject({
      host: 'localhost',
      port: LSOF_TEST_PORT,
      url: normalizedUrl,
      processName: 'node',
      pid,
      terminal: { threadId: 'thread-1', terminalId: 'terminal-1' },
    })

    const requestCount = requested.length
    expect((yield* scanner.scan([`${configuredUrl}#install`]))[0]?.url).toBe(
      `${normalizedUrl}#install`,
    )
    expect(requested).toHaveLength(requestCount)

    pid += 1
    yield* scanner.scan([configuredUrl])
    expect(requested.length).toBeGreaterThan(requestCount)
  }).pipe(Effect.provide(layer))
})

effectIt.effect('uses bounded cache entries for both negative and positive probes', () =>
{
  let responds = false
  const requested: string[] = []
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
  {
    requested.push(String(input))
    return responds
      ? Promise.resolve(new Response('app', { headers: { 'content-type': 'text/html' } }))
      : Promise.reject(new TypeError('not HTTP'))
  }) as typeof globalThis.fetch
  const layer = makeLsofScannerLayer({ pid: () => 1_234, fetch: fetchFn })

  return Effect.gen(function* ()
  {
    const scanner = yield* PortScanner.PortDiscovery
    expect(yield* scanner.scan()).toHaveLength(0)
    expect(yield* scanner.scan()).toHaveLength(0)
    expect(requested).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ])

    responds = true
    yield* TestClock.adjust(Duration.seconds(15))
    expect(yield* scanner.scan()).toHaveLength(1)
    const positiveRequestCount = requested.length
    expect(yield* scanner.scan()).toHaveLength(1)
    expect(requested).toHaveLength(positiveRequestCount)
  }).pipe(Effect.provide(layer))
})

effectIt.effect('falls back to HTTPS and accepts only manual navigation redirects', () =>
{
  const redirects: Array<string | undefined> = []
  const fetchFn = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
  {
    redirects.push(init?.redirect)
    if (String(input).startsWith('http:')) throw new TypeError('TLS listener')
    return new Response(null, { status: 302, headers: { location: 'https://example.com' } })
  }) as typeof globalThis.fetch
  const layer = makeLsofScannerLayer({ pid: () => 1_234, fetch: fetchFn })

  return Effect.gen(function* ()
  {
    const scanner = yield* PortScanner.PortDiscovery
    const servers = yield* scanner.scan()
    expect(servers).toHaveLength(1)
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}`)
    expect(redirects).toEqual(['manual', 'manual'])
  }).pipe(Effect.provide(layer))
})

effectIt.effect('rejects empty document responses and accepts XHTML', () =>
{
  let pid = 1
  let makeResponse = () =>
    new Response(null, { status: 204, headers: { 'content-type': 'text/html' } })
  const fetchFn = ((_input: Parameters<typeof globalThis.fetch>[0]) =>
    Promise.resolve(makeResponse())) as typeof globalThis.fetch
  const layer = makeLsofScannerLayer({ pid: () => pid, fetch: fetchFn })

  return Effect.gen(function* ()
  {
    const scanner = yield* PortScanner.PortDiscovery
    expect(yield* scanner.scan()).toHaveLength(0)

    pid += 1
    makeResponse = () =>
      new Response(null, { status: 205, headers: { 'content-type': 'text/html' } })
    expect(yield* scanner.scan()).toHaveLength(0)

    pid += 1
    makeResponse = () =>
      new Response('<html />', {
        headers: { 'content-type': 'application/xhtml+xml; charset=utf-8' },
      })
    expect(yield* scanner.scan()).toHaveLength(1)
  }).pipe(Effect.provide(layer))
})

effectIt.effect('keeps simultaneous configured path projections isolated', () =>
{
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`
  let docsReady = true
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
  {
    const url = String(input)
    return Promise.resolve(
      (url === docsUrl && docsReady) || url === adminUrl
        ? new Response('app', { headers: { 'content-type': 'text/html' } })
        : new Response('missing', { status: 404 }),
    )
  }) as typeof globalThis.fetch
  const layer = makeLsofScannerLayer({ pid: () => 1_234, fetch: fetchFn })

  return Effect.gen(function* ()
  {
    const scanner = yield* PortScanner.PortDiscovery
    const docsSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = []
    const adminSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = []
    const docsInitial = yield* scanner.subscribe({ configuredUrls: [docsUrl] }, (servers) =>
      Effect.sync(() => docsSnapshots.push(servers)),
    )
    const adminInitial = yield* scanner.subscribe({ configuredUrls: [adminUrl] }, (servers) =>
      Effect.sync(() => adminSnapshots.push(servers)),
    )
    expect(docsInitial[0]?.url).toBe(docsUrl)
    expect(adminInitial[0]?.url).toBe(adminUrl)

    yield* scanner.retain
    docsReady = false
    yield* TestClock.adjust(Duration.seconds(15))
    expect(docsSnapshots.at(-1)).toEqual([])
    expect(adminSnapshots).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(layer))
})

effectIt.effect(
  'cancels an abandoned subscription probe before registering its replacement',
  () =>
  {
    const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/app`
    let configuredAttempts = 0
    let firstProbeAborted = false
    let markFirstProbeStarted: (() => void) | undefined
    const firstProbeStarted = new Promise<void>((resolve) =>
    {
      markFirstProbeStarted = resolve
    })
    const fetchFn = ((
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) =>
    {
      const url = String(input)
      if (url !== configuredUrl)
      {
        return Promise.resolve(new Response('root', { headers: { 'content-type': 'text/html' } }))
      }
      configuredAttempts += 1
      if (configuredAttempts > 1)
      {
        return Promise.resolve(new Response('app', { headers: { 'content-type': 'text/html' } }))
      }
      markFirstProbeStarted?.()
      return new Promise<Response>((_resolve, reject) =>
      {
        const onAbort = () =>
        {
          firstProbeAborted = true
          reject(new DOMException('Aborted', 'AbortError'))
        }
        if (init?.signal?.aborted) onAbort()
        else init?.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }) as typeof globalThis.fetch
    const layer = makeLsofScannerLayer({ pid: () => 1_234, fetch: fetchFn })

    return Effect.gen(function* ()
    {
      const scanner = yield* PortScanner.PortDiscovery
      const abandoned = yield* Effect.forkChild(
        scanner.subscribe({ configuredUrls: [configuredUrl] }, () => Effect.void),
      )
      yield* Effect.promise(() => firstProbeStarted)
      yield* Fiber.interrupt(abandoned)
      expect(firstProbeAborted).toBe(true)

      const replacement = yield* scanner.subscribe(
        { configuredUrls: [configuredUrl] },
        () => Effect.void,
      )
      expect(replacement).toHaveLength(1)
      expect(replacement[0]?.url).toBe(configuredUrl)
      expect(configuredAttempts).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(layer))
  },
)

effectIt.effect('aborts both protocol probes after their one-second bounds', () =>
{
  const aborted: string[] = []
  const fetchFn = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    new Promise<Response>((_resolve, reject) =>
    {
      const onAbort = () =>
      {
        aborted.push(String(input))
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (init?.signal?.aborted) onAbort()
      else init?.signal?.addEventListener('abort', onAbort, { once: true })
    })) as typeof globalThis.fetch
  const layer = makeLsofScannerLayer({ pid: () => 1_234, fetch: fetchFn })

  return Effect.gen(function* ()
  {
    const scanner = yield* PortScanner.PortDiscovery
    const scanFiber = yield* Effect.forkChild(scanner.scan())
    yield* TestClock.adjust(Duration.seconds(2))
    expect(yield* Fiber.join(scanFiber)).toHaveLength(0)
    expect(aborted).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ])
  }).pipe(Effect.provide(layer))
})

effectIt('does not swallow process probe defects', () =>
  Effect.gen(function* ()
  {
    const defect = new Error('unexpected process probe defect')
    const layer = makeProbeFailureLayer(() => Effect.die(defect))

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
    {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.squash(exit.cause)).toBe(defect)
    }
  }),
)

effectIt('does not swallow process probe interruption', () =>
  Effect.gen(function* ()
  {
    const layer = makeProbeFailureLayer(() => Effect.interrupt)

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
    {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
  }),
)
