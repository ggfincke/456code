// apps/server/src/provider/Services/ProviderInstanceRegistryMutator.ts
// layer to reconcile the live registry with a fresh

// `ProviderInstanceConfigMap`.
//
// kept separate from the public `ProviderInstanceRegistry` service tag so
// downstream consumers (drivers, reactors, `ProviderService`) can only read
// from the registry. Only the hydration layer — which watches
// `ServerSettingsService.streamChanges` and applies diffs — imports this
// tag.
//
// the mutator exposes a single entry point, `reconcile(configMap)`, which:
//
//   1. Diffs the incoming map against the live one keyed by instance id.
//   2. Closes the per-instance `Scope` of every removed or replaced entry
//      (tearing down adapter processes, refresh fibres, temp files) BEFORE
//      creating the replacement — `reconcile` guarantees "at most one live
//      instance per id" at all times.
//   3. Opens a fresh child `Scope` for every added or replaced entry, runs
//      the driver's `create`, and stores the resulting `ProviderInstance`
//      plus its scope.
//   4. Publishes one `void` tick on the registry's `streamChanges` PubSub at
//      the end of the batch — consumers re-pull `listInstances` /
//      `listUnavailable`.
//
// `reconcile` is idempotent: calling it with an unchanged config map is a
// no-op (no scope churn, no pubsub emission).
//
// @module provider/Services/ProviderInstanceRegistryMutator
import type { ProviderInstanceConfigMap, ProviderInstanceId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export class ProviderInstanceLifecycleReconcileError extends Schema.TaggedErrorClass<ProviderInstanceLifecycleReconcileError>()(
  'ProviderInstanceLifecycleReconcileError',
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
{
  override get message(): string
  {
    return `Provider instance lifecycle reconciliation failed: ${this.detail}`
  }
}

export interface ProviderInstanceRegistryLifecycleOwner
{
  // serialize every settings mutation with provider command admission and
  // shutdown. The id list is empty for addition-only and no-op snapshots.
  readonly aroundMutation: <A, E, R>(
    retiringInstanceIds: ReadonlyArray<ProviderInstanceId>,
    mutation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderInstanceLifecycleReconcileError, R>
}

export interface ProviderInstanceRegistryMutatorShape
{
  // bring the live registry in line with the supplied config map. See
  // module docs for the add / remove / replace semantics.
  //
  // driver `create` failures are captured as "unavailable" shadow
  // snapshots. Retiring a live route can still fail closed when its
  // lifecycle owner cannot durably close every exact provider generation.
  readonly reconcile: (
    configMap: ProviderInstanceConfigMap,
  ) => Effect.Effect<void, ProviderInstanceLifecycleReconcileError>
  readonly registerLifecycleOwner: (
    owner: ProviderInstanceRegistryLifecycleOwner,
  ) => Effect.Effect<void>
  readonly unregisterLifecycleOwner: (
    owner: ProviderInstanceRegistryLifecycleOwner,
  ) => Effect.Effect<void>
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()('456code/provider/Services/ProviderInstanceRegistryMutator')
{}
