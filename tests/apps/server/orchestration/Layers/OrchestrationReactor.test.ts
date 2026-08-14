// tests/apps/server/orchestration/Layers/OrchestrationReactor.test.ts
// verify orchestration reactor behavior

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Scope from 'effect/Scope'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ReactorDeliveryError } from '../../../../../apps/server/src/persistence/Errors.ts'
import { CheckpointReactor } from '../../../../../apps/server/src/orchestration/Services/CheckpointReactor.ts'
import { ArchitectureAutoAnalysisReactor } from '../../../../../apps/server/src/orchestration/Services/ArchitectureAutoAnalysisReactor.ts'
import { ProviderCommandReactor } from '../../../../../apps/server/src/orchestration/Services/ProviderCommandReactor.ts'
import { ProviderRuntimeIngestionService } from '../../../../../apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts'
import { ThreadArchiveReactor } from '../../../../../apps/server/src/orchestration/Services/ThreadArchiveReactor.ts'
import { ThreadDeletionReactor } from '../../../../../apps/server/src/orchestration/Services/ThreadDeletionReactor.ts'
import { AttachmentCleanupReactor } from '../../../../../apps/server/src/orchestration/Services/AttachmentCleanupReactor.ts'
import { OrchestrationReactor } from '../../../../../apps/server/src/orchestration/Services/OrchestrationReactor.ts'
import { makeOrchestrationReactor } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationReactor.ts'
import {
  PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
  PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
  ProviderRuntimeInboxRunner,
  type ProviderRuntimeInboxRunnerShape,
} from '../../../../../apps/server/src/orchestration/Services/ProviderRuntimeInboxRunner.ts'
import {
  ProviderService,
  type ProviderServiceShape,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'

function makeTestLayer(input: {
  readonly started: string[]
  readonly drained: string[]
  readonly shutdown?: ProviderServiceShape['shutdown']
  readonly drainThrough?: ProviderRuntimeInboxRunnerShape['drainThrough']
  readonly admissionHandoffHighWater?: number | null
  readonly resumeAdmissionAfterHandoff?: ProviderServiceShape['resumeAdmissionAfterHandoff']
})
{
  const owner = (name: string) => ({
    start: () =>
      Effect.sync(() =>
      {
        input.started.push(name)
      }),
    drain: Effect.sync(() =>
    {
      input.drained.push(name)
    }),
  })
  const checkpointRuntimeOwner = owner('checkpoint-runtime-inbox-owner')
  const checkpointDomainOwner = owner('checkpoint-domain-durable-owner')

  return Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
    Layer.provideMerge(
      Layer.succeed(ProviderRuntimeIngestionService, owner('provider-runtime-ingestion')),
    ),
    Layer.provideMerge(Layer.succeed(ProviderCommandReactor, owner('provider-command-reactor'))),
    Layer.provideMerge(
      Layer.succeed(CheckpointReactor, {
        startRuntimeLane: checkpointRuntimeOwner.start,
        startDomain: checkpointDomainOwner.start,
        start: () =>
          checkpointRuntimeOwner.start().pipe(Effect.andThen(checkpointDomainOwner.start())),
        drain: checkpointDomainOwner.drain,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ArchitectureAutoAnalysisReactor,
        owner('architecture-auto-analysis-durable-owner'),
      ),
    ),
    Layer.provideMerge(Layer.succeed(ThreadArchiveReactor, owner('thread-archive-durable-owner'))),
    Layer.provideMerge(
      Layer.succeed(ThreadDeletionReactor, owner('thread-deletion-durable-owner')),
    ),
    Layer.provideMerge(Layer.succeed(AttachmentCleanupReactor, owner('attachment-cleanup'))),
    Layer.provideMerge(
      Layer.succeed(ProviderRuntimeInboxRunner, {
        start: () => Effect.void,
        drain: () => Effect.void,
        drainThrough: input.drainThrough ?? (() => Effect.void),
        pauseClaims: () => Effect.void,
        resumeClaims: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderService, {
        getAdmissionHandoffHighWater: Effect.succeed(input.admissionHandoffHighWater ?? null),
        resumeAdmissionAfterHandoff: input.resumeAdmissionAfterHandoff ?? Effect.void,
        shutdown: input.shutdown ?? Effect.succeed(0),
      } as unknown as ProviderServiceShape),
    ),
  )
}

const START_ORDER = [
  'provider-runtime-ingestion',
  'checkpoint-runtime-inbox-owner',
  'provider-command-reactor',
  'checkpoint-domain-durable-owner',
  'architecture-auto-analysis-durable-owner',
  'thread-archive-durable-owner',
  'thread-deletion-durable-owner',
  'attachment-cleanup',
] as const

const DOWNSTREAM_DRAIN_ORDER = [
  'checkpoint-domain-durable-owner',
  'provider-command-reactor',
  'architecture-auto-analysis-durable-owner',
  'thread-archive-durable-owner',
  'thread-deletion-durable-owner',
  'attachment-cleanup',
] as const

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

  it('starts each hot or durable effect owner exactly once in dependency order', async () =>
  {
    const started: string[] = []
    const drained: string[] = []

    runtime = ManagedRuntime.make(makeTestLayer({ started, drained }))

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor))
    const scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)))

    expect(started).toEqual([...START_ORDER])
    expect(new Set(started).size).toBe(started.length)

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it('fences provider admission and drains both inbox lanes before downstream owners', async () =>
  {
    const started: string[] = []
    const drained: string[] = []
    runtime = ManagedRuntime.make(
      makeTestLayer({
        started,
        drained,
        shutdown: Effect.sync(() =>
        {
          drained.push('provider-shutdown')
          return 7
        }),
        drainThrough: (consumerId, sequence) =>
          Effect.sync(() =>
          {
            drained.push(`${consumerId}:${sequence}`)
          }),
      }),
    )

    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor))
    await runtime.runPromise(reactor.shutdown)

    expect(drained).toEqual([
      'provider-shutdown',
      `${PROVIDER_RUNTIME_INGESTION_REACTOR_ID}:7`,
      `${PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID}:7`,
      ...DOWNSTREAM_DRAIN_ORDER,
    ])
  })

  it('catches a dirty startup fence before provider and checkpoint domain work resumes', async () =>
  {
    const lifecycle: string[] = []
    runtime = ManagedRuntime.make(
      makeTestLayer({
        started: lifecycle,
        drained: lifecycle,
        admissionHandoffHighWater: 5,
        drainThrough: (consumerId, sequence) =>
          Effect.sync(() =>
          {
            lifecycle.push(`${consumerId}:${sequence}`)
          }),
        resumeAdmissionAfterHandoff: Effect.sync(() =>
        {
          lifecycle.push('provider-admission-resumed')
        }),
      }),
    )

    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor))
    const scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)))

    expect(lifecycle).toEqual([
      'provider-runtime-ingestion',
      'checkpoint-runtime-inbox-owner',
      `${PROVIDER_RUNTIME_INGESTION_REACTOR_ID}:5`,
      `${PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID}:5`,
      'provider-admission-resumed',
      'provider-command-reactor',
      'checkpoint-domain-durable-owner',
      'architecture-auto-analysis-durable-owner',
      'thread-archive-durable-owner',
      'thread-deletion-durable-owner',
      'attachment-cleanup',
    ])

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it('fails shutdown without certifying downstream drain when an inbox lane is blocked', async () =>
  {
    const started: string[] = []
    const drained: string[] = []
    runtime = ManagedRuntime.make(
      makeTestLayer({
        started,
        drained,
        shutdown: Effect.succeed(3),
        drainThrough: (consumerId, sequence) =>
          Effect.sync(() =>
          {
            drained.push(`${consumerId}:${sequence}`)
          }).pipe(
            Effect.andThen(
              consumerId === PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID
                ? Effect.fail(
                    new ReactorDeliveryError({
                      operation: 'blocked-provider-runtime-checkpoint',
                    }),
                  )
                : Effect.void,
            ),
          ),
      }),
    )

    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor))
    const exit = await runtime.runPromise(Effect.exit(reactor.shutdown))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(drained).toEqual([
      `${PROVIDER_RUNTIME_INGESTION_REACTOR_ID}:3`,
      `${PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID}:3`,
    ])
  })
})
