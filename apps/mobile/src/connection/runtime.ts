// apps/mobile/src/connection/runtime.ts
// assembles mobile connection services and foreground cleanup retry

import { Connection, EnvironmentRegistry, Wakeups } from '@t3tools/client-runtime/connection'
import { shellSnapshotLoaderLayer } from '@t3tools/client-runtime/state/shell'
import { threadSnapshotLoaderLayer } from '@t3tools/client-runtime/state/threads'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { Atom } from 'effect/unstable/reactivity'

import { runtimeContextLayer } from '../lib/runtime'
import { connectionPlatformLayer } from './platform'

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
)

const snapshotLoaderLayer = Layer.merge(threadSnapshotLoaderLayer, shellSnapshotLoaderLayer)

const environmentCleanupRetryLayer = Layer.effectDiscard(
  Effect.gen(function* ()
  {
    const registry = yield* EnvironmentRegistry
    const wakeups = yield* Wakeups.ConnectionWakeups
    yield* wakeups.changes.pipe(
      Stream.filter(Wakeups.isApplicationActiveWakeup),
      Stream.runForEach(() => registry.retryOwnedDataCleanup),
      Effect.forkScoped,
    )
  }),
)

const connectionWithCleanupRetryLayer = environmentCleanupRetryLayer.pipe(
  Layer.provideMerge(Connection.layer),
)

type ConnectionLayerSource =
  | typeof connectionWithCleanupRetryLayer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer

const connectionLayer = Layer.merge(connectionWithCleanupRetryLayer, snapshotLoaderLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedConnectionPlatformLayer)),
)

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer)
