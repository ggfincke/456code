// tests/apps/server/provider/opencodeRuntime.environment.test.ts
// verify OpenCode environment precedence, authenticated health, & cancellation

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it as effectIt } from '@effect/vitest'
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from '@t3tools/shared/hostProcess'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestClock from 'effect/testing/TestClock'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  resolveOpenCodeConfigContent,
  resolveOpenCodeServerPassword,
  verifyOpenCodeServerVersion,
  type OpenCodeRuntimeShape,
} from '../../../../apps/server/src/provider/opencodeRuntime.ts'

type OpencodeClient = ReturnType<OpenCodeRuntimeShape['createOpenCodeSdkClient']>

describe('resolveOpenCodeConfigContent', () =>
{
  it('prefers caller config, then inherited config, then the empty fallback', () =>
  {
    expect(
      resolveOpenCodeConfigContent(
        { OPENCODE_CONFIG_CONTENT: '{"source":"caller"}' },
        { OPENCODE_CONFIG_CONTENT: '{"source":"process"}' },
      ),
    ).toBe('{"source":"caller"}')
    expect(
      resolveOpenCodeConfigContent(undefined, {
        OPENCODE_CONFIG_CONTENT: '{"source":"process"}',
      }),
    ).toBe('{"source":"process"}')
    expect(resolveOpenCodeConfigContent(undefined, {})).toBe('{}')
  })
})

it('resolves local passwords without inheriting credentials into explicit environments or external servers', () =>
{
  const inherited = { OPENCODE_SERVER_PASSWORD: 'inherited-secret' }
  const environment = { OPENCODE_SERVER_PASSWORD: 'local-secret' }
  expect(resolveOpenCodeServerPassword({ external: false }, inherited)).toBe('inherited-secret')
  expect(resolveOpenCodeServerPassword({ external: false, environment }, inherited)).toBe(
    'local-secret',
  )
  expect(
    resolveOpenCodeServerPassword({ external: false, environment: {} }, inherited),
  ).toBeUndefined()
  expect(
    resolveOpenCodeServerPassword(
      { external: false, environment, serverPassword: ' explicit ' },
      inherited,
    ),
  ).toBe(' explicit ')
  expect(
    resolveOpenCodeServerPassword({ external: false, environment, serverPassword: '' }, inherited),
  ).toBe('')
  expect(resolveOpenCodeServerPassword({ external: true, environment }, inherited)).toBeUndefined()
  expect(
    resolveOpenCodeServerPassword(
      { external: true, environment, serverPassword: 'external-secret' },
      inherited,
    ),
  ).toBe('external-secret')
})

const makeHealthClient = (
  health: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpencodeClient => ({ global: { health } }) as unknown as OpencodeClient

effectIt.effect(
  'validates health and the minimum version while preserving unauthorized errors',
  () =>
    Effect.gen(function* ()
    {
      expect(
        yield* verifyOpenCodeServerVersion(
          makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: '1.14.19' } })),
        ),
      ).toBe('1.14.19')
      for (const data of [
        { healthy: true, version: '1.14.18' },
        { healthy: true, version: 'not-a-version' },
        { healthy: false, version: '1.14.19' },
        { healthy: true },
      ])
      {
        const error = yield* verifyOpenCodeServerVersion(
          makeHealthClient(() => Promise.resolve({ data })),
        ).pipe(Effect.flip)
        expect(error).toBeInstanceOf(OpenCodeRuntimeError)
        expect(error.operation).toBe('global.health')
        expect(error.detail).toContain('v1.14.19 or newer')
      }
      const unauthorized = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() =>
          Promise.reject({ response: { status: 401 }, error: { message: 'Unauthorized' } }),
        ),
      ).pipe(Effect.flip)
      expect(unauthorized.detail).toContain('status=401')
      expect(unauthorized.detail).toContain('Unauthorized')
    }),
)

