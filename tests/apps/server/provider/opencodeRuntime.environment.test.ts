// tests/apps/server/provider/opencodeRuntime.environment.test.ts
// verify OpenCode environment precedence, authenticated health, & cancellation

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it as effectIt } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
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
