// apps/server/src/recovery/runtimeLayer.ts
// assembles runtime recovery services and authenticated HTTP routes

import { RuntimeRecoveryHttpApi } from '@t3tools/contracts'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'

import { environmentAuthenticatedAuthLayer } from '../auth/http.ts'
import { RuntimeRecoveryPersistenceLive } from '../persistence/Layers/RuntimeRecovery.ts'
import { RuntimeRecoveryAdminLive } from './RuntimeRecoveryAdmin.ts'
import { RuntimeRecoveryPolicyRegistryLive } from './RuntimeRecoveryPolicy.ts'
import { runtimeRecoveryHttpApiLayer } from './http.ts'

export const RuntimeRecoveryAdminLayerLive = RuntimeRecoveryAdminLive.pipe(
  Layer.provideMerge(RuntimeRecoveryPolicyRegistryLive),
  Layer.provideMerge(RuntimeRecoveryPersistenceLive),
)

export const RuntimeRecoveryRoutesLayer = HttpApiBuilder.layer(RuntimeRecoveryHttpApi).pipe(
  Layer.provide(runtimeRecoveryHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provide(RuntimeRecoveryAdminLayerLive),
)
