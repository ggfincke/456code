// tests/apps/server/telemetry/AnalyticsService.test.ts
// verify telemetry opt-outs and bounded batch delivery without external requests

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import { afterEach, vi } from 'vite-plus/test'

import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as AnalyticsServiceLayers from '../../../../apps/server/src/telemetry/Layers/AnalyticsService.ts'
import * as AnalyticsService from '../../../../apps/server/src/telemetry/Services/AnalyticsService.ts'

interface RecordedBatchRequest
{
  readonly url: string
  readonly body: {
    readonly api_key: string
    readonly batch: ReadonlyArray<{
      readonly event: string
      readonly properties: {
        readonly index: number
        readonly clientType: string
        readonly wsl?: string
      }
    }>
  }
}

const optOutKeys = [
  'T3CODE_POSTHOG_KEY',
  'T3CODE_POSTHOG_HOST',
  'T3CODE_TELEMETRY_ENABLED',
] as const

const explicitConfig = {
  T3CODE_POSTHOG_KEY: 'phc_test_key',
  T3CODE_POSTHOG_HOST: 'https://telemetry.test',
  T3CODE_TELEMETRY_ENABLED: 'true',
}

const recordEvents = Effect.fn('recordEvents')(function* (
  provider: ConfigProvider.ConfigProvider,
  count = 1,
)
{
  const capturedRequests: Array<RecordedBatchRequest> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() =>
    {
      assert.equal(request.body._tag, 'Uint8Array')
      if (request.body._tag !== 'Uint8Array') throw new Error('Expected a JSON request body')
      capturedRequests.push({
        url: request.url,
        body: JSON.parse(new TextDecoder().decode(request.body.body)),
      })
      return HttpClientResponse.fromWeb(request, Response.json({}))
    }),
  )
  const telemetryLayer = AnalyticsServiceLayers.layer.pipe(
    Layer.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: 't3-telemetry-base-',
      }),
    ),
    Layer.provide(ConfigProvider.layer(provider)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  )

  yield* Effect.gen(function* ()
  {
    const analytics = yield* AnalyticsService.AnalyticsService
    for (let index = 0; index < count; index += 1)
    {
      yield* analytics.record('test.flush', { index })
    }
    yield* analytics.flush
  }).pipe(Effect.provide(telemetryLayer))

  return capturedRequests
})

afterEach(() => vi.unstubAllEnvs())

it.layer(NodeServices.layer)('AnalyticsService test', (it) =>
{
  it.effect('explicit opt-in preserves ambient batching and endpoint settings', () =>
    Effect.gen(function* ()
    {
      // injected values retain precedence over process-level opt-outs
      for (const key of optOutKeys) vi.stubEnv(key, '')
      vi.stubEnv('T3CODE_TELEMETRY_FLUSH_BATCH_SIZE', '1')
      vi.stubEnv('WSL_DISTRO_NAME', 'ambient-process-value')

      const requests = yield* recordEvents(
        ConfigProvider.fromUnknown({
          ...explicitConfig,
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
          WSL_DISTRO_NAME: 'test-distro',
        }),
        45,
      )

      assert.equal(requests.length, 3)
      assert.deepEqual(
        requests.map((request) => request.body.batch.length),
        [20, 20, 5],
      )
      assert.equal(
        requests.every(
          (request) =>
            request.url === 'https://telemetry.test/batch/' &&
            request.body.api_key === 'phc_test_key',
        ),
        true,
      )
      const events = requests.flatMap((request) => request.body.batch)
      assert.deepEqual(
        events.map((event) => event.properties.index),
        Array.from({ length: 45 }, (_, index) => index),
      )
      assert.equal(
        events.every(
          (event) =>
            event.properties.clientType === 'cli-web-client' &&
            event.properties.wsl === 'test-distro',
        ),
        true,
      )
    }),
  )

  for (const key of optOutKeys)
  {
    it.effect(`a blank ${key} disables delivery from the environment provider`, () =>
      Effect.gen(function* ()
      {
        for (const optOutKey of optOutKeys) vi.stubEnv(optOutKey, undefined)
        vi.stubEnv(key, '')
        const requests = yield* recordEvents(
          ConfigProvider.fromEnv({
            env: { ...explicitConfig, [key]: process.env[key]! },
          }),
        )
        assert.equal(requests.length, 0)
      }),
    )
  }

  it.effect('preserved whitespace enabled and explicit false both disable delivery', () =>
    Effect.gen(function* ()
    {
      for (const key of optOutKeys) vi.stubEnv(key, undefined)
      for (const enabled of ['  ', 'false'])
      {
        const requests = yield* recordEvents(
          ConfigProvider.fromUnknown({
            ...explicitConfig,
            T3CODE_TELEMETRY_ENABLED: enabled,
          }),
        )
        assert.equal(requests.length, 0)
      }
    }),
  )

  it.effect('unset telemetry settings retain shipped defaults through an injected client', () =>
    Effect.gen(function* ()
    {
      // absent injected keys do not inherit process-level opt-outs
      for (const key of optOutKeys) vi.stubEnv(key, '')
      const requests = yield* recordEvents(ConfigProvider.fromUnknown({}))
      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.url, 'https://us.i.posthog.com/batch/')
      assert.equal(requests[0]?.body.api_key, 'phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m')
    }),
  )
})
