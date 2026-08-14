// apps/server/src/orchestration/runtimeLayer.ts
// assembles shared orchestration persistence, engine, and reactor services

import * as Layer from 'effect/Layer'

import { OrchestrationCommandReceiptRepositoryLive } from '../persistence/Layers/OrchestrationCommandReceipts.ts'
import { ImportReplacementIntentRepositoryLive } from '../persistence/Layers/ImportReplacementIntents.ts'
import { OrchestrationEventStoreLive } from '../persistence/Layers/OrchestrationEventStore.ts'
import { OrchestrationReactorDeliveryLive } from '../persistence/Layers/OrchestrationReactorDelivery.ts'
import { DurableReactorRunnerLive } from './Layers/DurableReactorRunner.ts'
import { OrchestrationEngineWithArchivePermitLive } from './Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionPipelineLive } from './Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from './Layers/ProjectionSnapshotQuery.ts'
import { AttachmentLifecycleRepositoryLive } from '../persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../persistence/Layers/CheckpointRevertOperations.ts'
import { ProviderRuntimeInboxLive } from '../persistence/Layers/ProviderRuntimeInbox.ts'
import { ProviderRuntimeInboxRunnerLive } from './Layers/ProviderRuntimeInboxRunner.ts'
import { ThreadArchiveLifecyclePermitLive } from './Layers/ThreadArchiveLifecyclePermit.ts'

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  OrchestrationReactorDeliveryLive,
  AttachmentLifecycleRepositoryLive,
  CheckpointRevertOperationsLive,
  ProviderRuntimeInboxLive,
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

const OrchestrationEngineLayerLive = OrchestrationEngineWithArchivePermitLive.pipe(
  Layer.provide(OrchestrationInfrastructureLayerLive),
  Layer.provide(ThreadArchiveLifecyclePermitLive),
)

const DurableReactorRunnerLayerLive = DurableReactorRunnerLive.pipe(
  Layer.provide(OrchestrationInfrastructureLayerLive),
  Layer.provide(OrchestrationEngineLayerLive),
)

const ProviderRuntimeInboxRunnerLayerLive = ProviderRuntimeInboxRunnerLive.pipe(
  Layer.provide(OrchestrationInfrastructureLayerLive),
)

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  ThreadArchiveLifecyclePermitLive,
  OrchestrationEngineLayerLive,
  DurableReactorRunnerLayerLive,
  ProviderRuntimeInboxRunnerLayerLive,
)
