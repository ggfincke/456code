// apps/server/src/observability/Metrics.ts
// defines low-cardinality runtime metrics and recording helpers

import type { ArchitectureToolErrorCode } from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Metric from 'effect/Metric'
import { dual } from 'effect/Function'

import {
  compactMetricAttributes,
  normalizeModelMetricLabel,
  outcomeFromExit,
} from './Attributes.ts'

export const rpcRequestsTotal = Metric.counter('t3_rpc_requests_total', {
  description: 'Total RPC requests handled by the websocket RPC server.',
})

export const rpcRequestDuration = Metric.timer('t3_rpc_request_duration', {
  description: 'RPC request handling duration.',
})

export const orchestrationCommandsTotal = Metric.counter('t3_orchestration_commands_total', {
  description: 'Total orchestration commands dispatched.',
})

export const orchestrationCommandDuration = Metric.timer('t3_orchestration_command_duration', {
  description: 'Orchestration command dispatch duration.',
})

export const orchestrationCommandAckDuration = Metric.timer(
  't3_orchestration_command_ack_duration',
  {
    description:
      'Time from orchestration command dispatch to the first committed domain event emitted for that command.',
  },
)

export const orchestrationEventsProcessedTotal = Metric.counter(
  't3_orchestration_events_processed_total',
  {
    description: 'Total orchestration intent events processed by runtime reactors.',
  },
)

export const providerSessionsTotal = Metric.counter('t3_provider_sessions_total', {
  description: 'Total provider session lifecycle operations.',
})

export const providerTurnsTotal = Metric.counter('t3_provider_turns_total', {
  description: 'Total provider turn lifecycle operations.',
})

export const providerTurnDuration = Metric.timer('t3_provider_turn_duration', {
  description: 'Provider turn request duration.',
})

export const providerRuntimeEventsTotal = Metric.counter('t3_provider_runtime_events_total', {
  description: 'Total canonical provider runtime events processed.',
})

export const providerRuntimeInboxRetainedRecords = Metric.gauge(
  't3_provider_runtime_inbox_retained_records',
  {
    description: 'Canonical provider runtime events retained for replay or bounded history.',
  },
)

export const providerRuntimeInboxBacklog = Metric.gauge('t3_provider_runtime_inbox_backlog', {
  description: 'Retained provider runtime events still owed to at least one durable consumer.',
})

export const providerRuntimeInboxOldestPendingAgeSeconds = Metric.gauge(
  't3_provider_runtime_inbox_oldest_pending_age_seconds',
  {
    description: 'Age in seconds of the oldest provider runtime event owed to a consumer.',
  },
)

export const providerRuntimeInboxConsumerLag = Metric.gauge(
  't3_provider_runtime_inbox_consumer_lag',
  {
    description: 'Canonical provider runtime sequence lag by durable consumer.',
  },
)

export const providerRuntimeInboxAdmissionRequired = Metric.gauge(
  't3_provider_runtime_inbox_admission_required',
  {
    description: 'Whether provider runtime admission is active (1) or fenced (0).',
  },
)

export const gitCommandsTotal = Metric.counter('t3_git_commands_total', {
  description: 'Total git commands executed by the server runtime.',
})

export const gitCommandDuration = Metric.timer('t3_git_command_duration', {
  description: 'Git command execution duration.',
})

export const architecturePatchEvaluationDuration = Metric.timer(
  't3_architecture_patch_evaluation_duration',
  {
    description: 'Ephemeral architecture patch evaluation duration.',
  },
)

export const architectureImpactReadDuration = Metric.timer('t3_architecture_impact_read_duration', {
  description: 'Authorized sealed architecture impact read duration.',
})

export const architectureComparisonGenerationDuration = Metric.timer(
  't3_architecture_comparison_generation_duration',
  {
    description: 'Cartographer proposal or diff comparison generation duration.',
  },
)

export const architectureProjectionReadDuration = Metric.timer(
  't3_architecture_projection_read_duration',
  {
    description: 'Authorized bounded native architecture projection duration.',
  },
)

export const architectureGraphViewsTotal = Metric.counter('t3_architecture_graph_views_total', {
  description: 'Total bounded Repository Map and Impact Diff graph projections served.',
})

