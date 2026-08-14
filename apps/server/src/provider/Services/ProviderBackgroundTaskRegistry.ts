// apps/server/src/provider/Services/ProviderBackgroundTaskRegistry.ts
// tracks live background tasks by exact provider session generation

import type { ProviderRuntimeEvent } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { ProviderAdapterRuntimeSessionBinding } from './ProviderAdapter.ts'

export interface ProviderBackgroundTaskRegistryShape
{
  readonly observeAcceptedRuntimeEvent: (
    binding: ProviderAdapterRuntimeSessionBinding,
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void>

  readonly hasLiveTasks: (identity: ProviderAdapterRuntimeSessionBinding) => Effect.Effect<boolean>
}

export class ProviderBackgroundTaskRegistry extends Context.Service<
  ProviderBackgroundTaskRegistry,
  ProviderBackgroundTaskRegistryShape
>()('456code/provider/Services/ProviderBackgroundTaskRegistry')
{}
