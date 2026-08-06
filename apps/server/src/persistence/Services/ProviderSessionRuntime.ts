// apps/server/src/persistence/Services/ProviderSessionRuntime.ts
// defines provider session runtime persistence contracts

import {
  IsoDateTime,
  ProviderInstanceId,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { ProviderSessionRuntimeRepositoryError } from '../Errors.ts'

export const ProviderSessionRuntime = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  // nullable only for rows written before provider instances were introduced
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  adapterKey: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
})
export type ProviderSessionRuntime = typeof ProviderSessionRuntime.Type

export const GetProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId })
export type GetProviderSessionRuntimeInput = typeof GetProviderSessionRuntimeInput.Type

export const DeleteProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId })
export type DeleteProviderSessionRuntimeInput = typeof DeleteProviderSessionRuntimeInput.Type

/**
 * Persistence API for provider runtime metadata and resume cursors.
 */
export interface ProviderSessionRuntimeRepositoryShape
{
  readonly upsert: (
    runtime: ProviderSessionRuntime,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>
  readonly getByThreadId: (
    input: GetProviderSessionRuntimeInput,
  ) => Effect.Effect<Option.Option<ProviderSessionRuntime>, ProviderSessionRuntimeRepositoryError>
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProviderSessionRuntime>,
    ProviderSessionRuntimeRepositoryError
  >
  readonly deleteByThreadId: (
    input: DeleteProviderSessionRuntimeInput,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>
}

export class ProviderSessionRuntimeRepository extends Context.Service<
  ProviderSessionRuntimeRepository,
  ProviderSessionRuntimeRepositoryShape
>()('456code/persistence/Services/ProviderSessionRuntime/ProviderSessionRuntimeRepository')
{}
