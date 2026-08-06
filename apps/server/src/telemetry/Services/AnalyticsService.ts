// apps/server/src/telemetry/Services/AnalyticsService.ts
// defines the analytics service contract

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

/** Records and flushes anonymous product analytics events. */
export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>
    readonly flush: Effect.Effect<void>
  }
>()('456code/telemetry/Services/AnalyticsService')
{
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  )
}
