import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Scope from 'effect/Scope'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { CheckpointReactor } from '../../../../../apps/server/src/orchestration/Services/CheckpointReactor.ts'
import { ProviderCommandReactor } from '../../../../../apps/server/src/orchestration/Services/ProviderCommandReactor.ts'
import { ProviderRuntimeIngestionService } from '../../../../../apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts'
import { ThreadDeletionReactor } from '../../../../../apps/server/src/orchestration/Services/ThreadDeletionReactor.ts'
import { OrchestrationReactor } from '../../../../../apps/server/src/orchestration/Services/OrchestrationReactor.ts'
import { makeOrchestrationReactor } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationReactor.ts'

describe('OrchestrationReactor', () =>
{
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null

  afterEach(async () =>
  {
    if (runtime)
    {
      await runtime.dispose()
    }
    runtime = null
  })

  it('starts provider ingestion, provider command, checkpoint, and thread deletion reactors', async () =>
  {
    const started: string[] = []

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () =>
            {
              started.push('provider-runtime-ingestion')
              return Effect.void
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () =>
            {
              started.push('provider-command-reactor')
              return Effect.void
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () =>
            {
              started.push('checkpoint-reactor')
              return Effect.void
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () =>
            {
              started.push('thread-deletion-reactor')
              return Effect.void
            },
            drain: Effect.void,
          }),
        ),
      ),
    )

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor))
    const scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)))

    expect(started).toEqual([
      'provider-runtime-ingestion',
      'provider-command-reactor',
      'checkpoint-reactor',
      'thread-deletion-reactor',
    ])

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})