export const architectureAnalysisAdmissionsTotal = Metric.counter(
  't3_architecture_analysis_admissions_total',
  {
    description: 'Total durable architecture admissions classified by lifecycle outcome.',
  },
)

export const architectureAtlasIndexReadDuration = Metric.timer(
  't3_architecture_atlas_index_read_duration',
  {
    description: 'Sealed standing-project Atlas index verification and read duration.',
  },
)

export const architectureAtlasPublicationDuration = Metric.timer(
  't3_architecture_atlas_publication_duration',
  {
    description: 'Standing-project Atlas generation and atomic publication duration.',
  },
)

export const architectureAutoAnalysisActionsTotal = Metric.counter(
  't3_architecture_auto_analysis_actions_total',
  {
    description: 'Total durable automatic architecture analysis actions handled.',
  },
)

export const architectureAutoAnalysisActionDuration = Metric.timer(
  't3_architecture_auto_analysis_action_duration',
  {
    description: 'Automatic architecture analysis admission duration.',
  },
)

export const terminalSessionsTotal = Metric.counter('t3_terminal_sessions_total', {
  description: 'Total terminal sessions started.',
})

export const terminalRestartsTotal = Metric.counter('t3_terminal_restarts_total', {
  description: 'Total terminal restart requests handled.',
})

export const restartReconciliationRunsTotal = Metric.counter(
  't3_server_restart_reconciliation_runs_total',
  {
    description: 'Total bounded restart reconciliation runs.',
  },
)

export const restartReconciliationItemsTotal = Metric.counter(
  't3_server_restart_reconciliation_items_total',
  {
    description: 'Total items classified by restart reconciliation.',
  },
)

export const restartReconciliationDuration = Metric.timer(
  't3_server_restart_reconciliation_duration',
  {
    description: 'Restart reconciliation duration.',
  },
)

export const metricAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<[string, string]> => Object.entries(compactMetricAttributes(attributes))

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Readonly<Record<string, unknown>>,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount)

type ArchitectureGraphViewAnchorMetric = 'none' | 'matched' | 'ambiguous' | 'unmatched' | 'stale'
type ArchitectureGraphViewOmissionMetric = 'none' | 'nodes' | 'edges' | 'evidence' | 'multiple'
type ArchitectureGraphViewResultMetric =
  'graph' | 'no-impact' | 'pending' | 'unavailable' | 'failed'

interface ArchitectureGraphViewMetricAttributes extends Readonly<Record<string, string>>
{
  readonly authority: 'standing' | 'planned' | 'verified'
  readonly result: 'graph' | 'no-impact'
  readonly lens: 'architecture' | 'structure'
  readonly freshness: 'fresh' | 'dirty' | 'stale' | 'reverted'
  readonly omission: ArchitectureGraphViewOmissionMetric
  readonly anchor: ArchitectureGraphViewAnchorMetric
}

export function architectureGraphViewMetricAttributes(projection: {
  readonly authority: 'standing' | 'planned' | 'verified'
  readonly resultState: 'graph' | 'no-impact'
  readonly lens: 'architecture' | 'structure'
  readonly freshness: 'fresh' | 'dirty' | 'stale' | 'reverted'
  readonly totals: {
    readonly nodes: { readonly omitted: number }
    readonly edges: { readonly omitted: number }
    readonly evidence: { readonly omitted: number }
    readonly changedFiles: { readonly omitted: number }
  }
  readonly anchors: ReadonlyArray<{
    readonly status: 'matched' | 'ambiguous' | 'unmatched' | 'stale'
  }>
}): ArchitectureGraphViewMetricAttributes
{
  const anchorStatuses = new Set(projection.anchors.map((anchor) => anchor.status))
  const omissionKinds: ArchitectureGraphViewOmissionMetric[] = [
    ...(projection.totals.nodes.omitted > 0 ? (['nodes'] as const) : []),
    ...(projection.totals.edges.omitted > 0 ? (['edges'] as const) : []),
    ...(projection.totals.evidence.omitted > 0 || projection.totals.changedFiles.omitted > 0
      ? (['evidence'] as const)
      : []),
  ]
  const omission: ArchitectureGraphViewOmissionMetric =
    omissionKinds.length === 0
      ? 'none'
      : omissionKinds.length === 1
        ? omissionKinds[0]!
        : 'multiple'
  // one bounded view can carry many anchors; record the most actionable state
  const anchorStatus: ArchitectureGraphViewAnchorMetric = anchorStatuses.has('stale')
    ? 'stale'
    : anchorStatuses.has('ambiguous')
      ? 'ambiguous'
      : anchorStatuses.has('unmatched')
        ? 'unmatched'
        : anchorStatuses.has('matched')
          ? 'matched'
          : 'none'
  return {
    authority: projection.authority,
    result: projection.resultState,
    lens: projection.lens,
    freshness: projection.freshness,
    omission,
    anchor: anchorStatus,
  }
}

