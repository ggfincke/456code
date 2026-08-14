// apps/server/src/orchestration/Services/ProviderRuntimeInboxRunner.ts
// defines ordered durable consumers for the canonical provider-event inbox

import type { ProviderRuntimeEvent } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'

import type { ReactorDeliveryError } from '../../persistence/Errors.ts'
import type {
  ProviderRuntimeInboxBuffer,
  ProviderRuntimeInboxConsumerId,
  ProviderRuntimeInboxRecord,
} from '../../persistence/Services/ProviderRuntimeInbox.ts'
import type { ReactorFailureClass } from '../../persistence/Services/OrchestrationReactorDelivery.ts'

export const PROVIDER_RUNTIME_INGESTION_REACTOR_ID = 'provider-runtime-ingestion' as const
export const PROVIDER_RUNTIME_CHECKPOINT_REACTOR_ID = 'provider-runtime-checkpoint' as const
export const PROVIDER_RUNTIME_INBOX_OPERATION_VERSION = 1
export const PROVIDER_RUNTIME_INBOX_EFFECT_KIND = 'provider.runtime-event.consume'
export const PROVIDER_RUNTIME_INBOX_TARGET_KIND = 'provider-runtime-event'

export interface ProviderRuntimeInboxConsumerCheckpoint
{
  readonly stateVersion: number
  readonly stateJson: string
  readonly sessionBufferTerminal: boolean
  readonly outcomeJson?: string
}

export interface ProviderRuntimeInboxConsumerDefinition
{
  readonly consumerId: ProviderRuntimeInboxConsumerId
  readonly operationVersion: number
  readonly prerequisite?: (record: ProviderRuntimeInboxRecord) => Effect.Effect<boolean, Error>
  readonly process: (
    record: ProviderRuntimeInboxRecord,
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<ProviderRuntimeInboxConsumerCheckpoint, Error>
  readonly restore: (
    checkpoint: Option.Option<ProviderRuntimeInboxBuffer>,
  ) => Effect.Effect<void, Error>
  readonly classify: (cause: unknown, record: ProviderRuntimeInboxRecord) => ReactorFailureClass
}

export interface ProviderRuntimeInboxRunnerShape
{
  readonly start: (
    definition: ProviderRuntimeInboxConsumerDefinition,
  ) => Effect.Effect<void, ReactorDeliveryError, Scope.Scope>
  readonly drain: (
    consumerId: ProviderRuntimeInboxConsumerId,
  ) => Effect.Effect<void, ReactorDeliveryError>
  readonly drainThrough: (
    consumerId: ProviderRuntimeInboxConsumerId,
    sequence: number,
  ) => Effect.Effect<void, ReactorDeliveryError>
  readonly pauseClaims: (
    consumerId: ProviderRuntimeInboxConsumerId,
  ) => Effect.Effect<void, ReactorDeliveryError>
  readonly resumeClaims: (
    consumerId: ProviderRuntimeInboxConsumerId,
  ) => Effect.Effect<void, ReactorDeliveryError>
}

export class ProviderRuntimeInboxRunner extends Context.Service<
  ProviderRuntimeInboxRunner,
  ProviderRuntimeInboxRunnerShape
>()('456code/orchestration/Services/ProviderRuntimeInboxRunner')
{}
