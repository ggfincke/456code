// tests/apps/server/provider/Layers/ProviderEventLoggers.test.ts
// verifies shared rotating sink ownership for live provider event loggers
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { vi } from 'vite-plus/test'

const sinkState = vi.hoisted(() => ({
  paths: new Array<string>(),
  chunks: new Array<string>(),
}))

vi.mock('@t3tools/shared/logging', () => ({
  RotatingFileSink: class
  {
    constructor(options: { readonly filePath: string })
    {
      sinkState.paths.push(options.filePath)
    }

    write(chunk: string | Buffer): void
    {
      sinkState.chunks.push(String(chunk))
    }
  },
}))

import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import {
  ProviderEventLoggers,
  ProviderEventLoggersLive,
} from '../../../../../apps/server/src/provider/Layers/ProviderEventLoggers.ts'

it.effect('uses one rotating sink for native and canonical records in the same file', () =>
  Effect.gen(function* ()
  {
    sinkState.paths.length = 0
    sinkState.chunks.length = 0
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // scoped, so the temp dir is released without a try/finally around the asserts
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: 't3-provider-log-owner-',
    })
    const providerEventLogPath = path.join(tempDir, 'provider-events.ndjson')

    {
      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const loggers = yield* ProviderEventLoggers
          assert.exists(loggers.native)
          assert.exists(loggers.canonical)
          if (!loggers.native || !loggers.canonical)
          {
            return
          }

          yield* loggers.native.write({ id: 'native' }, null)
          yield* loggers.canonical.write({ id: 'canonical' }, null)
        }).pipe(Effect.provide(ProviderEventLoggersLive)),
      ).pipe(
        Effect.provideService(
          ServerConfig,
          ServerConfig.of({ providerEventLogPath } as ServerConfig['Service']),
        ),
      )

      assert.deepEqual(sinkState.paths, [path.join(tempDir, '_global.log')])
      assert.equal(sinkState.chunks.length, 1)
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
