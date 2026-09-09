// apps/server/src/provider/Layers/ProviderUsageLimitsIngestion.ts
// routes normalized runtime limit updates to their provider instances
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import { ProviderInstanceRegistry } from '../Services/ProviderInstanceRegistry.ts'
import { ProviderService } from '../Services/ProviderService.ts'

export const ProviderUsageLimitsIngestionLive = Layer.effectDiscard(
  Effect.gen(function* ()
  {
    const providerService = yield* ProviderService
    const instanceRegistry = yield* ProviderInstanceRegistry

    yield* providerService.streamEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === 'account.rate-limits.updated' ||
          event.type === 'account.updated' ||
          event.type === 'auth.status',
      ),
      Stream.runForEach((event) =>
        Effect.gen(function* ()
        {
          if (!event.providerInstanceId) return
          const instance = yield* instanceRegistry.getInstance(event.providerInstanceId)
          if (!instance) return
          if (event.type === 'account.rate-limits.updated')
          {
            if (event.payload.limits)
            {
              yield* instance.snapshot.applyUsageLimits(event.payload.limits)
            }
            return
          }
          yield* instance.snapshot.invalidateUsageLimits(event.createdAt)
          yield* instance.snapshot.refresh
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    )
  }),
)
