// apps/server/src/provider/Layers/ProviderEventLoggers.ts
// owns the shared native & canonical provider event loggers
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ServerConfig } from '../../config.ts'
import { type EventNdjsonLogger, makeProviderEventNdjsonLoggers } from './EventNdjsonLogger.ts'

export interface ProviderEventLoggersShape
{
  readonly native: EventNdjsonLogger | undefined
  readonly canonical: EventNdjsonLogger | undefined
}

/** Shared logger pair for native and canonical provider event streams. */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  ProviderEventLoggersShape
>()('456code/provider/Layers/ProviderEventLoggers')
{}

// test & boot value for disabling provider event logging
export const NoOpProviderEventLoggers: ProviderEventLoggersShape = {
  native: undefined,
  canonical: undefined,
}

export const ProviderEventLoggersLive = Layer.effect(
  ProviderEventLoggers,
  Effect.gen(function* ()
  {
    const { providerEventLogPath } = yield* ServerConfig
    const loggers = yield* makeProviderEventNdjsonLoggers(providerEventLogPath)
    if (!loggers)
    {
      return NoOpProviderEventLoggers
    }

    yield* Effect.addFinalizer(() => loggers.close())
    return {
      native: loggers.native,
      canonical: loggers.canonical,
    } satisfies ProviderEventLoggersShape
  }),
)
