// apps/server/src/orchestration/Layers/OrchestrationReactor.ts
// assemble orchestration reactor Effect layer

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDeliveryLive } from '../../persistence/Layers/OrchestrationReactorDelivery.ts'
import { AttachmentCleanupReactorLive } from './AttachmentCleanupReactor.ts'
import { DurableReactorRunnerLive } from './DurableReactorRunner.ts'
import { ArchitectureAutoAnalysisReactor } from '../Services/ArchitectureAutoAnalysisReactor.ts'
import { AttachmentCleanupReactor } from '../Services/AttachmentCleanupReactor.ts'
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from '../Services/OrchestrationReactor.ts'
import { CheckpointReactor } from '../Services/CheckpointReactor.ts'
import { ProviderCommandReactor } from '../Services/ProviderCommandReactor.ts'
import { ProviderRuntimeIngestionService } from '../Services/ProviderRuntimeIngestion.ts'
import { ThreadArchiveReactor } from '../Services/ThreadArchiveReactor.ts'
import { ThreadDeletionReactor } from '../Services/ThreadDeletionReactor.ts'
import { ProviderService } from '../../provider/Services/ProviderService.ts'
import {
  PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
  PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
  ProviderRuntimeInboxRunner,
} from '../Services/ProviderRuntimeInboxRunner.ts'

export const DurableReactorInfrastructureLive = DurableReactorRunnerLive.pipe(
  Layer.provideMerge(OrchestrationReactorDeliveryLive),
)

export const makeOrchestrationReactor = Effect.gen(function* ()
{
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService
  const providerCommandReactor = yield* ProviderCommandReactor
  const checkpointReactor = yield* CheckpointReactor
  const architectureAutoAnalysisReactor = yield* ArchitectureAutoAnalysisReactor
  const threadArchiveReactor = yield* ThreadArchiveReactor
  const threadDeletionReactor = yield* ThreadDeletionReactor
  const attachmentCleanupReactor = yield* AttachmentCleanupReactor
  const providerService = yield* ProviderService
  const providerRuntimeInboxRunner = yield* ProviderRuntimeInboxRunner

  const drainDownstream = checkpointReactor.drain.pipe(
    Effect.andThen(providerCommandReactor.drain),
    Effect.andThen(architectureAutoAnalysisReactor.drain),
    Effect.andThen(threadArchiveReactor.drain),
    Effect.andThen(threadDeletionReactor.drain),
    Effect.andThen(
      attachmentCleanupReactor.drain.pipe(
        Effect.mapError(
          (cause) =>
            new ReactorDeliveryError({
              operation: 'OrchestrationReactor.drain:attachment-cleanup',
              cause,
            }),
        ),
      ),
    ),
  )
  const drain: OrchestrationReactorShape['drain'] = providerRuntimeIngestion.drain.pipe(
    Effect.andThen(drainDownstream),
  )
  const shutdown: OrchestrationReactorShape['shutdown'] = providerService.shutdown.pipe(
    Effect.mapError(
      (cause) =>
        new ReactorDeliveryError({
          operation: 'OrchestrationReactor.shutdown:provider',
          cause,
        }),
    ),
    Effect.flatMap((highWaterSequence) =>
      providerRuntimeInboxRunner
        .drainThrough(PROVIDER_RUNTIME_INGESTION_REACTOR_ID, highWaterSequence)
        .pipe(
          Effect.andThen(
            providerRuntimeInboxRunner.drainThrough(
              PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
              highWaterSequence,
            ),
          ),
          Effect.andThen(drainDownstream),
        ),
    ),
  )

  const start: OrchestrationReactorShape['start'] = Effect.fn('start')(function* ()
  {
    yield* providerRuntimeIngestion.start()
    yield* checkpointReactor.startRuntimeLane().pipe(
      Effect.catchTag('PersistenceSqlError', (cause) =>
        Effect.fail(
          new ReactorDeliveryError({
            operation: 'OrchestrationReactor.start:checkpoint-runtime',
            cause,
          }),
        ),
      ),
    )
    // catch both durable provider consumers through a persisted admission
    // fence before domain runners may issue or replay provider work.
    const admissionHandoffHighWater = yield* providerService.getAdmissionHandoffHighWater.pipe(
      Effect.mapError(
        (cause) =>
          new ReactorDeliveryError({
            operation: 'OrchestrationReactor.start:provider-admission-handoff',
            cause,
          }),
      ),
    )
    if (admissionHandoffHighWater !== null)
    {
      yield* providerRuntimeInboxRunner.drainThrough(
        PROVIDER_RUNTIME_INGESTION_REACTOR_ID,
        admissionHandoffHighWater,
      )
      yield* providerRuntimeInboxRunner.drainThrough(
        PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID,
        admissionHandoffHighWater,
      )
      yield* providerService.resumeAdmissionAfterHandoff.pipe(
        Effect.mapError(
          (cause) =>
            new ReactorDeliveryError({
              operation: 'OrchestrationReactor.start:provider-admission-resume',
              cause,
            }),
        ),
      )
    }

    yield* providerCommandReactor.start()
    // checkpoint domain recovery, architecture analysis, archive cleanup,
    // and deletion register their sole durable effect owners here.
    yield* checkpointReactor.startDomain().pipe(
      Effect.catchTag('PersistenceSqlError', (cause) =>
        Effect.fail(
          new ReactorDeliveryError({
            operation: 'OrchestrationReactor.start:checkpoint-domain',
            cause,
          }),
        ),
      ),
    )
    yield* architectureAutoAnalysisReactor.start()
    yield* threadArchiveReactor.start()
    yield* threadDeletionReactor.start()
    yield* attachmentCleanupReactor.start()
  })

  return {
    start,
    drain,
    shutdown,
  } satisfies OrchestrationReactorShape
})

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
).pipe(Layer.provideMerge(AttachmentCleanupReactorLive))
