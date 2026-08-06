// apps/server/src/orchestration/runtimeLayer.ts
// assembles shared orchestration persistence, engine, and reactor services

import * as Layer from 'effect/Layer'

import { OrchestrationCommandReceiptRepositoryLive } from '../persistence/Layers/OrchestrationCommandReceipts.ts'
import { ImportReplacementIntentRepositoryLive } from '../persistence/Layers/ImportReplacementIntents.ts'
import { OrchestrationEventStoreLive } from '../persistence/Layers/OrchestrationEventStore.ts'
import { OrchestrationReactorDeliveryLive } from '../persistence/Layers/OrchestrationReactorDelivery.ts'
import { DurableReactorRunnerLive } from './Layers/DurableReactorRunner.ts'
import { OrchestrationEngineLive } from './Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionPipelineLive } from './Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from './Layers/ProjectionSnapshotQuery.ts'
import { AttachmentLifecycleRepositoryLive } from '../persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../persistence/Layers/CheckpointRevertOperations.ts'

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  OrchestrationReactorDeliveryLive,
  AttachmentLifecycleRepositoryLive,
  CheckpointRevertOperationsLive,
)

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
)

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
  ImportReplacementIntentRepositoryLive,
)

const OrchestrationEngineLayerLive = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationInfrastructureLayerLive),
)

const DurableReactorRunnerLayerLive = DurableReactorRunnerLive.pipe(
  Layer.provide(OrchestrationInfrastructureLayerLive),
  Layer.provide(OrchestrationEngineLayerLive),
)

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLayerLive,
  DurableReactorRunnerLayerLive,
)
