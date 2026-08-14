// tests/apps/server/support/serverStorageLease.ts
// acquires an isolated storage lease for disk-backed server tests

import * as Layer from 'effect/Layer'

import * as ServerStorageLease from '../../../../apps/server/src/serverStorageLease.ts'

export const makeTestServerStorageLeaseLayer = (storageRoot: string) =>
  Layer.effect(
    ServerStorageLease.ServerStorageLease,
    ServerStorageLease.acquireServerStorageLease(storageRoot),
  )