for (const stop of ['timeout', 'interrupt'] as const)
{
  effectIt.effect(`aborts the health SDK request on ${stop}`, () =>
    Effect.gen(function* ()
    {
      const entered = yield* Deferred.make<void>()
      let requestSignal: AbortSignal | undefined
      const check = verifyOpenCodeServerVersion(
        makeHealthClient((options) =>
        {
          requestSignal = options?.signal
          Deferred.doneUnsafe(entered, Effect.void)
          return new Promise(() => undefined)
        }),
      )
      const fiber = yield* check.pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      expect(requestSignal).toBeDefined()
      if (stop === 'timeout') yield* TestClock.adjust('5 seconds')
      else yield* Fiber.interrupt(fiber)
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result))
      {
        if (stop === 'interrupt') expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
        else
          expect(Cause.squash(result.cause)).toMatchObject({
            operation: 'global.health',
            detail: 'Timed out while checking the OpenCode server version.',
          })
      }
      expect(requestSignal?.aborted).toBe(true)
    }).pipe(Effect.provide(TestClock.layer())),
  )
}

effectIt.layer(OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer)))(
  'external OpenCode server health',
  (it) =>
  {
    it.effect(
      'authenticates health only with the explicit password and returns an externally owned handle',
      () =>
        Effect.gen(function* ()
        {
          const requests: Request[] = []
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(globalThis, 'fetch').mockImplementation((request) =>
              {
                requests.push(request as Request)
                return Promise.resolve(
                  new Response(JSON.stringify({ healthy: true, version: '1.15.13' }), {
                    headers: { 'content-type': 'application/json' },
                  }),
                )
              }),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          )
          const runtime = yield* OpenCodeRuntime
          const input = {
            binaryPath: 'must-not-spawn',
            directory: '/project with spaces',
            serverUrl: ' http://example.invalid:4096 ',
            environment: { OPENCODE_SERVER_PASSWORD: 'local-secret' },
          }
          const anonymous = yield* runtime.connectToOpenCodeServer(input)
          const authenticated = yield* runtime.connectToOpenCodeServer({
            ...input,
            serverPassword: 'external-secret',
          })
          expect(anonymous).toEqual({
            url: 'http://example.invalid:4096',
            version: '1.15.13',
            external: true,
            exitCode: null,
          })
          expect(authenticated).toEqual({ ...anonymous, serverPassword: 'external-secret' })
          expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
            '/global/health',
            '/global/health',
          ])
          expect(requests[0]?.headers.get('authorization')).toBeNull()
          expect(requests[1]?.headers.get('authorization')).toBe(
            `Basic ${Buffer.from('opencode:external-secret').toString('base64')}`,
          )
          expect(new URL(requests[1]!.url).searchParams.get('directory')).toBe(
            '/project with spaces',
          )
        }).pipe(Effect.scoped),
    )
  },
)

describe('OpenCode server output', () =>
{
  effectIt.live(
    'drains stdout and stderr after startup so server requests can finish',
    () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const environment = yield* HostProcessEnvironment
        const executablePath = yield* HostProcessExecutablePath
        const platform = yield* HostProcessPlatform
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 't3-opencode-output-',
        })
        const isWindows = platform === 'win32'
        const binaryPath = path.join(tempDir, isWindows ? 'opencode.cmd' : 'opencode')
        const scriptPath = path.join(tempDir, 'opencode.mjs')

        yield* fileSystem.writeFileString(
          scriptPath,
          `import { createServer } from 'node:http'
const writeOutput = (stream) => new Promise((resolve, reject) => {
  stream.write('x'.repeat(2 * 1024 * 1024), (error) => error ? reject(error) : resolve())
})
const server = createServer(async (request, response) => {
  if (request.url.startsWith('/global/health')) {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ healthy: true, version: '1.14.19' }))
    return
  }
  await Promise.all([writeOutput(process.stdout), writeOutput(process.stderr)])
  response.end('drained')
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('opencode server listening on http://127.0.0.1:' + server.address().port + '\\n')
})
`,
        )
        yield* fileSystem.writeFileString(
          binaryPath,
          [
            ...(isWindows ? ['@echo off'] : ['#!/bin/sh']),
            isWindows
              ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
              : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
            '',
          ].join('\n'),
        )
        if (!isWindows)
        {
          yield* fileSystem.chmod(binaryPath, 0o755)
        }

        const runtime = yield* OpenCodeRuntime
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath,
          directory: tempDir,
          port: 0,
          environment: {
            ...environment,
            T3_TEST_NODE_BINARY: executablePath,
            T3_TEST_OPENCODE_SCRIPT: scriptPath,
          },
        })
        const response = yield* HttpClient.get(`${server.url}/output`)

        expect(yield* response.text).toBe('drained')
        expect(yield* server.isRunning).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide([
          OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer)),
          FetchHttpClient.layer,
        ]),
      ),
    10_000,
  )
})
