// apps/server/src/recovery/RuntimeRecoveryPolicy.ts
// owns the effect-specific allowlist for operator recovery mutations

import type {
  RuntimeRecoveryAllowedAction,
  RuntimeRecoveryBlockedReactorStatus,
  RuntimeRecoveryEffectAction,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

export interface RuntimeRecoveryEffectPolicyView
{
  readonly owner: string
  readonly summary: string
  readonly blastRadiusSummary: string
  readonly allowedActions: ReadonlyArray<RuntimeRecoveryAllowedAction>
}

interface RuntimeRecoveryEffectPolicy
{
  readonly reactorId: string
  readonly effectKind: string
  readonly operationVersion: number
  readonly owner: string
  readonly summary: string
  readonly blastRadiusSummary: string
  readonly actions: ReadonlyArray<{
    readonly action: RuntimeRecoveryEffectAction
    readonly allowedStatuses: ReadonlySet<RuntimeRecoveryBlockedReactorStatus>
    readonly confirmation: RuntimeRecoveryAllowedAction['confirmation']
    readonly description: string
  }>
}

export class RuntimeRecoveryPolicyDeniedError extends Schema.TaggedErrorClass<RuntimeRecoveryPolicyDeniedError>()(
  'RuntimeRecoveryPolicyDeniedError',
  {
    reason: Schema.Literals([
      'effect-not-declared',
      'action-not-declared',
      'status-not-recoverable',
      'confirmation-required',
    ]),
  },
)
{}

export interface RuntimeRecoveryPolicyRegistryShape
{
  readonly describe: (input: {
    readonly reactorId: string
    readonly effectKind: string
    readonly operationVersion: number
    readonly status: RuntimeRecoveryBlockedReactorStatus
  }) => RuntimeRecoveryEffectPolicyView
  readonly authorize: (input: {
    readonly reactorId: string
    readonly effectKind: string
    readonly operationVersion: number
    readonly status: RuntimeRecoveryBlockedReactorStatus
    readonly action: RuntimeRecoveryEffectAction
    readonly confirmation: string
  }) => Effect.Effect<void, RuntimeRecoveryPolicyDeniedError>
}

export class RuntimeRecoveryPolicyRegistry extends Context.Service<
  RuntimeRecoveryPolicyRegistry,
  RuntimeRecoveryPolicyRegistryShape
>()('456code/recovery/RuntimeRecoveryPolicy/RuntimeRecoveryPolicyRegistry')
{}

const architectureDiffAnalysisPolicy: RuntimeRecoveryEffectPolicy = {
  reactorId: 'architecture-auto-analysis',
  effectKind: 'architecture.diff-analysis.request',
  operationVersion: 1,
  owner: 'architecture-auto-analysis',
  summary: 'Automatic architecture diff analysis is blocked after exhausting normal retries.',
  blastRadiusSummary:
    'Retry re-enters the normal owner path, which revalidates the live checkpoint identity and uses canonical generation deduplication.',
  actions: [
    {
      action: 'retry',
      allowedStatuses: new Set(['manual']),
      confirmation: 'retry-owner-declared-idempotent',
      description:
        'Retry through the architecture analysis owner after confirming the current failure is transient or repaired.',
    },
  ],
}

const providerRuntimeInboxPolicy = (reactorId: string): RuntimeRecoveryEffectPolicy => ({
  reactorId,
  effectKind: 'provider.runtime-event.consume',
  operationVersion: 1,
  owner: reactorId,
  summary:
    'A durable provider runtime event consumer stopped because it could not safely classify or apply the event.',
  blastRadiusSummary:
    'Later provider events may be blocked for this consumer while the independent ingestion and checkpoint consumers retain separate progress.',
  actions: [],
})

const providerRuntimeIngestionPolicy = providerRuntimeInboxPolicy('provider-runtime-ingestion')
const providerRuntimeCheckpointPolicy = providerRuntimeInboxPolicy('provider-runtime-checkpoint')

const threadArchivePolicy: RuntimeRecoveryEffectPolicy = {
  reactorId: 'thread-archive',
  effectKind: 'thread.archive.cleanup-exact',
  operationVersion: 1,
  owner: 'thread-archive',
  summary: 'Exact provider and terminal cleanup for one archive generation is blocked.',
  blastRadiusSummary:
    'The owner preserves terminal history and will not replace the provider or terminal identities persisted at materialization; the diagnostic exposes the generation target and a digest of that redacted identity set.',
  actions: [],
}

const policyKey = (input: {
  readonly reactorId: string
  readonly effectKind: string
  readonly operationVersion: number
}): string => JSON.stringify([input.reactorId, input.effectKind, input.operationVersion])

const policies = new Map<string, RuntimeRecoveryEffectPolicy>([
  [policyKey(architectureDiffAnalysisPolicy), architectureDiffAnalysisPolicy],
  [policyKey(providerRuntimeIngestionPolicy), providerRuntimeIngestionPolicy],
  [policyKey(providerRuntimeCheckpointPolicy), providerRuntimeCheckpointPolicy],
  [policyKey(threadArchivePolicy), threadArchivePolicy],
])

const describe: RuntimeRecoveryPolicyRegistryShape['describe'] = (input) =>
{
  const policy = policies.get(policyKey(input))
  if (policy === undefined)
  {
    return {
      owner: 'unregistered',
      summary: 'This effect has no declared operator recovery policy and is read-only.',
      blastRadiusSummary:
        'The effect remains blocked until its owning domain supplies a verified recovery path.',
      allowedActions: [],
    }
  }
  return {
    owner: policy.owner,
    summary: policy.summary,
    blastRadiusSummary: policy.blastRadiusSummary,
    allowedActions: policy.actions
      .filter((candidate) => candidate.allowedStatuses.has(input.status))
      .map(({ action, confirmation, description }) => ({
        action,
        confirmation,
        description,
      })),
  }
}

const authorize: RuntimeRecoveryPolicyRegistryShape['authorize'] = (input) =>
  Effect.gen(function* ()
  {
    const policy = policies.get(policyKey(input))
    if (policy === undefined)
    {
      return yield* new RuntimeRecoveryPolicyDeniedError({ reason: 'effect-not-declared' })
    }
    const action = policy.actions.find((candidate) => candidate.action === input.action)
    if (action === undefined)
    {
      return yield* new RuntimeRecoveryPolicyDeniedError({ reason: 'action-not-declared' })
    }
    if (!action.allowedStatuses.has(input.status))
    {
      return yield* new RuntimeRecoveryPolicyDeniedError({ reason: 'status-not-recoverable' })
    }
    if (action.confirmation !== input.confirmation)
    {
      return yield* new RuntimeRecoveryPolicyDeniedError({ reason: 'confirmation-required' })
    }
  })

export const RuntimeRecoveryPolicyRegistryLive = Layer.succeed(
  RuntimeRecoveryPolicyRegistry,
  RuntimeRecoveryPolicyRegistry.of({ describe, authorize }),
)
