// apps/server/src/orchestration/Layers/OrchestrationReactor.ts
// assemble orchestration reactor Effect layer

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDeliveryLive } from '../../persistence/Layers/OrchestrationReactorDelivery.ts'
import { DurableReactorRunnerLive } from './DurableReactorRunner.ts'
import { AttachmentCleanupReactorLive } from './AttachmentCleanupReactor.ts'
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from '../Services/OrchestrationReactor.ts'
import { CheckpointReactor } from '../Services/CheckpointReactor.ts'
import { ProviderCommandReactor } from '../Services/ProviderCommandReactor.ts'
import { ProviderRuntimeIngestionService } from '../Services/ProviderRuntimeIngestion.ts'
import { ThreadDeletionReactor } from '../Services/ThreadDeletionReactor.ts'
import { AttachmentCleanupReactor } from '../Services/AttachmentCleanupReactor.ts'

export const DurableReactorInfrastructureLive = DurableReactorRunnerLive.pipe(
  Layer.provideMerge(OrchestrationReactorDeliveryLive),
)

export const makeOrchestrationReactor = Effect.gen(function* ()
{
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService
  const providerCommandReactor = yield* ProviderCommandReactor
  const checkpointReactor = yield* CheckpointReactor
  const threadDeletionReactor = yield* ThreadDeletionReactor
  const attachmentCleanupReactor = yield* AttachmentCleanupReactor

  const start: OrchestrationReactorShape['start'] = Effect.fn('start')(function* ()
  {
    yield* providerRuntimeIngestion.start()
    yield* providerCommandReactor.start()
    // checkpoint and deletion register their sole durable effect owners here.
    // checkpoint startup reads persisted revert state; wrap its sql failures
    // so this facade keeps the delivery-error contract
    yield* checkpointReactor
      .start()
      .pipe(
        Effect.catchTag('PersistenceSqlError', (cause) =>
          Effect.fail(
            new ReactorDeliveryError({ operation: 'OrchestrationReactor.start:checkpoint', cause }),
          ),
        ),
      )
    yield* threadDeletionReactor.start()
    yield* attachmentCleanupReactor.start()
  })

  return {
    start,
  } satisfies OrchestrationReactorShape
})

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
).pipe(Layer.provideMerge(AttachmentCleanupReactorLive))
