// apps/server/src/provider/Layers/ProviderAuthService.ts
// routes provider authentication commands to live instance controllers

import { ProviderSetupError, type ProviderInstanceId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import { ProviderAuthService } from '../Services/ProviderAuthService.ts'
import { ProviderInstanceRegistry } from '../Services/ProviderInstanceRegistry.ts'
import { ProviderService } from '../Services/ProviderService.ts'
import { ProviderSessionDirectory } from '../Services/ProviderSessionDirectory.ts'

export const makeProviderAuthService = Effect.gen(function* ()
{
  const registry = yield* ProviderInstanceRegistry
  const providers = yield* ProviderService
  const directory = yield* ProviderSessionDirectory

  const getController = Effect.fn('ProviderAuthService.getController')(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  )
  {
    const instance = yield* registry.getInstance(instanceId)
    if (!instance?.auth)
    {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: instance
          ? 'This provider does not support sign-in in T3 Code.'
          : 'This provider instance is no longer available.',
      })
    }
    return instance.auth
  })

  const stopSessions = Effect.fn('ProviderAuthService.stopSessions')(function* (
    instanceId: ProviderInstanceId,
  )
  {
    const bindings = yield* directory.listBindings().pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation: 'stopSessions',
            detail: "Could not read the provider's active sessions. Try again.",
          }),
      ),
    )
    const sessions = yield* providers.listSessions()
    const threadIds = new Set(
      bindings
        .filter(
          (binding) => binding.providerInstanceId === instanceId && binding.status !== 'stopped',
        )
        .map((binding) => binding.threadId),
    )
    for (const session of sessions)
    {
      if (session.providerInstanceId === instanceId)
      {
        threadIds.add(session.threadId)
      }
    }
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        providers.stopSession({ threadId, expectedProviderInstanceId: instanceId }).pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: 'stopSessions',
                detail: 'Could not stop all sessions for this provider. Try again.',
              }),
          ),
        ),
      { discard: true },
    )
  })

  return ProviderAuthService.of({
    start: Effect.fn('ProviderAuthService.start')(function* (input, ownerSessionId)
    {
      const auth = yield* getController(input.instanceId, 'start')
      return yield* auth.start(ownerSessionId, stopSessions(input.instanceId))
    }),
    complete: Effect.fn('ProviderAuthService.complete')(function* (input, ownerSessionId)
    {
      const auth = yield* getController(input.instanceId, 'complete')
      return yield* auth.complete(ownerSessionId, input)
    }),
    cancel: Effect.fn('ProviderAuthService.cancel')(function* (input, ownerSessionId)
    {
      const auth = yield* getController(input.instanceId, 'cancel')
      return yield* auth.cancel(ownerSessionId, input.flowId)
    }),
    logout: Effect.fn('ProviderAuthService.logout')(function* (input)
    {
      const auth = yield* getController(input.instanceId, 'logout')
      const state = yield* auth.logout(stopSessions(input.instanceId))
      return {
        instanceId: input.instanceId,
        signedOut: true,
        message: state.message,
      } as const
    }),
    subscribe: (input, ownerSessionId) =>
      Effect.gen(function* ()
      {
        const changes = yield* registry.subscribeChanges
        const initial = yield* getController(input.instanceId, 'subscribe')
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(changes).pipe(
            Stream.mapEffect(() => getController(input.instanceId, 'subscribe')),
          ),
        ).pipe(
          Stream.changesWith((previous, next) => previous === next),
          Stream.switchMap((auth) => auth.subscribe(ownerSessionId, input.flowId)),
        )
      }).pipe(Stream.unwrap),
  })
})

export const ProviderAuthServiceLive = Layer.effect(ProviderAuthService, makeProviderAuthService)
