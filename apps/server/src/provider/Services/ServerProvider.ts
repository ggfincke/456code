// apps/server/src/provider/Services/ServerProvider.ts
// define provider service contract

import type { ServerProvider } from '@t3tools/contracts'
import type * as Effect from 'effect/Effect'
import type * as Stream from 'effect/Stream'
import type { ProviderMaintenanceCapabilities } from '../maintenance/providerMaintenance.ts'

export interface ServerProviderShape
{
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities
  readonly getSnapshot: Effect.Effect<ServerProvider>
  readonly refresh: Effect.Effect<ServerProvider>
  readonly streamChanges: Stream.Stream<ServerProvider>
}