export function architectureGraphViewErrorMetricAttributes(code: ArchitectureToolErrorCode): {
  readonly result: Exclude<ArchitectureGraphViewResultMetric, 'graph' | 'no-impact'>
}
{
  if (code === 'context-not-ready') return { result: 'pending' }
  if (
    code === 'capability-unavailable' ||
    code === 'not-found' ||
    code === 'target-not-found' ||
    code === 'unsupported'
  )
  {
    return { result: 'unavailable' }
  }
  return { result: 'failed' }
}

interface ArchitectureAdmissionMetricAttributes extends Readonly<Record<string, string>>
{
  readonly kind: 'planned-anchor' | 'proposal-verified'
  readonly outcome: 'queued' | 'reused' | 'complete' | 'retry' | 'terminal-failed' | 'cancelled'
}

export function architectureAdmissionMetricAttributes(
  kind: ArchitectureAdmissionMetricAttributes['kind'],
  outcome: ArchitectureAdmissionMetricAttributes['outcome'],
): ArchitectureAdmissionMetricAttributes
{
  return { kind, outcome }
}

export interface WithMetricsOptions
{
  readonly counter?: Metric.Metric<number, unknown>
  readonly timer?: Metric.Metric<Duration.Duration, unknown>
  readonly attributes?:
    Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>)
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>
}

export const recordMetrics = Effect.fn('Metrics.recordMetrics')(function* <E>(input: {
  readonly startedAt: bigint
  readonly exit: Exit.Exit<unknown, E>
  readonly counter?: Metric.Metric<number, unknown>
  readonly timer?: Metric.Metric<Duration.Duration, unknown>
  readonly attributes?:
    Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>)
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>
})
{
  const endedAt = yield* Clock.currentTimeNanos
  const elapsedNanos = endedAt > input.startedAt ? endedAt - input.startedAt : 0n
  const duration = Duration.nanos(elapsedNanos)
  const baseAttributes =
    typeof input.attributes === 'function' ? input.attributes() : (input.attributes ?? {})

  if (input.timer)
  {
    yield* Metric.update(
      Metric.withAttributes(input.timer, metricAttributes(baseAttributes)),
      duration,
    )
  }

  if (input.counter)
  {
    const outcome = outcomeFromExit(input.exit)
    yield* Metric.update(
      Metric.withAttributes(
        input.counter,
        metricAttributes({
          ...baseAttributes,
          outcome,
          ...(input.outcomeAttributes ? input.outcomeAttributes(outcome) : {}),
        }),
      ),
      1,
    )
  }
})

const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* ()
  {
    const startedAt = yield* Clock.currentTimeNanos
    const exit = yield* Effect.exit(effect)
    yield* recordMetrics({ startedAt, exit, ...options })

    if (Exit.isSuccess(exit))
    {
      return exit.value
    }
    return yield* Effect.failCause(exit.cause)
  })

export const withMetrics: {
  <A, E, R>(options: WithMetricsOptions): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>
} = dual(2, withMetricsImpl)

export const providerMetricAttributes = (
  provider: string,
  extra?: Readonly<Record<string, unknown>>,
) =>
  compactMetricAttributes({
    provider,
    ...extra,
  })

export const providerTurnMetricAttributes = (input: {
  readonly provider: string
  readonly model: string | null | undefined
  readonly extra?: Readonly<Record<string, unknown>>
}) =>
{
  const modelFamily = normalizeModelMetricLabel(input.model)
  return compactMetricAttributes({
    provider: input.provider,
    ...(modelFamily ? { modelFamily } : {}),
    ...input.extra,
  })
}
