// apps/server/src/provider/Layers/ProviderService.ts
// implements dynamic provider routing and session recovery

// ProviderServiceLive - Cross-provider orchestration layer.
//
// routes validated transport/API calls to provider adapters through
// `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
// unified provider event stream for subscribers.
//
// it does not implement provider protocol details (adapter concern).
//
// @module ProviderServiceLive
import * as NodeCrypto from 'node:crypto'

import {
  EventId,
  ModelSelection,
  NonNegativeInt,
  ProviderContinuationIdentity,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderContinuationIdentity as ProviderContinuationIdentityType,
  type ProviderRuntimeEvent,
  type ProviderRuntimeModeWarning,
  type RuntimeMode,
  type ProviderSession,
} from '@t3tools/contracts'
import { causeErrorTag } from '@t3tools/shared/observability'
import { stableStringify } from '@t3tools/shared/relaySigning'
import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as Semaphore from 'effect/Semaphore'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from '../../observability/Metrics.ts'
import { type ProviderAdapterError, ProviderValidationError } from '../Errors.ts'
import type {
  ProviderAdapterCapabilities,
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
  ProviderAdapterSessionStartInput,
  ProviderAdapterShape,
  ProviderEffectContext,
} from '../Services/ProviderAdapter.ts'
import * as ProviderAdapterRegistry from '../Services/ProviderAdapterRegistry.ts'
import { ProviderBackgroundTaskRegistry } from '../Services/ProviderBackgroundTaskRegistry.ts'
import * as ProviderService from '../Services/ProviderService.ts'
import * as ProviderSessionDirectory from '../Services/ProviderSessionDirectory.ts'
import { type EventNdjsonLogger } from './EventNdjsonLogger.ts'
import * as ProviderEventLoggers from './ProviderEventLoggers.ts'
import * as AnalyticsService from '../../telemetry/Services/AnalyticsService.ts'
import * as McpSessionRegistry from '../../mcp/McpSessionRegistry.ts'
import * as ServerSettings from '../../serverSettings.ts'
import { applyOrchestrateModeInstructions } from '../CollaborationModeInstructions.ts'
import {
  coerceSupportedRuntimeMode,
  providerBaseInteractionMode,
  supportsTurnMode,
} from '../providerCapabilities.ts'
import { observeHiddenTurnRuntimeEvent } from '../HiddenTurnRegistry.ts'
import {
  ProviderRuntimeInbox,
  ProviderRuntimeInboxAdmissionError,
  type ProviderRuntimeInboxAppendResult,
  type ProviderRuntimeInboxSession,
  type ProviderRuntimeSessionIdentity,
} from '../../persistence/Services/ProviderRuntimeInbox.ts'
import type { PersistenceSqlError } from '../../persistence/Errors.ts'
import { ProjectionSnapshotQuery } from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import { ThreadArchiveLifecyclePermit } from '../../orchestration/Services/ThreadArchiveLifecyclePermit.ts'
import {
  ProviderInstanceLifecycleReconcileError,
  ProviderInstanceRegistryMutator,
  type ProviderInstanceRegistryLifecycleOwner,
  type ProviderInstanceRegistryMutatorShape,
} from '../Services/ProviderInstanceRegistryMutator.ts'
import { makeKeyedSemaphore } from './KeyedSemaphore.ts'
const isModelSelection = Schema.is(ModelSelection)
const isProviderContinuationIdentity = Schema.is(ProviderContinuationIdentity)
const isProviderRuntimeInboxAdmissionError = Schema.is(ProviderRuntimeInboxAdmissionError)

/**
 * Construction overrides for focused service tests. Production wiring
 * injects the registry mutator explicitly so settings retirement cannot
 * bypass provider lifecycle ownership.
 */
export interface ProviderServiceLiveOptions
{
  readonly canonicalEventLogger?: EventNdjsonLogger
  readonly registryMutator?: ProviderInstanceRegistryMutatorShape
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService['Service']> =
  ProviderService.ProviderService['Service'][Name]

type RuntimeEventAdmissionError = ProviderRuntimeInboxAdmissionError | ProviderValidationError

type AdapterReconciliation =
  | { readonly _tag: 'ready' }
  | { readonly _tag: 'quarantined' }
  | { readonly _tag: 'waiting' }
  | {
      readonly _tag: 'retry-cleanup'
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>
    }

type QuarantinedAdapterState = Map<
  ProviderInstanceId,
  {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>
    readonly cleanupState: 'pending' | 'running' | 'complete'
    readonly reconcileAfterCleanup: boolean
  }
>

interface AdapterRoutingState
{
  readonly subscribed: Map<
    ProviderInstanceId,
    {
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>
      readonly fiber: Fiber.Fiber<void, never>
    }
  >
  readonly quarantined: QuarantinedAdapterState
  readonly reconfiguring: ReadonlySet<ProviderInstanceId>
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
  expectedProviderInstanceId: ProviderInstanceId,
})

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError
{
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  })
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string
  readonly schema: S
  readonly payload: unknown
}) =>
{
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema)
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  )
}

function toRuntimeStatus(session: ProviderSession): 'starting' | 'running' | 'stopped' | 'error'
{
  switch (session.status)
  {
    case 'connecting':
      return 'starting'
    case 'error':
      return 'error'
    case 'closed':
      return 'stopped'
    case 'ready':
    case 'running':
    default:
      return 'running'
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly continuationIdentity?: ProviderContinuationIdentityType
    readonly modelSelection?: unknown
    readonly lastRuntimeEvent?: string
    readonly lastRuntimeEventAt?: string
    readonly runtimeModeAcknowledgements?: RuntimeModeAcknowledgementState | null
  },
): Record<string, unknown>
{
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.continuationIdentity !== undefined
      ? { continuationIdentity: extra.continuationIdentity }
      : {}),
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.runtimeModeAcknowledgements !== undefined
      ? { runtimeModeAcknowledgements: extra.runtimeModeAcknowledgements }
      : {}),
  }
}

interface RuntimeModeAcknowledgementState
{
  readonly providerInstanceId: string
  readonly threadId: ThreadId
  readonly runtimeMode: RuntimeMode
  readonly continuationKey: string
  readonly warningFingerprint: string
  readonly warningIds: ReadonlyArray<string>
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readPersistedRuntimeModeAcknowledgements(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding['runtimePayload'],
): RuntimeModeAcknowledgementState | undefined
{
  if (!isRecord(runtimePayload) || !isRecord(runtimePayload.runtimeModeAcknowledgements))
  {
    return undefined
  }
  const value = runtimePayload.runtimeModeAcknowledgements
  if (
    typeof value.providerInstanceId !== 'string' ||
    typeof value.threadId !== 'string' ||
    typeof value.runtimeMode !== 'string' ||
    typeof value.continuationKey !== 'string' ||
    typeof value.warningFingerprint !== 'string' ||
    !Array.isArray(value.warningIds) ||
    !value.warningIds.every((id): id is string => typeof id === 'string')
  )
  {
    return undefined
  }
  return value as unknown as RuntimeModeAcknowledgementState
}

function runtimeModeWarningFingerprint(
  warnings: ReadonlyArray<ProviderRuntimeModeWarning>,
): string
{
  return stableStringify(
    warnings.map((warning) => ({
      id: warning.id,
      mode: warning.mode,
      severity: warning.severity,
      message: warning.message,
      requiresAcknowledgement: warning.requiresAcknowledgement,
    })),
  )
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding['runtimePayload'],
): ModelSelection | undefined
{
  if (!runtimePayload || typeof runtimePayload !== 'object' || Array.isArray(runtimePayload))
  {
    return undefined
  }
  const raw = 'modelSelection' in runtimePayload ? runtimePayload.modelSelection : undefined
  return isModelSelection(raw) ? raw : undefined
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding['runtimePayload'],
): string | undefined
{
  if (!runtimePayload || typeof runtimePayload !== 'object' || Array.isArray(runtimePayload))
  {
    return undefined
  }
  const rawCwd = 'cwd' in runtimePayload ? runtimePayload.cwd : undefined
  if (typeof rawCwd !== 'string') return undefined
  const trimmed = rawCwd.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readPersistedContinuationIdentity(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding['runtimePayload'],
): ProviderContinuationIdentityType | undefined
{
  if (!runtimePayload || typeof runtimePayload !== 'object' || Array.isArray(runtimePayload))
  {
    return undefined
  }
  const raw =
    'continuationIdentity' in runtimePayload ? runtimePayload.continuationIdentity : undefined
  return isProviderContinuationIdentity(raw) ? raw : undefined
}

function continuationIdentitiesEqual(
  left: ProviderContinuationIdentityType,
  right: ProviderContinuationIdentityType,
): boolean
{
  return left.driverKind === right.driverKind && left.continuationKey === right.continuationKey
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined
    readonly provider?: ProviderDriverKind | undefined
  },
): ProviderInstanceId =>
{
  if (payload.providerInstanceId !== undefined)
  {
    return payload.providerInstanceId
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  )
}

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId
    readonly provider: ProviderDriverKind
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent =>
{
  if (event.provider !== source.provider)
  {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    )
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId)
  {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    )
  }
  return { ...event, providerInstanceId: source.instanceId }
}

const validateRuntimeEventBinding = (
  binding: ProviderAdapterRuntimeSessionBinding,
  event: ProviderRuntimeEvent,
): void =>
{
  const providerInstanceId = dieOnMissingBindingInstanceId('ProviderService.streamEvents', event)
  if (binding.providerInstanceId !== providerInstanceId || binding.threadId !== event.threadId)
  {
    throw new Error(
      `ProviderService.streamEvents: runtime event '${event.eventId}' does not match its originating provider session binding.`,
    )
  }
}

const makeProviderService = Effect.fn('makeProviderService')(function* (
  options?: ProviderServiceLiveOptions,
)
{
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService)
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers
  // options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry
  const contextualRegistryMutator = yield* Effect.serviceOption(ProviderInstanceRegistryMutator)
  const registryMutator =
    options?.registryMutator === undefined
      ? contextualRegistryMutator
      : Option.some(options.registryMutator)
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
  const backgroundTasks = yield* ProviderBackgroundTaskRegistry
  const mcpSessionRegistry = yield* McpSessionRegistry.McpSessionRegistry
  const serverSettings = yield* ServerSettings.ServerSettingsService
  const runtimeInbox = yield* ProviderRuntimeInbox
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
  const threadArchiveLifecyclePermit = yield* ThreadArchiveLifecyclePermit
  const subscriptionScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(subscriptionScope, exit))
  const crypto = yield* Crypto.Crypto
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>()
  const adapterReconcileWakeups = yield* PubSub.unbounded<void>()
  const sessionLifecycleLocks = yield* makeKeyedSemaphore<ThreadId>()
  const adapterLifecycleLocks = yield* makeKeyedSemaphore<ProviderInstanceId>()
  const shuttingDown = yield* Ref.make(false)
  const shutdownHighWater = yield* Ref.make<Option.Option<number>>(Option.none())
  const shutdownGate = yield* Semaphore.make(1)
  const providerInstanceMutationGate = yield* Semaphore.make(1)
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
  const admissionOwnerId = yield* crypto.randomUUIDv4
  const admission = yield* runtimeInbox.claimAdmissionOwner({
    ownerId: admissionOwnerId,
    now: yield* nowIso,
  })
  const beginRuntimeSession = Effect.fn('ProviderService.beginRuntimeSession')(function* (
    provider: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    threadId: ThreadId,
  )
  {
    const session = yield* runtimeInbox.beginSession({
      ownerId: admissionOwnerId,
      ownerGeneration: admission.ownerGeneration,
      provider,
      providerInstanceId,
      threadId,
      now: yield* nowIso,
    })
    return session
  })
  const beginRuntimeSessionForService = (
    operation: string,
    provider: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    threadId: ThreadId,
  ) =>
    beginRuntimeSession(provider, providerInstanceId, threadId).pipe(
      Effect.mapError((cause) =>
        toValidationError(
          operation,
          'Unable to establish durable provider session identity.',
          cause,
        ),
      ),
    )
  const prepareMcpSession = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    providerSessionGeneration: number,
  ) =>
    Effect.gen(function* ()
    {
      const browserAccessEnabled = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.enableAgentBrowserAccess),
        Effect.catch((cause) =>
          Effect.logWarning('Could not read settings; withholding agent browser access.', {
            cause,
          }).pipe(Effect.as(false)),
        ),
      )
      const capabilities = new Set<import('../../mcp/McpInvocationContext.ts').McpCapability>([
        'proposal',
        'orchestrate',
        'architecture',
      ])
      if (browserAccessEnabled) capabilities.add('preview')
      return yield* mcpSessionRegistry
        .issue({ threadId, providerInstanceId, providerSessionGeneration, capabilities })
        .pipe(Effect.map((credential) => credential?.config))
    })
  const clearExactMcpSession = (identity: ProviderAdapterRuntimeSessionBinding) =>
    mcpSessionRegistry.revokeExact({
      threadId: identity.threadId,
      providerInstanceId: identity.providerInstanceId,
      providerSessionGeneration: identity.sessionGeneration,
    })
  const requireRunning = (operation: string) =>
    Ref.get(shuttingDown).pipe(
      Effect.filterOrFail(
        (value) => !value,
        () => toValidationError(operation, 'Provider runtime shutdown has started.'),
      ),
      Effect.asVoid,
    )

  const requireActiveThread = (operation: string, threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.mapError((cause) =>
        toValidationError(
          operation,
          `Unable to confirm that thread '${threadId}' is active before creating a provider lifecycle.`,
          cause,
        ),
      ),
      Effect.filterOrFail(Option.isSome, () =>
        toValidationError(
          operation,
          `Thread '${threadId}' is archived, deleted, or unavailable; provider lifecycle creation is not allowed.`,
        ),
      ),
      Effect.asVoid,
    )

  const withActiveThreadLifecycle = <A, E, R>(
    operation: string,
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) =>
    threadArchiveLifecyclePermit.withPermit(
      threadId,
      requireActiveThread(operation, threadId).pipe(Effect.andThen(effect)),
    )

  const admitRuntimeEvent: (
    binding: ProviderAdapterRuntimeSessionBinding,
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<ProviderRuntimeInboxAppendResult, RuntimeEventAdmissionError> = Effect.fn(
    'ProviderService.admitRuntimeEvent',
  )(function* (binding: ProviderAdapterRuntimeSessionBinding, event: ProviderRuntimeEvent)
  {
    yield* Effect.sync(() => validateRuntimeEventBinding(binding, event))
    const providerInstanceId = dieOnMissingBindingInstanceId(
      'ProviderService.admitRuntimeEvent',
      event,
    )
    const eventJson = stableStringify(event)
    const eventDigest = NodeCrypto.createHash('sha256').update(eventJson).digest('hex')
    const receivedAt = yield* nowIso
    let attempt = 0
    while (true)
    {
      const result = yield* Effect.result(
        runtimeInbox.append({
          ownerId: admissionOwnerId,
          ownerGeneration: admission.ownerGeneration,
          provider: event.provider,
          providerInstanceId,
          threadId: event.threadId,
          sessionGeneration: binding.sessionGeneration,
          sourceEventId: event.eventId,
          eventType: event.type,
          eventCreatedAt: event.createdAt,
          receivedAt,
          eventJson,
          eventDigest,
        }),
      )
      if (Result.isSuccess(result))
      {
        return result.success
      }
      if (
        isProviderRuntimeInboxAdmissionError(result.failure) &&
        result.failure.reason !== 'fenced'
      )
      {
        yield* Effect.logError('provider runtime admission terminated its provider subscription', {
          eventId: event.eventId,
          eventType: event.type,
          reason: result.failure.reason,
          detail: result.failure.detail,
        })
        return yield* result.failure
      }
      attempt += 1
      if (attempt === 1 || attempt % 20 === 0)
      {
        yield* Effect.logError('provider runtime admission is backpressured', {
          eventId: event.eventId,
          eventType: event.type,
          attempt,
          cause: result.failure.message,
        })
      }
      yield* Effect.sleep(250)
    }
  })

  const shouldRefreshLastSeenAt = (event: ProviderRuntimeEvent): boolean =>
    event.type === 'turn.completed' ||
    (event.type === 'session.state.changed' && event.payload.state === 'ready')

  const refreshSessionLastSeenAt = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    directory.getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
      {
        const current = Option.getOrUndefined(binding)
        if (current === undefined || current.providerInstanceId !== providerInstanceId)
        {
          return Effect.void
        }
        return directory.upsert({
          threadId: current.threadId,
          provider: current.provider,
          providerInstanceId,
        })
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning('provider.session.last-seen.refresh-failed', {
          threadId,
          providerInstanceId,
          cause,
        }),
      ),
    )

  // refresh durable session state from the adapter that accepted the event.
  // the adapter binding and inbox generation are both checked so a late event
  // from a retired process cannot overwrite a replacement session's cursor.
  const refreshSessionBindingFromAdapter = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    binding: ProviderAdapterRuntimeSessionBinding,
    event: ProviderRuntimeEvent,
  ) =>
    Effect.gen(function* ()
    {
      const adapterBinding = yield* adapter.getSessionRuntimeBinding(binding.threadId)
      if (
        adapterBinding === undefined ||
        adapterBinding.providerInstanceId !== binding.providerInstanceId ||
        adapterBinding.threadId !== binding.threadId ||
        adapterBinding.sessionGeneration !== binding.sessionGeneration
      )
      {
        return false
      }

      const currentRuntime = Option.getOrUndefined(
        yield* runtimeInbox.getCurrentSession({
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
        }),
      )
      if (
        currentRuntime === undefined ||
        currentRuntime.provider !== event.provider ||
        currentRuntime.providerInstanceId !== binding.providerInstanceId ||
        currentRuntime.threadId !== binding.threadId ||
        currentRuntime.sessionGeneration !== binding.sessionGeneration
      )
      {
        return false
      }

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === binding.threadId,
      )
      if (session === undefined)
      {
        return false
      }

      const currentBinding = Option.getOrUndefined(yield* directory.getBinding(binding.threadId))
      if (
        currentBinding === undefined ||
        session.provider !== event.provider ||
        (session.providerInstanceId !== undefined &&
          session.providerInstanceId !== binding.providerInstanceId) ||
        currentBinding.provider !== session.provider ||
        currentBinding.providerInstanceId !== binding.providerInstanceId
      )
      {
        return false
      }

      yield* directory.upsert({
        threadId: binding.threadId,
        provider: session.provider,
        providerInstanceId: binding.providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, {
          lastRuntimeEvent: event.type,
          lastRuntimeEventAt: yield* nowIso,
        }),
      })
      return true
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('provider.session.binding.refresh-failed', {
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
          eventType: event.type,
          cause,
        }).pipe(Effect.as(false)),
      ),
    )

  const publishRuntimeEvent = (
    binding: ProviderAdapterRuntimeSessionBinding,
    event: ProviderRuntimeEvent,
    adapter?: ProviderAdapterShape<ProviderAdapterError>,
  ): Effect.Effect<void, RuntimeEventAdmissionError> =>
    admitRuntimeEvent(binding, event).pipe(
      Effect.flatMap((result) =>
        result.duplicate
          ? Effect.void
          : backgroundTasks.observeAcceptedRuntimeEvent(binding, event).pipe(
              Effect.andThen(observeHiddenTurnRuntimeEvent(event)),
              Effect.andThen(
                increment(providerRuntimeEventsTotal, {
                  provider: event.provider,
                  eventType: event.type,
                }),
              ),
              Effect.andThen(
                canonicalEventLogger
                  ? canonicalEventLogger.write(event, event.threadId)
                  : Effect.void,
              ),
              Effect.andThen(
                shouldRefreshLastSeenAt(event)
                  ? adapter === undefined
                    ? refreshSessionLastSeenAt(event.threadId, binding.providerInstanceId)
                    : refreshSessionBindingFromAdapter(adapter, binding, event).pipe(
                        Effect.flatMap((refreshed) =>
                          refreshed
                            ? Effect.void
                            : refreshSessionLastSeenAt(event.threadId, binding.providerInstanceId),
                        ),
                      )
                  : Effect.void,
              ),
              Effect.andThen(PubSub.publish(runtimeEventPubSub, event)),
              Effect.asVoid,
            ),
      ),
      Effect.tap(() =>
        event.type === 'session.exited' ? clearExactMcpSession(binding) : Effect.void,
      ),
    )

  const matchesRuntimeSessionIdentity = (identity: ProviderRuntimeSessionIdentity) =>
    runtimeInbox
      .matchesCurrentSession(identity)
      .pipe(
        Effect.mapError((cause) =>
          toValidationError(
            'ProviderService.matchesSessionIdentity',
            'Unable to read durable provider session identity.',
            cause,
          ),
        ),
      )

  const awaitSessionExit = Effect.fn('ProviderService.awaitSessionExit')(function* (
    identity: ProviderRuntimeSessionIdentity,
  )
  {
    return yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const wakeups = yield* Queue.dropping<void>(1)
        yield* Stream.runForEach(runtimeInbox.wakeups, () => Queue.offer(wakeups, undefined)).pipe(
          Effect.forkScoped,
        )
        yield* Effect.yieldNow
        for (let attempt = 0; attempt < 200; attempt += 1)
        {
          if (!(yield* matchesRuntimeSessionIdentity(identity)))
          {
            return
          }
          yield* Effect.raceFirst(Queue.take(wakeups), Effect.sleep(50))
        }
        return yield* toValidationError(
          'ProviderService.stopSessionIfExact',
          `Provider session '${identity.providerInstanceId}:${identity.threadId}' generation ${identity.sessionGeneration} did not publish a durably admitted terminal event within 10 seconds.`,
        )
      }),
    )
  })

  const adapterHasExactSession = Effect.fn('ProviderService.adapterHasExactSession')(function* (
    operation: string,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    identity: ProviderRuntimeSessionIdentity,
  )
  {
    if (!(yield* adapter.hasSession(identity.threadId)))
    {
      return false
    }
    const binding = yield* adapter.getSessionRuntimeBinding(identity.threadId)
    if (
      binding === undefined ||
      binding.providerInstanceId !== identity.providerInstanceId ||
      binding.threadId !== identity.threadId ||
      binding.sessionGeneration !== identity.sessionGeneration
    )
    {
      return yield* toValidationError(
        operation,
        'The adapter owns a live session whose durable generation does not match the lifecycle operation.',
      )
    }
    return true
  })

  const ensureExactTerminalAdmission = Effect.fn('ProviderService.ensureExactTerminalAdmission')(
    function* (input: {
      readonly identity: ProviderRuntimeSessionIdentity
      readonly provider: ProviderDriverKind
      readonly eventIdPrefix: string
      readonly reason: string
      readonly exitKind: 'graceful' | 'error'
    })
    {
      yield* publishRuntimeEvent(input.identity, {
        type: 'session.exited',
        eventId: EventId.make(
          `${input.eventIdPrefix}:${input.identity.providerInstanceId}:${input.identity.threadId}:${input.identity.sessionGeneration}`,
        ),
        provider: input.provider,
        providerInstanceId: input.identity.providerInstanceId,
        threadId: input.identity.threadId,
        createdAt: yield* nowIso,
        payload: {
          reason: input.reason,
          recoverable: false,
          exitKind: input.exitKind,
        },
      }).pipe(
        Effect.mapError((cause) =>
          toValidationError(
            'ProviderService.ensureExactTerminalAdmission',
            'Unable to durably admit an exact provider terminal event.',
            cause,
          ),
        ),
      )
    },
  )

  interface AllocatedRuntimeSession
  {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>
    readonly identity: ProviderRuntimeSessionIdentity
    readonly runtimeSession: ProviderRuntimeInboxSession
  }

  const compensateAllocatedRuntimeSession = Effect.fn(
    'ProviderService.compensateAllocatedRuntimeSession',
  )(function* (input: {
    readonly operation: string
    readonly allocated: AllocatedRuntimeSession
    readonly context?: ProviderEffectContext
  })
  {
    const { adapter, identity } = input.allocated
    const wasActive = yield* adapterHasExactSession(input.operation, adapter, identity)
    const stopExit = yield* Effect.exit(
      wasActive
        ? input.context === undefined
          ? adapter.stopSession(identity.threadId)
          : adapter.stopSession(identity.threadId, input.context)
        : Effect.void,
    )
    const stillActive = yield* Effect.exit(
      adapterHasExactSession(input.operation, adapter, identity),
    )
    if (Exit.isFailure(stillActive))
    {
      return yield* Exit.isFailure(stopExit)
        ? Effect.failCause(Cause.combine(stopExit.cause, stillActive.cause))
        : Effect.failCause(stillActive.cause)
    }
    if (stillActive.value)
    {
      return yield* Exit.isFailure(stopExit)
        ? Effect.failCause(stopExit.cause)
        : toValidationError(
            input.operation,
            'The failed provider start still owns a live adapter session; its durable generation remains open for exact cleanup.',
          )
    }

    const terminalExit = yield* Effect.exit(
      wasActive
        ? awaitSessionExit(identity)
        : ensureExactTerminalAdmission({
            identity,
            provider: identity.provider,
            eventIdPrefix: 'provider-session-start-compensated-before-adapter',
            reason: 'Provider session start failed before an adapter lifecycle was established',
            exitKind: 'error',
          }).pipe(Effect.andThen(awaitSessionExit(identity))),
    )

    if (Exit.isSuccess(terminalExit))
    {
      const currentBinding = Option.getOrUndefined(yield* directory.getBinding(identity.threadId))
      if (currentBinding?.providerInstanceId === identity.providerInstanceId)
      {
        yield* directory.upsert({
          threadId: identity.threadId,
          provider: identity.provider,
          providerInstanceId: identity.providerInstanceId,
          status: 'stopped',
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: 'provider.start.compensated',
            lastRuntimeEventAt: yield* nowIso,
          },
        })
      }
    }

    if (Exit.isFailure(stopExit))
    {
      return yield* Exit.isFailure(terminalExit)
        ? Effect.failCause(Cause.combine(stopExit.cause, terminalExit.cause))
        : Effect.failCause(stopExit.cause)
    }
    if (Exit.isFailure(terminalExit))
    {
      return yield* Effect.failCause(terminalExit.cause)
    }
  })

  const withAllocatedRuntimeSession = <A, E, R>(input: {
    readonly operation: string
    readonly provider: ProviderDriverKind
    readonly providerInstanceId: ProviderInstanceId
    readonly threadId: ThreadId
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>
    readonly context?: ProviderEffectContext
    readonly use: (allocated: AllocatedRuntimeSession) => Effect.Effect<A, E, R>
  }) =>
    Effect.acquireUseRelease(
      beginRuntimeSessionForService(
        input.operation,
        input.provider,
        input.providerInstanceId,
        input.threadId,
      ).pipe(
        Effect.map((runtimeSession): AllocatedRuntimeSession => ({
          adapter: input.adapter,
          identity: {
            provider: runtimeSession.provider,
            providerInstanceId: input.providerInstanceId,
            threadId: input.threadId,
            sessionGeneration: runtimeSession.sessionGeneration,
          },
          runtimeSession,
        })),
      ),
      input.use,
      (allocated, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : compensateAllocatedRuntimeSession({
              operation: input.operation,
              allocated,
              ...(input.context === undefined ? {} : { context: input.context }),
            }),
    )

  const stopRuntimeSessionForAdapterStart = Effect.fn(
    'ProviderService.stopRuntimeSessionForAdapterStart',
  )(function* (input: {
    readonly operation: string
    readonly providerInstanceId: ProviderInstanceId
    readonly threadId: ThreadId
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>
    readonly context?: ProviderEffectContext
  })
  {
    const active = yield* input.adapter.hasSession(input.threadId)
    const current = yield* runtimeInbox
      .getCurrentSession({
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
      })
      .pipe(
        Effect.mapError((cause) =>
          toValidationError(
            input.operation,
            'Unable to read durable provider session identity.',
            cause,
          ),
        ),
      )
    if (active)
    {
      const adapterBinding = yield* input.adapter.getSessionRuntimeBinding(input.threadId)
      if (
        adapterBinding === undefined ||
        Option.isNone(current) ||
        adapterBinding.providerInstanceId !== input.providerInstanceId ||
        adapterBinding.threadId !== input.threadId ||
        adapterBinding.sessionGeneration !== current.value.sessionGeneration
      )
      {
        return yield* toValidationError(
          input.operation,
          `Active provider session '${input.providerInstanceId}:${input.threadId}' has no matching durable generation and cannot be replaced safely.`,
        )
      }
      const oldIdentity: ProviderRuntimeSessionIdentity = {
        ...adapterBinding,
        provider: current.value.provider,
      }
      const stop =
        input.context === undefined
          ? input.adapter.stopSession(input.threadId)
          : input.adapter.stopSession(input.threadId, input.context)
      yield* stop
      yield* awaitSessionExit(oldIdentity)
      return Option.some(oldIdentity)
    }
    if (Option.isSome(current))
    {
      const oldIdentity: ProviderRuntimeSessionIdentity = {
        provider: current.value.provider,
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        sessionGeneration: current.value.sessionGeneration,
      }
      const createdAt = yield* nowIso
      yield* publishRuntimeEvent(oldIdentity, {
        type: 'session.exited',
        eventId: EventId.make(
          `provider-session-superseded:${input.providerInstanceId}:${input.threadId}:${oldIdentity.sessionGeneration}`,
        ),
        provider: oldIdentity.provider,
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        createdAt,
        payload: {
          reason: 'Superseded before starting a fresh provider session',
          recoverable: false,
          exitKind: 'graceful',
        },
      }).pipe(
        Effect.mapError((cause) =>
          toValidationError(
            input.operation,
            'Unable to close the prior provider generation.',
            cause,
          ),
        ),
      )
      yield* awaitSessionExit(oldIdentity)
      return Option.some(oldIdentity)
    }
    return Option.none<ProviderRuntimeSessionIdentity>()
  })

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined
      readonly provider?: ProviderDriverKind | undefined
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : 'Provider instance id is required.',
          ),
        )

  const validateAdapterRoute = (input: {
    readonly operation: string
    readonly instanceId: ProviderInstanceId
    readonly expectedProvider: ProviderDriverKind
    readonly route: ProviderAdapterRegistry.ProviderInstanceRoute
    readonly persistedContinuationIdentity?: ProviderContinuationIdentityType
    readonly routingAuthority?: ProviderService.ProviderRoutingAuthority
  }): Effect.Effect<void, ProviderValidationError> =>
  {
    if (
      input.routingAuthority !== undefined &&
      input.routingAuthority.providerInstanceId !== input.instanceId
    )
    {
      return Effect.fail(
        toValidationError(
          input.operation,
          `Provider route authority targets instance '${input.routingAuthority.providerInstanceId}', not '${input.instanceId}'.`,
        ),
      )
    }
    if (
      input.routingAuthority !== undefined &&
      input.routingAuthority.provider !== input.expectedProvider
    )
    {
      return Effect.fail(
        toValidationError(
          input.operation,
          `Provider route authority expects driver '${input.routingAuthority.provider}', but the expected route uses '${input.expectedProvider}'.`,
        ),
      )
    }
    if (
      input.route.info.instanceId !== input.instanceId ||
      input.route.info.driverKind !== input.expectedProvider ||
      input.route.adapter.provider !== input.expectedProvider
    )
    {
      return Effect.fail(
        toValidationError(
          input.operation,
          `Provider instance '${input.instanceId}' is currently backed by driver '${input.route.info.driverKind}' with adapter '${input.route.adapter.provider}', not the ${input.routingAuthority === undefined ? 'expected' : 'authorized'} driver '${input.expectedProvider}'.`,
        ),
      )
    }
    if (!input.route.info.enabled)
    {
      return Effect.fail(
        toValidationError(
          input.operation,
          `Provider instance '${input.instanceId}' is disabled in 456code settings.`,
        ),
      )
    }
    const authorityIdentity = input.routingAuthority?.continuationIdentity
    if (input.routingAuthority !== undefined && authorityIdentity === null)
    {
      return Effect.fail(
        toValidationError(
          input.operation,
          `Provider route authority for instance '${input.instanceId}' has no immutable continuation identity.`,
        ),
      )
    }
    const expectedIdentities = [
      input.persistedContinuationIdentity,
      authorityIdentity ?? undefined,
    ].filter((identity): identity is ProviderContinuationIdentityType => identity !== undefined)
    for (const identity of expectedIdentities)
    {
      if (!continuationIdentitiesEqual(identity, input.route.info.continuationIdentity))
      {
        return Effect.fail(
          toValidationError(
            input.operation,
            `Provider instance '${input.instanceId}' continuation source changed from '${identity.continuationKey}' to '${input.route.info.continuationIdentity.continuationKey}'.`,
          ),
        )
      }
    }
    return Effect.void
  }

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly continuationIdentity?: ProviderContinuationIdentityType
      readonly modelSelection?: unknown
      readonly lastRuntimeEvent?: string
      readonly lastRuntimeEventAt?: string
      readonly runtimeModeAcknowledgements?: RuntimeModeAcknowledgementState | null
    },
  ) =>
    Effect.gen(function* ()
    {
      const providerInstanceId = yield* requireBindingInstanceId(
        'ProviderService.upsertSessionBinding',
        session,
      )
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      })
    })

  const requireContinuationRoute = (
    operation: string,
    route: ProviderAdapterRegistry.ProviderInstanceRoute,
  ): Effect.Effect<void, ProviderValidationError> =>
    route.info.continuationUnavailableReason === undefined
      ? Effect.void
      : Effect.fail(
          toValidationError(
            operation,
            `Provider instance '${route.info.instanceId}' cannot safely continue sessions because ${route.info.continuationUnavailableReason}.`,
          ),
        )

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const adapterRoutingState = yield* Ref.make<AdapterRoutingState>({
    subscribed: new Map(),
    quarantined: new Map(),
    reconfiguring: new Set(),
  })

  const getAdapterEntries = Ref.get(adapterRoutingState).pipe(
    Effect.map((state) =>
      Array.from(
        state.subscribed,
        ([instanceId, subscription]) => [instanceId, subscription.adapter] as const,
      ),
    ),
  )

  const requireHealthyAdapter = (
    operation: string,
    instanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    Ref.get(adapterRoutingState).pipe(
      Effect.filterOrFail(
        (state) =>
          !state.quarantined.has(instanceId) &&
          !state.reconfiguring.has(instanceId) &&
          state.subscribed.get(instanceId)?.adapter === adapter,
        () =>
          toValidationError(
            operation,
            `Provider instance '${instanceId}' is quarantined, reconfiguring, or has no healthy durable runtime-event subscription. Reconcile or rebuild the provider instance before sending more work.`,
          ),
      ),
      Effect.asVoid,
    )

  const requireAdmittingAdapter = (
    operation: string,
    instanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    Ref.get(adapterRoutingState).pipe(
      Effect.filterOrFail(
        (state) =>
          !state.quarantined.has(instanceId) &&
          state.subscribed.get(instanceId)?.adapter === adapter,
        () =>
          toValidationError(
            operation,
            `Provider instance '${instanceId}' has no lifecycle-owned durable runtime-event subscription.`,
          ),
      ),
      Effect.asVoid,
    )

  const beginAdapterQuarantine = (
    instanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    Effect.gen(function* ()
    {
      const claim = yield* Ref.modify(adapterRoutingState, (current) =>
      {
        const existing = current.quarantined.get(instanceId)
        if (
          current.subscribed.get(instanceId)?.adapter !== adapter &&
          existing?.adapter !== adapter
        )
        {
          return ['stale' as const, current]
        }
        if (existing !== undefined && existing.adapter !== adapter)
        {
          return ['blocked' as const, current]
        }
        if (existing?.cleanupState === 'running' || existing?.cleanupState === 'complete')
        {
          return ['already-owned' as const, current]
        }
        const quarantined = new Map(current.quarantined)
        quarantined.set(instanceId, {
          adapter,
          cleanupState: 'running',
          reconcileAfterCleanup: false,
        })
        const subscribed = new Map(current.subscribed)
        if (subscribed.get(instanceId)?.adapter === adapter)
        {
          subscribed.delete(instanceId)
        }
        return ['cleanup-owned' as const, { ...current, subscribed, quarantined }]
      })
      if (claim === 'blocked')
      {
        return yield* toValidationError(
          'ProviderService.quarantineAdapter',
          `Provider instance '${instanceId}' cannot quarantine a replacement adapter before the prior quarantined adapter is durably closed.`,
        )
      }
      if (claim !== 'cleanup-owned')
      {
        return false
      }
      return true
    })

  const markAdapterQuarantinePending = (
    instanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    Ref.update(adapterRoutingState, (current) =>
    {
      const existing = current.quarantined.get(instanceId)
      if (existing !== undefined || current.subscribed.get(instanceId)?.adapter !== adapter)
      {
        return current
      }
      const subscribed = new Map(current.subscribed)
      subscribed.delete(instanceId)
      const quarantined = new Map(current.quarantined)
      quarantined.set(instanceId, {
        adapter,
        cleanupState: 'pending',
        reconcileAfterCleanup: false,
      })
      return { ...current, subscribed, quarantined }
    })

  const updateAdapterQuarantineCleanupState = (
    instanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    cleanupState: 'pending' | 'complete',
  ) =>
    Ref.modify(adapterRoutingState, (current) =>
    {
      const existing = current.quarantined.get(instanceId)
      if (existing?.adapter !== adapter)
      {
        return [false, current]
      }
      const quarantined = new Map(current.quarantined)
      quarantined.set(instanceId, {
        adapter,
        cleanupState,
        reconcileAfterCleanup: false,
      })
      return [existing.reconcileAfterCleanup, { ...current, quarantined }]
    })

  const prepareAdapterReconciliation = (
    instanceId: ProviderInstanceId,
    currentAdapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    Ref.modify(
      adapterRoutingState,
      (current): readonly [AdapterReconciliation, AdapterRoutingState] =>
      {
        const existing = current.quarantined.get(instanceId)
        if (existing === undefined)
        {
          return [{ _tag: 'ready' }, current]
        }
        if (existing.adapter === currentAdapter)
        {
          return [{ _tag: 'quarantined' }, current]
        }
        if (existing.cleanupState === 'running')
        {
          if (existing.reconcileAfterCleanup)
          {
            return [{ _tag: 'waiting' }, current]
          }
          const quarantined = new Map(current.quarantined)
          quarantined.set(instanceId, { ...existing, reconcileAfterCleanup: true })
          return [{ _tag: 'waiting' }, { ...current, quarantined }]
        }
        if (existing.cleanupState === 'pending')
        {
          return [{ _tag: 'retry-cleanup', adapter: existing.adapter }, current]
        }
        const quarantined = new Map(current.quarantined)
        quarantined.delete(instanceId)
        return [{ _tag: 'ready' }, { ...current, quarantined }]
      },
    )

  const cleanupQuarantinedAdapter = (
    instanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    cause: unknown,
  ): Effect.Effect<void, PersistenceSqlError | ProviderValidationError> =>
    Effect.gen(function* ()
    {
      yield* Effect.logError('provider adapter quarantined after durable admission failure', {
        providerInstanceId: instanceId,
        provider: adapter.provider,
        cause,
      })

      const sessions = yield* runtimeInbox.listOpenSessions(instanceId)
      const stopResult = yield* Effect.exit(adapter.stopAll())
      const closeResults = yield* Effect.forEach(
        sessions,
        (session) =>
          Effect.exit(
            Effect.gen(function* ()
            {
              const identity: ProviderRuntimeSessionIdentity = {
                provider: session.provider,
                providerInstanceId: instanceId,
                threadId: session.threadId,
                sessionGeneration: session.sessionGeneration,
              }
              if (
                yield* adapterHasExactSession(
                  'ProviderService.quarantineAdapter',
                  adapter,
                  identity,
                )
              )
              {
                return yield* toValidationError(
                  'ProviderService.quarantineAdapter',
                  `Provider generation '${instanceId}:${session.threadId}:${session.sessionGeneration}' remains live after adapter quarantine cleanup.`,
                )
              }
              yield* ensureExactTerminalAdmission({
                identity,
                provider: identity.provider,
                eventIdPrefix: 'provider-runtime-quarantined-after-adapter-stop',
                reason: 'Provider runtime-event admission failed and quarantined the adapter',
                exitKind: 'error',
              })
              yield* awaitSessionExit(identity)
            }),
          ),
        { concurrency: 'unbounded' },
      )

      const cleanupFailures = [
        ...closeResults.flatMap((result) =>
          Exit.isFailure(result) ? [Cause.squash(result.cause)] : [],
        ),
        ...(Exit.isFailure(stopResult) ? [Cause.squash(stopResult.cause)] : []),
      ]
      if (cleanupFailures.length > 0)
      {
        yield* Effect.logError('quarantined provider adapter cleanup remains incomplete', {
          providerInstanceId: instanceId,
          failures: cleanupFailures.map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          ),
        })
        return yield* toValidationError(
          'ProviderService.quarantineAdapter',
          `Provider instance '${instanceId}' remains quarantined because ${cleanupFailures.length} durable close or adapter stop operation(s) failed.`,
          new AggregateError(cleanupFailures),
        )
      }
    }).pipe(
      Effect.onExit((exit) =>
        updateAdapterQuarantineCleanupState(
          instanceId,
          adapter,
          Exit.isSuccess(exit) ? 'complete' : 'pending',
        ).pipe(
          Effect.flatMap((shouldReconcile) =>
            shouldReconcile
              ? PubSub.publish(adapterReconcileWakeups, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
    )

  const quarantineAdapter = (
    instanceId: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    cause: unknown,
  ): Effect.Effect<void, PersistenceSqlError | ProviderValidationError> =>
    adapterLifecycleLocks.withPermit(
      instanceId,
      Effect.gen(function* ()
      {
        if (!(yield* beginAdapterQuarantine(instanceId, adapter)))
        {
          return
        }
        yield* cleanupQuarantinedAdapter(instanceId, adapter, cause)
      }).pipe(
        Effect.tapCause((cleanupCause) =>
          Effect.logError('provider adapter quarantine cleanup failed closed', {
            providerInstanceId: instanceId,
            cause: cleanupCause,
          }),
        ),
      ),
    )

  const validateRuntimeModeAcknowledgements = (input: {
    readonly threadId: ThreadId
    readonly providerInstanceId: ProviderInstanceId
    readonly runtimeMode: RuntimeMode
    readonly continuationKey: string
    readonly capabilities: ProviderAdapterCapabilities
    readonly persistedBinding?: ProviderSessionDirectory.ProviderRuntimeBinding
    readonly requestedIds: ReadonlyArray<string>
    readonly allowPersisted: boolean
  }): Effect.Effect<RuntimeModeAcknowledgementState | null, ProviderValidationError> =>
  {
    const warnings = input.capabilities.runtimeModeWarnings ?? []
    const applicableWarnings = warnings.filter(
      (warning) => warning.mode === input.runtimeMode && warning.requiresAcknowledgement,
    )
    const warningFingerprint = runtimeModeWarningFingerprint(warnings)
    const warningIds = new Set(applicableWarnings.map((warning) => warning.id))
    const persisted = input.persistedBinding
      ? readPersistedRuntimeModeAcknowledgements(input.persistedBinding.runtimePayload)
      : undefined
    const canReusePersisted =
      input.allowPersisted &&
      persisted?.providerInstanceId === input.providerInstanceId &&
      persisted.threadId === input.threadId &&
      persisted.runtimeMode === input.runtimeMode &&
      persisted.continuationKey === input.continuationKey &&
      persisted.warningFingerprint === warningFingerprint
    const acknowledgedIds = new Set<string>()
    if (canReusePersisted)
    {
      for (const id of persisted.warningIds)
      {
        if (warningIds.has(id)) acknowledgedIds.add(id)
      }
    }
    for (const id of input.requestedIds)
    {
      if (warningIds.has(id)) acknowledgedIds.add(id)
    }
    for (const warning of applicableWarnings)
    {
      if (!acknowledgedIds.has(warning.id))
      {
        return Effect.fail(
          toValidationError(
            'ProviderService.startSession',
            `Runtime mode '${input.runtimeMode}' requires acknowledgement '${warning.id}': ${warning.message}`,
          ),
        )
      }
    }
    if (acknowledgedIds.size === 0)
    {
      return Effect.succeed(null)
    }
    const accepted = Array.from(acknowledgedIds).sort()
    return Effect.logInfo('provider runtime mode warnings acknowledged', {
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      warningIds: accepted,
    }).pipe(
      Effect.as({
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        continuationKey: input.continuationKey,
        warningFingerprint,
        warningIds: accepted,
      }),
    )
  }

  const stopRuntimeSessionIfExactWithinThreadPermit = Effect.fn(
    'ProviderService.stopRuntimeSessionIfExactWithinThreadPermit',
  )(function* (identity: ProviderRuntimeSessionIdentity, context?: ProviderEffectContext)
  {
    const stopped = yield* adapterLifecycleLocks.withPermit(
      identity.providerInstanceId,
      Effect.gen(function* ()
      {
        yield* requireRunning('ProviderService.stopSessionIfExact')
        if (!(yield* matchesRuntimeSessionIdentity(identity)))
        {
          return false
        }

        const routing = yield* Ref.get(adapterRoutingState)
        const subscribed = routing.subscribed.get(identity.providerInstanceId)?.adapter
        const quarantined = routing.quarantined.get(identity.providerInstanceId)?.adapter
        if (subscribed !== undefined && quarantined !== undefined && subscribed !== quarantined)
        {
          return yield* toValidationError(
            'ProviderService.stopSessionIfExact',
            `Provider instance '${identity.providerInstanceId}' has ambiguous live adapter ownership and cannot be stopped safely.`,
          )
        }

        const adapter = subscribed ?? quarantined
        if (adapter === undefined)
        {
          const registeredRoute = yield* Effect.option(
            registry.getRoute(identity.providerInstanceId),
          )
          if (Option.isSome(registeredRoute))
          {
            return yield* toValidationError(
              'ProviderService.stopSessionIfExact',
              `Provider instance '${identity.providerInstanceId}' is registered but has no lifecycle-owned adapter route.`,
            )
          }
          yield* ensureExactTerminalAdmission({
            identity,
            provider: identity.provider,
            eventIdPrefix: 'provider-session-exact-stopped-without-adapter',
            reason: 'Exact provider generation closed without a live adapter route',
            exitKind: 'graceful',
          })
          yield* awaitSessionExit(identity)
          return true
        }
        if (adapter.provider !== identity.provider)
        {
          return yield* toValidationError(
            'ProviderService.stopSessionIfExact',
            `Provider instance '${identity.providerInstanceId}' changed driver from '${identity.provider}' to '${adapter.provider}' and cannot be stopped through the replacement route.`,
          )
        }

        const isActive = yield* adapter.hasSession(identity.threadId)
        if (isActive)
        {
          const adapterBinding = yield* adapter.getSessionRuntimeBinding(identity.threadId)
          if (
            adapterBinding === undefined ||
            adapterBinding.providerInstanceId !== identity.providerInstanceId ||
            adapterBinding.threadId !== identity.threadId ||
            adapterBinding.sessionGeneration !== identity.sessionGeneration ||
            !(yield* matchesRuntimeSessionIdentity(identity))
          )
          {
            return false
          }
          const stop =
            context === undefined
              ? adapter.stopSession(identity.threadId)
              : adapter.stopSession(identity.threadId, context)
          yield* stop
          yield* awaitSessionExit(identity)
        }
        else
        {
          yield* ensureExactTerminalAdmission({
            identity,
            provider: identity.provider,
            eventIdPrefix: 'provider-session-exact-stopped-inactive',
            reason: 'Exact provider generation stopped after the adapter was already inactive',
            exitKind: 'graceful',
          })
          yield* awaitSessionExit(identity)
        }
        return true
      }),
    )
    if (stopped === false)
    {
      return false
    }

    const currentBinding = Option.getOrUndefined(yield* directory.getBinding(identity.threadId))
    if (currentBinding?.providerInstanceId === identity.providerInstanceId)
    {
      yield* directory.upsert({
        threadId: identity.threadId,
        provider: identity.provider,
        providerInstanceId: identity.providerInstanceId,
        status: 'stopped',
        runtimePayload: {
          activeTurnId: null,
        },
      })
    }
    yield* analytics.record('provider.session.stopped', {
      provider: identity.provider,
      exactGeneration: true,
    })
    return true
  })

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId
      readonly provider: ProviderDriverKind
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>
    },
    envelope: ProviderAdapterRuntimeEvent,
  ) =>
    Effect.uninterruptible(
      requireAdmittingAdapter(
        'ProviderService.processRuntimeEvent',
        source.instanceId,
        source.adapter,
      ).pipe(
        Effect.andThen(
          Effect.sync(() =>
          {
            if (envelope.binding.providerInstanceId !== source.instanceId)
            {
              throw new Error(
                `ProviderService.streamEvents: adapter route '${source.instanceId}' emitted a binding for '${envelope.binding.providerInstanceId}'.`,
              )
            }
            const event = correlateRuntimeEventWithInstance(source, envelope.event)
            validateRuntimeEventBinding(envelope.binding, event)
            return { binding: envelope.binding, event }
          }),
        ),
        Effect.flatMap(({ binding, event }) => publishRuntimeEvent(binding, event, source.adapter)),
      ),
    ).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : markAdapterQuarantinePending(source.instanceId, source.adapter),
      ),
    )

  // rebuild the map of id -> adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* ()
  {
    if (yield* Ref.get(shuttingDown))
    {
      return
    }
    const currentIds = yield* registry.listInstances()
    const currentIdSet = new Set(currentIds)
    for (const id of currentIds)
    {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option)
      if (Option.isNone(adapterOption)) continue
      const adapter = adapterOption.value
      yield* adapterLifecycleLocks.withPermit(
        id,
        Effect.gen(function* ()
        {
          let reconciliation = yield* prepareAdapterReconciliation(id, adapter)
          if (reconciliation._tag === 'retry-cleanup')
          {
            const claimed = yield* beginAdapterQuarantine(id, reconciliation.adapter)
            if (claimed)
            {
              const cleanup = yield* Effect.exit(
                cleanupQuarantinedAdapter(
                  id,
                  reconciliation.adapter,
                  'provider instance reconciliation retried incomplete quarantine cleanup',
                ),
              )
              if (Exit.isFailure(cleanup))
              {
                yield* Effect.logError('provider adapter quarantine cleanup failed closed', {
                  providerInstanceId: id,
                  cause: cleanup.cause,
                })
                return
              }
            }
            reconciliation = yield* prepareAdapterReconciliation(id, adapter)
          }
          if (reconciliation._tag !== 'ready' || (yield* Ref.get(shuttingDown)))
          {
            return
          }
          const currentSubscription = (yield* Ref.get(adapterRoutingState)).subscribed.get(id)
          if (currentSubscription?.adapter === adapter)
          {
            return
          }
          const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            processRuntimeEvent(
              {
                instanceId: id,
                provider: adapter.provider,
                adapter,
              },
              event,
            ),
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : quarantineAdapter(id, adapter, Cause.squash(cause)).pipe(
                    Effect.catchCause((cleanupCause) =>
                      Effect.logError('provider adapter subscription terminated after quarantine', {
                        providerInstanceId: id,
                        cause: cleanupCause,
                      }),
                    ),
                  ),
            ),
            Effect.forkIn(subscriptionScope, { startImmediately: false }),
          )
          const previous = yield* Ref.modify(adapterRoutingState, (current) =>
          {
            const prior = current.subscribed.get(id)
            const subscribed = new Map(current.subscribed)
            subscribed.set(id, { adapter, fiber })
            return [prior, { ...current, subscribed }]
          })
          if (previous !== undefined)
          {
            yield* Fiber.interrupt(previous.fiber)
          }
          yield* Effect.yieldNow
        }),
      )
    }

    const routedIds = Array.from((yield* Ref.get(adapterRoutingState)).subscribed.keys())
    for (const id of routedIds)
    {
      if (currentIdSet.has(id)) continue
      const removed = yield* adapterLifecycleLocks.withPermit(
        id,
        Ref.modify(adapterRoutingState, (current) =>
        {
          const previous = current.subscribed.get(id)
          const subscribed = new Map(current.subscribed)
          subscribed.delete(id)
          return [previous, { ...current, subscribed }]
        }),
      )
      if (removed !== undefined)
      {
        yield* Fiber.interrupt(removed.fiber)
      }
    }
    yield* Ref.update(adapterRoutingState, (current) =>
    {
      const quarantined = new Map(current.quarantined)
      for (const [id, state] of quarantined)
      {
        if (!currentIdSet.has(id) && state.cleanupState === 'complete')
        {
          quarantined.delete(id)
        }
      }
      return quarantined.size === current.quarantined.size ? current : { ...current, quarantined }
    })
  })
  const instanceChanges = yield* registry.subscribeChanges
  const quarantineCleanupChanges = yield* PubSub.subscribe(adapterReconcileWakeups)
  const subscriptionReconciliationGate = yield* Semaphore.make(1)
  const reconcileChangedInstanceSubscriptions = subscriptionReconciliationGate.withPermits(1)(
    reconcileInstanceSubscriptions,
  )
  yield* reconcileInstanceSubscriptions
  if (Option.isSome(registryMutator))
  {
    const lifecycleOwner: ProviderInstanceRegistryLifecycleOwner = {
      aroundMutation: (instanceIds, mutation) =>
        providerInstanceMutationGate.withPermits(1)(
          Effect.gen(function* ()
          {
            if (yield* Ref.get(shuttingDown))
            {
              return yield* new ProviderInstanceLifecycleReconcileError({
                detail: 'provider shutdown has started; settings-driven route mutation is fenced',
              })
            }
            const uniqueIds = Array.from(new Set(instanceIds)).sort()
            const routes = yield* Effect.forEach(uniqueIds, (instanceId) =>
              registry.getRoute(instanceId).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderInstanceLifecycleReconcileError({
                      detail: `unable to resolve retiring provider instance '${instanceId}'`,
                      cause,
                    }),
                ),
              ),
            )
            const marked = yield* Ref.modify(adapterRoutingState, (current) =>
            {
              const routeMismatch = routes.find(
                (route) => current.subscribed.get(route.info.instanceId)?.adapter !== route.adapter,
              )
              if (routeMismatch !== undefined)
              {
                return [routeMismatch.info.instanceId, current] as const
              }
              const reconfiguring = new Set(current.reconfiguring)
              for (const instanceId of uniqueIds)
              {
                reconfiguring.add(instanceId)
              }
              return [undefined, { ...current, reconfiguring }] as const
            })
            if (marked !== undefined)
            {
              return yield* new ProviderInstanceLifecycleReconcileError({
                detail: `provider instance '${marked}' has no exact lifecycle-owned subscription to retire`,
              })
            }

            const clearReconfiguring = Ref.update(adapterRoutingState, (current) =>
            {
              const reconfiguring = new Set(current.reconfiguring)
              for (const instanceId of uniqueIds)
              {
                reconfiguring.delete(instanceId)
              }
              return { ...current, reconfiguring }
            })

            return yield* Effect.gen(function* ()
            {
              for (const instanceId of uniqueIds)
              {
                yield* adapterLifecycleLocks.withPermit(instanceId, Effect.void)
              }

              for (const instanceId of uniqueIds)
              {
                const sessions = yield* runtimeInbox.listOpenSessions(instanceId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderInstanceLifecycleReconcileError({
                        detail: `unable to enumerate durable generations for retiring provider instance '${instanceId}'`,
                        cause,
                      }),
                  ),
                )
                for (const session of sessions)
                {
                  const identity: ProviderRuntimeSessionIdentity = {
                    provider: session.provider,
                    providerInstanceId: session.providerInstanceId,
                    threadId: session.threadId,
                    sessionGeneration: session.sessionGeneration,
                  }
                  yield* sessionLifecycleLocks.withPermit(
                    identity.threadId,
                    stopRuntimeSessionIfExactWithinThreadPermit(identity).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderInstanceLifecycleReconcileError({
                            detail: `unable to durably close provider generation '${identity.providerInstanceId}:${identity.threadId}:${identity.sessionGeneration}' before route retirement`,
                            cause,
                          }),
                      ),
                    ),
                  )
                }
                const remaining = yield* runtimeInbox.listOpenSessions(instanceId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderInstanceLifecycleReconcileError({
                        detail: `unable to verify durable generations for retiring provider instance '${instanceId}'`,
                        cause,
                      }),
                  ),
                )
                if (remaining.length > 0)
                {
                  return yield* new ProviderInstanceLifecycleReconcileError({
                    detail: `provider instance '${instanceId}' still owns ${remaining.length} open durable generation(s) after route retirement cleanup`,
                  })
                }
              }

              const value = yield* Effect.uninterruptible(mutation)
              yield* subscriptionReconciliationGate.withPermits(1)(
                reconcileInstanceSubscriptions.pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderInstanceLifecycleReconcileError({
                        detail:
                          'provider route mutation completed but subscription ownership did not',
                        cause,
                      }),
                  ),
                ),
              )
              return value
            }).pipe(Effect.ensuring(clearReconfiguring))
          }),
        ),
    }
    yield* registryMutator.value.registerLifecycleOwner(lifecycleOwner)
    yield* Effect.addFinalizer(() => registryMutator.value.unregisterLifecycleOwner(lifecycleOwner))
  }
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileChangedInstanceSubscriptions,
  ).pipe(Effect.forkScoped)
  yield* Stream.runForEach(
    Stream.fromSubscription(quarantineCleanupChanges),
    () => reconcileChangedInstanceSubscriptions,
  ).pipe(Effect.forkScoped)

  const recoverSessionForThread = Effect.fn('recoverSessionForThread')(function* (input: {
    readonly route: ProviderAdapterRegistry.ProviderInstanceRoute
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding
    readonly operation: string
    readonly routingAuthority?: ProviderService.ProviderRoutingAuthority
    readonly context?: ProviderEffectContext
  })
  {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding)
    yield* Effect.annotateCurrentSpan({
      'provider.operation': 'recover-session',
      'provider.kind': input.binding.provider,
      'provider.instance_id': bindingInstanceId,
      'provider.thread_id': input.binding.threadId,
    })
    return yield* Effect.gen(function* ()
    {
      yield* requireRunning(input.operation)
      yield* requireContinuationRoute(input.operation, input.route)
      const persistedContinuationIdentity = readPersistedContinuationIdentity(
        input.binding.runtimePayload,
      )
      yield* validateAdapterRoute({
        operation: input.operation,
        instanceId: bindingInstanceId,
        expectedProvider: input.binding.provider,
        route: input.route,
        ...(persistedContinuationIdentity === undefined ? {} : { persistedContinuationIdentity }),
        ...(input.routingAuthority !== undefined
          ? { routingAuthority: input.routingAuthority }
          : {}),
      })
      const recoveryRuntimeMode = coerceSupportedRuntimeMode(
        input.route.adapter.capabilities,
        input.binding.runtimeMode ??
          input.route.adapter.capabilities.defaultRuntimeMode ??
          'full-access',
      )
      const runtimeModeAcknowledgements = yield* validateRuntimeModeAcknowledgements({
        threadId: input.binding.threadId,
        providerInstanceId: bindingInstanceId,
        runtimeMode: recoveryRuntimeMode,
        continuationKey: input.route.info.continuationIdentity.continuationKey,
        capabilities: input.route.adapter.capabilities,
        persistedBinding: input.binding,
        requestedIds: [],
        allowPersisted: true,
      })
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined
      const hasActiveSession = yield* input.route.adapter.hasSession(input.binding.threadId)
      if (hasActiveSession)
      {
        const activeSessions = yield* input.route.adapter.listSessions()
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        )
        if (existing)
        {
          if (existing.provider !== input.route.adapter.provider)
          {
            return yield* toValidationError(
              input.operation,
              `Adapter/provider mismatch while adopting recovered thread '${input.binding.threadId}'. Expected '${input.route.adapter.provider}', received '${existing.provider}'.`,
            )
          }
          const adapterBinding = yield* input.route.adapter.getSessionRuntimeBinding(
            input.binding.threadId,
          )
          const durableSession = yield* runtimeInbox
            .getCurrentSession({
              providerInstanceId: bindingInstanceId,
              threadId: input.binding.threadId,
            })
            .pipe(
              Effect.mapError((cause) =>
                toValidationError(
                  input.operation,
                  'Unable to verify the active adapter session generation.',
                  cause,
                ),
              ),
            )
          if (
            adapterBinding === undefined ||
            Option.isNone(durableSession) ||
            adapterBinding.providerInstanceId !== bindingInstanceId ||
            adapterBinding.threadId !== input.binding.threadId ||
            adapterBinding.sessionGeneration !== durableSession.value.sessionGeneration
          )
          {
            return yield* toValidationError(
              input.operation,
              `Active provider session '${bindingInstanceId}:${input.binding.threadId}' has no matching durable generation and cannot be adopted safely.`,
            )
          }
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
            {
              continuationIdentity: input.route.info.continuationIdentity,
              runtimeModeAcknowledgements,
            },
          )
          yield* analytics.record('provider.session.recovered', {
            provider: existing.provider,
            strategy: 'adopt-existing',
            hasResumeCursor: existing.resumeCursor !== undefined,
          })
          return { adapter: input.route.adapter, session: existing } as const
        }
      }

      if (!hasResumeCursor)
      {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        )
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload)
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload)

      return yield* withAllocatedRuntimeSession({
        operation: input.operation,
        provider: input.binding.provider,
        providerInstanceId: bindingInstanceId,
        threadId: input.binding.threadId,
        adapter: input.route.adapter,
        ...(input.context === undefined ? {} : { context: input.context }),
        use: (allocated) =>
          Effect.gen(function* ()
          {
            const mcp = yield* prepareMcpSession(
              input.binding.threadId,
              bindingInstanceId,
              allocated.runtimeSession.sessionGeneration,
            )
            const resumeInput = {
              threadId: input.binding.threadId,
              provider: input.binding.provider,
              providerInstanceId: bindingInstanceId,
              ...(persistedCwd ? { cwd: persistedCwd } : {}),
              ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
              ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
              runtimeMode: recoveryRuntimeMode,
              ...(mcp === undefined ? {} : { mcp }),
              runtimeSessionBinding: {
                providerInstanceId: bindingInstanceId,
                threadId: input.binding.threadId,
                sessionGeneration: allocated.runtimeSession.sessionGeneration,
              },
            } satisfies ProviderAdapterSessionStartInput
            const resume =
              input.context === undefined
                ? input.route.adapter.startSession(resumeInput)
                : input.route.adapter.startSession(resumeInput, input.context)
            const resumed = yield* resume
            if (resumed.provider !== input.route.adapter.provider)
            {
              return yield* toValidationError(
                input.operation,
                `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${input.route.adapter.provider}', received '${resumed.provider}'.`,
              )
            }

            yield* upsertSessionBinding(
              { ...resumed, providerInstanceId: bindingInstanceId },
              input.binding.threadId,
              {
                continuationIdentity: input.route.info.continuationIdentity,
                runtimeModeAcknowledgements,
              },
            )
            yield* analytics.record('provider.session.recovered', {
              provider: resumed.provider,
              strategy: 'resume-thread',
              hasResumeCursor: resumed.resumeCursor !== undefined,
            })
            return { adapter: input.route.adapter, session: resumed } as const
          }),
      })
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: 'recover',
        }),
      }),
    )
  })

  interface ResolveRoutableSessionInput
  {
    readonly threadId: ThreadId
    readonly operation: string
    readonly allowRecovery: boolean
    readonly expectedProviderInstanceId?: ProviderInstanceId
    readonly routingAuthority?: ProviderService.ProviderRoutingAuthority
    readonly context?: ProviderEffectContext
  }

  const resolveRoutableSession = Effect.fn('resolveRoutableSession')(function* (
    input: ResolveRoutableSessionInput,
  )
  {
    const bindingOption = yield* directory.getBinding(input.threadId)
    const binding = Option.getOrUndefined(bindingOption)
    if (!binding)
    {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      )
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding)
    if (
      input.expectedProviderInstanceId !== undefined &&
      instanceId !== input.expectedProviderInstanceId
    )
    {
      return yield* toValidationError(
        input.operation,
        `Provider binding changed from expected instance '${input.expectedProviderInstanceId}' to '${instanceId}'.`,
      )
    }
    const route = yield* registry.getRoute(instanceId)
    yield* requireHealthyAdapter(input.operation, instanceId, route.adapter)
    const persistedContinuationIdentity = readPersistedContinuationIdentity(binding.runtimePayload)
    yield* validateAdapterRoute({
      operation: input.operation,
      instanceId,
      expectedProvider: binding.provider,
      route,
      ...(persistedContinuationIdentity === undefined ? {} : { persistedContinuationIdentity }),
      ...(input.routingAuthority !== undefined ? { routingAuthority: input.routingAuthority } : {}),
    })

    const hasRequestedSession = yield* route.adapter.hasSession(input.threadId)
    if (hasRequestedSession)
    {
      return {
        adapter: route.adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const
    }

    if (!input.allowRecovery)
    {
      return {
        adapter: route.adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const
    }

    const recovered = yield* recoverSessionForThread({
      route,
      binding,
      operation: input.operation,
      ...(input.routingAuthority !== undefined ? { routingAuthority: input.routingAuthority } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    })
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const
  })

  const withProviderInstanceLifecycle = <A, E, R>(
    input: {
      readonly threadId: ThreadId
      readonly operation: string
      readonly requireActiveThread: boolean
    },
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* ()
    {
      const preflightBinding = Option.getOrUndefined(yield* directory.getBinding(input.threadId))
      if (preflightBinding !== undefined)
      {
        const preflightInstanceId = yield* requireBindingInstanceId(
          input.operation,
          preflightBinding,
        )
        const routing = yield* Ref.get(adapterRoutingState)
        if (routing.reconfiguring.has(preflightInstanceId))
        {
          return yield* toValidationError(
            input.operation,
            `Provider instance '${preflightInstanceId}' is reconfiguring; commands admitted after the retirement fence are rejected.`,
          )
        }
      }
      const run = sessionLifecycleLocks.withPermit(
        input.threadId,
        Effect.gen(function* ()
        {
          const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId))
          if (binding === undefined)
          {
            return yield* toValidationError(
              input.operation,
              `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
            )
          }
          const instanceId = yield* requireBindingInstanceId(input.operation, binding)
          return yield* adapterLifecycleLocks.withPermit(
            instanceId,
            requireRunning(input.operation).pipe(Effect.andThen(effect)),
          )
        }),
      )
      return yield* input.requireActiveThread
        ? withActiveThreadLifecycle(input.operation, input.threadId, run)
        : run
    })

  const stopOutgoingRuntimeSessionsWithinThreadPermit = Effect.fn(
    'ProviderService.stopOutgoingRuntimeSessionsWithinThreadPermit',
  )(function* (input: {
    readonly threadId: ThreadId
    readonly incomingInstanceId: ProviderInstanceId
    readonly context?: ProviderEffectContext
  })
  {
    const openSessions = yield* runtimeInbox
      .listAllOpenSessions()
      .pipe(
        Effect.mapError((cause) =>
          toValidationError(
            'ProviderService.startSession',
            'Unable to enumerate durable outgoing provider generations before switching.',
            cause,
          ),
        ),
      )
    for (const session of openSessions)
    {
      if (
        session.threadId !== input.threadId ||
        session.providerInstanceId === input.incomingInstanceId
      )
      {
        continue
      }
      const stopped = yield* stopRuntimeSessionIfExactWithinThreadPermit(
        {
          provider: session.provider,
          providerInstanceId: session.providerInstanceId,
          threadId: session.threadId,
          sessionGeneration: session.sessionGeneration,
        },
        input.context,
      )
      if (!stopped)
      {
        return yield* toValidationError(
          'ProviderService.startSession',
          `Outgoing provider generation '${session.providerInstanceId}:${session.threadId}:${session.sessionGeneration}' changed before it could be stopped.`,
        )
      }
    }
  })

  const startSession: ProviderServiceMethod<'startSession'> = Effect.fn('startSession')(
    function* (threadId, rawInput, routingAuthority, context)
    {
      const parsed = yield* decodeInputOrValidationError({
        operation: 'ProviderService.startSession',
        schema: ProviderSessionStartInput,
        payload: rawInput,
      })

      const resolvedInstanceId = yield* requireBindingInstanceId(
        'ProviderService.startSession',
        parsed,
      )
      let metricProvider = parsed.provider ?? String(resolvedInstanceId)
      yield* Effect.annotateCurrentSpan({
        'provider.operation': 'start-session',
        'provider.instance_id': resolvedInstanceId,
        'provider.thread_id': threadId,
        'provider.runtime_mode': parsed.runtimeMode,
      })
      return yield* withActiveThreadLifecycle(
        'ProviderService.startSession',
        threadId,
        sessionLifecycleLocks.withPermit(
          threadId,
          Effect.gen(function* ()
          {
            const prepareIncomingRoute = (expectedProvider?: ProviderDriverKind) =>
              Effect.gen(function* ()
              {
                yield* requireRunning('ProviderService.startSession')
                const route = yield* registry.getRoute(resolvedInstanceId)
                yield* requireHealthyAdapter(
                  'ProviderService.startSession',
                  resolvedInstanceId,
                  route.adapter,
                )
                const runtimeMode = coerceSupportedRuntimeMode(
                  route.adapter.capabilities,
                  parsed.runtimeMode,
                )
                const resolvedProvider = expectedProvider ?? route.info.driverKind
                metricProvider = resolvedProvider
                if (parsed.provider !== undefined && parsed.provider !== resolvedProvider)
                {
                  return yield* toValidationError(
                    'ProviderService.startSession',
                    `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
                  )
                }
                const input = {
                  ...parsed,
                  threadId,
                  provider: resolvedProvider,
                  runtimeMode,
                }
                const persistedBinding = Option.getOrUndefined(
                  yield* directory.getBinding(threadId),
                )
                const persistedContinuationIdentity =
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                    ? readPersistedContinuationIdentity(persistedBinding.runtimePayload)
                    : undefined
                yield* validateAdapterRoute({
                  operation: 'ProviderService.startSession',
                  instanceId: resolvedInstanceId,
                  expectedProvider: resolvedProvider,
                  route,
                  ...(persistedContinuationIdentity === undefined
                    ? {}
                    : { persistedContinuationIdentity }),
                  ...(routingAuthority !== undefined ? { routingAuthority } : {}),
                })
                const effectiveResumeCursor =
                  input.resumeCursor ??
                  (persistedBinding?.providerInstanceId === resolvedInstanceId
                    ? persistedBinding.resumeCursor
                    : undefined)
                const effectiveCwd =
                  input.cwd ??
                  (persistedBinding?.providerInstanceId === resolvedInstanceId
                    ? readPersistedCwd(persistedBinding.runtimePayload)
                    : undefined)
                if (
                  route.info.continuationUnavailableReason !== undefined &&
                  (routingAuthority !== undefined || effectiveResumeCursor !== undefined)
                )
                {
                  return yield* toValidationError(
                    'ProviderService.startSession',
                    `Provider instance '${route.info.instanceId}' cannot safely continue sessions because ${route.info.continuationUnavailableReason}.`,
                  )
                }
                const runtimeModeAcknowledgements = yield* validateRuntimeModeAcknowledgements({
                  threadId,
                  providerInstanceId: resolvedInstanceId,
                  runtimeMode,
                  continuationKey: route.info.continuationIdentity.continuationKey,
                  capabilities: route.adapter.capabilities,
                  ...(persistedBinding === undefined ? {} : { persistedBinding }),
                  requestedIds: input.runtimeModeAcknowledgements ?? [],
                  allowPersisted: input.resumeCursor !== undefined && input.resumeCursor !== null,
                })
                return {
                  route,
                  input,
                  effectiveCwd,
                  effectiveResumeCursor,
                  persistedBinding,
                  resolvedProvider,
                  runtimeModeAcknowledgements,
                }
              })

            const preflight = yield* adapterLifecycleLocks.withPermit(
              resolvedInstanceId,
              prepareIncomingRoute(),
            )
            yield* stopOutgoingRuntimeSessionsWithinThreadPermit({
              threadId,
              incomingInstanceId: resolvedInstanceId,
              ...(context !== undefined ? { context } : {}),
            })
            yield* adapterLifecycleLocks.withPermit(
              resolvedInstanceId,
              Effect.gen(function* ()
              {
                const prepared = yield* prepareIncomingRoute(preflight.resolvedProvider)
                yield* stopRuntimeSessionForAdapterStart({
                  operation: 'ProviderService.startSession',
                  providerInstanceId: resolvedInstanceId,
                  threadId,
                  adapter: prepared.route.adapter,
                  ...(context === undefined ? {} : { context }),
                })
              }),
            )
            return yield* adapterLifecycleLocks.withPermit(
              resolvedInstanceId,
              Effect.gen(function* ()
              {
                const prepared = yield* prepareIncomingRoute(preflight.resolvedProvider)
                const route = prepared.route
                yield* Effect.annotateCurrentSpan({
                  'provider.kind': prepared.resolvedProvider,
                  'provider.resume_cursor.source':
                    prepared.input.resumeCursor !== undefined
                      ? 'request'
                      : prepared.effectiveResumeCursor !== undefined &&
                          prepared.persistedBinding?.providerInstanceId === resolvedInstanceId
                        ? 'persisted'
                        : 'none',
                  'provider.resume_cursor.present': prepared.effectiveResumeCursor !== undefined,
                  'provider.cwd.source':
                    prepared.input.cwd !== undefined
                      ? 'request'
                      : prepared.effectiveCwd !== undefined &&
                          prepared.persistedBinding?.providerInstanceId === resolvedInstanceId
                        ? 'persisted'
                        : 'none',
                  'provider.cwd.effective': prepared.effectiveCwd ?? '',
                })
                if (yield* route.adapter.hasSession(threadId))
                {
                  return yield* toValidationError(
                    'ProviderService.startSession',
                    `Provider session '${resolvedInstanceId}:${threadId}' became active again before its replacement generation could start.`,
                  )
                }
                const durableCurrent = yield* runtimeInbox
                  .getCurrentSession({
                    providerInstanceId: resolvedInstanceId,
                    threadId,
                  })
                  .pipe(
                    Effect.mapError((cause) =>
                      toValidationError(
                        'ProviderService.startSession',
                        'Unable to verify that the prior provider generation closed.',
                        cause,
                      ),
                    ),
                  )
                if (Option.isSome(durableCurrent))
                {
                  return yield* toValidationError(
                    'ProviderService.startSession',
                    `Prior provider generation '${resolvedInstanceId}:${threadId}:${durableCurrent.value.sessionGeneration}' remains open.`,
                  )
                }

                return yield* withAllocatedRuntimeSession({
                  operation: 'ProviderService.startSession',
                  provider: prepared.resolvedProvider,
                  providerInstanceId: resolvedInstanceId,
                  threadId,
                  adapter: route.adapter,
                  ...(context === undefined ? {} : { context }),
                  use: (allocated) =>
                    Effect.gen(function* ()
                    {
                      const mcp = yield* prepareMcpSession(
                        threadId,
                        resolvedInstanceId,
                        allocated.runtimeSession.sessionGeneration,
                      )
                      const adapterInput = {
                        ...prepared.input,
                        providerInstanceId: resolvedInstanceId,
                        ...(prepared.effectiveCwd !== undefined
                          ? { cwd: prepared.effectiveCwd }
                          : {}),
                        ...(prepared.effectiveResumeCursor !== undefined
                          ? { resumeCursor: prepared.effectiveResumeCursor }
                          : {}),
                        ...(mcp === undefined ? {} : { mcp }),
                        runtimeSessionBinding: {
                          providerInstanceId: resolvedInstanceId,
                          threadId,
                          sessionGeneration: allocated.runtimeSession.sessionGeneration,
                        },
                      }
                      const start =
                        context === undefined
                          ? route.adapter.startSession(adapterInput)
                          : route.adapter.startSession(adapterInput, context)
                      const session = yield* start
                      if (session.provider !== route.adapter.provider)
                      {
                        return yield* toValidationError(
                          'ProviderService.startSession',
                          `Adapter/provider mismatch: requested '${route.adapter.provider}', received '${session.provider}'.`,
                        )
                      }
                      const sessionWithInstance = {
                        ...session,
                        providerInstanceId: resolvedInstanceId,
                      }

                      yield* upsertSessionBinding(sessionWithInstance, threadId, {
                        continuationIdentity: route.info.continuationIdentity,
                        modelSelection: prepared.input.modelSelection,
                        runtimeModeAcknowledgements: prepared.runtimeModeAcknowledgements,
                      })
                      yield* analytics.record('provider.session.started', {
                        provider: sessionWithInstance.provider,
                        runtimeMode: prepared.input.runtimeMode,
                        hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
                        hasCwd:
                          typeof prepared.effectiveCwd === 'string' &&
                          prepared.effectiveCwd.trim().length > 0,
                        hasModel:
                          typeof prepared.input.modelSelection?.model === 'string' &&
                          prepared.input.modelSelection.model.trim().length > 0,
                      })
                      return sessionWithInstance
                    }),
                })
              }),
            )
          }).pipe(
            withMetrics({
              counter: providerSessionsTotal,
              attributes: () =>
                providerMetricAttributes(metricProvider, {
                  operation: 'start',
                }),
            }),
          ),
        ),
      )
    },
  )

  const sendTurn: ProviderServiceMethod<'sendTurn'> = Effect.fn('sendTurn')(
    function* (rawInput, routingAuthority, context)
    {
      const parsed = yield* decodeInputOrValidationError({
        operation: 'ProviderService.sendTurn',
        schema: ProviderSendTurnInput,
        payload: rawInput,
      })

      const input = {
        ...parsed,
        attachments: parsed.attachments ?? [],
      }
      if (!input.input && input.attachments.length === 0)
      {
        return yield* toValidationError(
          'ProviderService.sendTurn',
          'Either input text or at least one attachment is required',
        )
      }
      yield* Effect.annotateCurrentSpan({
        'provider.operation': 'send-turn',
        'provider.thread_id': input.threadId,
        'provider.interaction_mode': input.interactionMode,
        'provider.attachment_count': input.attachments.length,
      })
      let metricProvider = 'unknown'
      let metricModel = input.modelSelection?.model
      return yield* withProviderInstanceLifecycle(
        {
          threadId: input.threadId,
          operation: 'ProviderService.sendTurn',
          requireActiveThread: true,
        },
        Effect.gen(function* ()
        {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: 'ProviderService.sendTurn',
            allowRecovery: true,
            ...(routingAuthority !== undefined ? { routingAuthority } : {}),
            ...(context !== undefined ? { context } : {}),
          })
          metricProvider = routed.adapter.provider
          metricModel = input.modelSelection?.model
          const capabilities = routed.adapter.capabilities
          const requestedBaseMode = providerBaseInteractionMode(input)
          const requestedOrchestrate =
            input.orchestrate === true || input.interactionMode === 'orchestrate'
          if (!supportsTurnMode(capabilities, input))
          {
            return yield* toValidationError(
              'ProviderService.sendTurn',
              requestedOrchestrate && capabilities.orchestrateInstructionDelivery === 'unsupported'
                ? `Provider instance '${routed.instanceId}' does not support orchestrate instruction delivery.`
                : `Provider instance '${routed.instanceId}' does not support interaction mode '${requestedBaseMode}'.`,
            )
          }
          if (
            input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== routed.instanceId
          )
          {
            return yield* toValidationError(
              'ProviderService.sendTurn',
              `Provider turn model selection targets instance '${input.modelSelection.instanceId}', but thread '${input.threadId}' is bound to '${routed.instanceId}'.`,
            )
          }
          const activeSession = (yield* routed.adapter.listSessions()).find(
            (session) => session.threadId === input.threadId,
          )
          if (
            capabilities.activeTurnInput === 'unsupported' &&
            activeSession !== undefined &&
            (activeSession.status === 'running' || activeSession.activeTurnId !== undefined)
          )
          {
            return yield* toValidationError(
              'ProviderService.sendTurn',
              `Provider instance '${routed.instanceId}' does not accept input while a turn is active.`,
            )
          }
          if (
            capabilities.sessionModelSwitch === 'unsupported' &&
            input.modelSelection !== undefined &&
            activeSession?.model !== undefined &&
            input.modelSelection.model !== activeSession.model
          )
          {
            return yield* toValidationError(
              'ProviderService.sendTurn',
              `Provider instance '${routed.instanceId}' cannot switch models within an active session.`,
            )
          }
          yield* Effect.annotateCurrentSpan({
            'provider.kind': routed.adapter.provider,
            ...(input.modelSelection?.model
              ? { 'provider.model': input.modelSelection.model }
              : {}),
          })
          // turns keep the existing credential alive because running agents cannot accept rotation
          yield* mcpSessionRegistry.touch(input.threadId)
          // clear the prior turn before starting another so overlapping mcp calls fail closed
          yield* mcpSessionRegistry.bindActiveTurn(input.threadId)
          const adapterInput =
            routed.adapter.provider === 'codex' ? input : applyOrchestrateModeInstructions(input)
          const turn = yield* context === undefined
            ? routed.adapter.sendTurn(adapterInput)
            : routed.adapter.sendTurn(adapterInput, context)
          yield* mcpSessionRegistry.bindActiveTurn(input.threadId, turn.turnId)
          yield* directory.upsert({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            status: 'running',
            ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
            runtimePayload: {
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              activeTurnId: turn.turnId,
              lastRuntimeEvent: 'provider.sendTurn',
              lastRuntimeEventAt: yield* nowIso,
            },
          })
          yield* analytics.record('provider.turn.sent', {
            provider: routed.adapter.provider,
            model: input.modelSelection?.model,
            interactionMode: input.interactionMode,
            attachmentCount: input.attachments.length,
            hasInput: typeof input.input === 'string' && input.input.trim().length > 0,
          })
          return turn
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            timer: providerTurnDuration,
            attributes: () =>
              providerTurnMetricAttributes({
                provider: metricProvider,
                model: metricModel,
                extra: {
                  operation: 'send',
                },
              }),
          }),
        ),
      )
    },
  )

  const interruptTurn: ProviderServiceMethod<'interruptTurn'> = Effect.fn('interruptTurn')(
    function* (rawInput, context)
    {
      const input = yield* decodeInputOrValidationError({
        operation: 'ProviderService.interruptTurn',
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      })
      let metricProvider = 'unknown'
      return yield* withProviderInstanceLifecycle(
        {
          threadId: input.threadId,
          operation: 'ProviderService.interruptTurn',
          requireActiveThread: true,
        },
        Effect.gen(function* ()
        {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: 'ProviderService.interruptTurn',
            allowRecovery: true,
            ...(context !== undefined ? { context } : {}),
          })
          metricProvider = routed.adapter.provider
          yield* Effect.annotateCurrentSpan({
            'provider.operation': 'interrupt-turn',
            'provider.kind': routed.adapter.provider,
            'provider.thread_id': input.threadId,
            'provider.turn_id': input.turnId,
          })
          yield* context === undefined
            ? routed.adapter.interruptTurn(routed.threadId, input.turnId)
            : routed.adapter.interruptTurn(routed.threadId, input.turnId, context)
          yield* analytics.record('provider.turn.interrupted', {
            provider: routed.adapter.provider,
          })
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: 'interrupt',
              }),
          }),
        ),
      )
    },
  )

  const respondToRequest: ProviderServiceMethod<'respondToRequest'> = Effect.fn('respondToRequest')(
    function* (rawInput, context)
    {
      const input = yield* decodeInputOrValidationError({
        operation: 'ProviderService.respondToRequest',
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      })
      let metricProvider = 'unknown'
      return yield* withProviderInstanceLifecycle(
        {
          threadId: input.threadId,
          operation: 'ProviderService.respondToRequest',
          requireActiveThread: true,
        },
        Effect.gen(function* ()
        {
          const routed = yield* resolveRoutableSession({
            threadId: input.threadId,
            operation: 'ProviderService.respondToRequest',
            allowRecovery: true,
            ...(context !== undefined ? { context } : {}),
          })
          metricProvider = routed.adapter.provider
          yield* Effect.annotateCurrentSpan({
            'provider.operation': 'respond-to-request',
            'provider.kind': routed.adapter.provider,
            'provider.thread_id': input.threadId,
            'provider.request_id': input.requestId,
          })
          yield* context === undefined
            ? routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision)
            : routed.adapter.respondToRequest(
                routed.threadId,
                input.requestId,
                input.decision,
                context,
              )
          yield* analytics.record('provider.request.responded', {
            provider: routed.adapter.provider,
            decision: input.decision,
          })
        }).pipe(
          withMetrics({
            counter: providerTurnsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: 'approval-response',
              }),
          }),
        ),
      )
    },
  )

  const respondToUserInput: ProviderServiceMethod<'respondToUserInput'> = Effect.fn(
    'respondToUserInput',
  )(function* (rawInput, context)
  {
    const input = yield* decodeInputOrValidationError({
      operation: 'ProviderService.respondToUserInput',
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    })
    let metricProvider = 'unknown'
    return yield* withProviderInstanceLifecycle(
      {
        threadId: input.threadId,
        operation: 'ProviderService.respondToUserInput',
        requireActiveThread: true,
      },
      Effect.gen(function* ()
      {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: 'ProviderService.respondToUserInput',
          allowRecovery: true,
          ...(context !== undefined ? { context } : {}),
        })
        metricProvider = routed.adapter.provider
        yield* Effect.annotateCurrentSpan({
          'provider.operation': 'respond-to-user-input',
          'provider.kind': routed.adapter.provider,
          'provider.thread_id': input.threadId,
          'provider.request_id': input.requestId,
        })
        yield* context === undefined
          ? routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers)
          : routed.adapter.respondToUserInput(
              routed.threadId,
              input.requestId,
              input.answers,
              context,
            )
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: 'user-input-response',
            }),
        }),
      ),
    )
  })

  const stopSession: ProviderServiceMethod<'stopSession'> = Effect.fn('stopSession')(
    function* (rawInput, context)
    {
      const input = yield* decodeInputOrValidationError({
        operation: 'ProviderService.stopSession',
        schema: ProviderStopSessionInput,
        payload: rawInput,
      })
      let metricProvider = 'unknown'
      yield* sessionLifecycleLocks.withPermit(
        input.threadId,
        Effect.gen(function* ()
        {
          const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId))
          if (binding === undefined)
          {
            return yield* toValidationError(
              'ProviderService.stopSession',
              `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
            )
          }
          const instanceId = yield* requireBindingInstanceId('ProviderService.stopSession', binding)
          const stopped = yield* adapterLifecycleLocks.withPermit(
            instanceId,
            Effect.gen(function* ()
            {
              yield* requireRunning('ProviderService.stopSession')
              const routed = yield* resolveRoutableSession({
                threadId: input.threadId,
                operation: 'ProviderService.stopSession',
                allowRecovery: false,
                ...(context !== undefined ? { context } : {}),
              })
              if (
                routed.instanceId !== instanceId ||
                (input.expectedProviderInstanceId !== undefined &&
                  routed.instanceId !== input.expectedProviderInstanceId)
              )
              {
                return
              }
              metricProvider = routed.adapter.provider
              yield* Effect.annotateCurrentSpan({
                'provider.operation': 'stop-session',
                'provider.kind': routed.adapter.provider,
                'provider.thread_id': input.threadId,
              })
              const current = yield* runtimeInbox
                .getCurrentSession({
                  providerInstanceId: routed.instanceId,
                  threadId: input.threadId,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    toValidationError(
                      'ProviderService.stopSession',
                      'Unable to read the durable provider session identity before stopping.',
                      cause,
                    ),
                  ),
                )
              const identity = Option.map(current, (session): ProviderRuntimeSessionIdentity => ({
                provider: session.provider,
                providerInstanceId: routed.instanceId,
                threadId: input.threadId,
                sessionGeneration: session.sessionGeneration,
              }))
              if (routed.isActive)
              {
                const activeIdentity = Option.isSome(identity)
                  ? identity.value
                  : yield* toValidationError(
                      'ProviderService.stopSession',
                      'The active adapter session has no durable provider generation.',
                    )
                const adapterBinding = yield* routed.adapter.getSessionRuntimeBinding(
                  input.threadId,
                )
                if (
                  adapterBinding === undefined ||
                  adapterBinding.providerInstanceId !== activeIdentity.providerInstanceId ||
                  adapterBinding.threadId !== activeIdentity.threadId ||
                  adapterBinding.sessionGeneration !== activeIdentity.sessionGeneration
                )
                {
                  return yield* toValidationError(
                    'ProviderService.stopSession',
                    'The active adapter session does not match its durable provider generation.',
                  )
                }
                const stop =
                  context === undefined
                    ? routed.adapter.stopSession(routed.threadId)
                    : routed.adapter.stopSession(routed.threadId, context)
                yield* stop
                yield* awaitSessionExit(activeIdentity)
              }
              else if (Option.isSome(identity))
              {
                const createdAt = yield* nowIso
                yield* publishRuntimeEvent(identity.value, {
                  type: 'session.exited',
                  eventId: EventId.make(
                    `provider-session-stopped-inactive:${routed.instanceId}:${input.threadId}:${identity.value.sessionGeneration}`,
                  ),
                  provider: identity.value.provider,
                  providerInstanceId: routed.instanceId,
                  threadId: input.threadId,
                  createdAt,
                  payload: {
                    reason: 'Stopped after the provider adapter was already inactive',
                    recoverable: false,
                    exitKind: 'graceful',
                  },
                }).pipe(
                  Effect.mapError((cause) =>
                    toValidationError(
                      'ProviderService.stopSession',
                      'Unable to durably close the inactive provider session.',
                      cause,
                    ),
                  ),
                )
                yield* awaitSessionExit(identity.value)
              }
              return {
                identity,
                provider: routed.adapter.provider,
                providerInstanceId: routed.instanceId,
              }
            }),
          )
          if (stopped === undefined)
          {
            return
          }
          yield* directory.upsert({
            threadId: input.threadId,
            provider: stopped.provider,
            providerInstanceId: stopped.providerInstanceId,
            status: 'stopped',
            runtimePayload: {
              activeTurnId: null,
            },
          })
          yield* analytics.record('provider.session.stopped', {
            provider: stopped.provider,
          })
        }).pipe(
          withMetrics({
            counter: providerSessionsTotal,
            outcomeAttributes: () =>
              providerMetricAttributes(metricProvider, {
                operation: 'stop',
              }),
          }),
        ),
      )
    },
  )

  const matchesSessionIdentity: ProviderServiceMethod<'matchesSessionIdentity'> = (identity) =>
    matchesRuntimeSessionIdentity(identity)

  const getSessionIdentityState: ProviderServiceMethod<'getSessionIdentityState'> = (identity) =>
    runtimeInbox
      .getSession(identity)
      .pipe(
        Effect.mapError((cause) =>
          toValidationError(
            'ProviderService.getSessionIdentityState',
            'Unable to read the durable provider session generation.',
            cause,
          ),
        ),
      )

  const captureSessionIdentity: ProviderServiceMethod<'captureSessionIdentity'> = Effect.fn(
    'captureSessionIdentity',
  )(function* (input)
  {
    const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId))
    if (binding === undefined)
    {
      return Option.none<ProviderService.ProviderSessionIdentityCapture>()
    }
    const providerInstanceId = yield* requireBindingInstanceId(
      'ProviderService.captureSessionIdentity',
      binding,
    )
    if (
      input.expectedProviderInstanceId !== undefined &&
      input.expectedProviderInstanceId !== providerInstanceId
    )
    {
      return Option.none<ProviderService.ProviderSessionIdentityCapture>()
    }
    const current = yield* runtimeInbox
      .getCurrentSession({ providerInstanceId, threadId: input.threadId })
      .pipe(
        Effect.mapError((cause) =>
          toValidationError(
            'ProviderService.captureSessionIdentity',
            'Unable to read durable provider session identity.',
            cause,
          ),
        ),
      )
    return Option.map(current, (session): ProviderService.ProviderSessionIdentityCapture => ({
      provider: session.provider,
      providerInstanceId,
      threadId: input.threadId,
      sessionGeneration: session.sessionGeneration,
      createdAt: session.createdAt,
    }))
  })

  const captureSessionIdentities: ProviderServiceMethod<'captureSessionIdentities'> = Effect.fn(
    'captureSessionIdentities',
  )(function* (input)
  {
    const sessions = yield* runtimeInbox
      .listAllOpenSessions()
      .pipe(
        Effect.mapError((cause) =>
          toValidationError(
            'ProviderService.captureSessionIdentities',
            'Unable to enumerate durable provider session identities.',
            cause,
          ),
        ),
      )
    return sessions
      .filter((session) => input?.threadId === undefined || session.threadId === input.threadId)
      .map((session): ProviderService.ProviderSessionIdentityCapture => ({
        provider: session.provider,
        providerInstanceId: session.providerInstanceId,
        threadId: session.threadId,
        sessionGeneration: session.sessionGeneration,
        createdAt: session.createdAt,
      }))
  })

  const stopSessionIfExact: ProviderServiceMethod<'stopSessionIfExact'> = Effect.fn(
    'stopSessionIfExact',
  )(function* (identity, context)
  {
    return yield* sessionLifecycleLocks.withPermit(
      identity.threadId,
      stopRuntimeSessionIfExactWithinThreadPermit(identity, context),
    )
  })

  const listSessions: ProviderServiceMethod<'listSessions'> = Effect.fn('listSessions')(
    function* ()
    {
      const currentAdapters = yield* getAdapterEntries
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapterLifecycleLocks.withPermit(
          instanceId,
          Effect.gen(function* ()
          {
            const routing = yield* Ref.get(adapterRoutingState)
            if (
              routing.quarantined.has(instanceId) ||
              routing.subscribed.get(instanceId)?.adapter !== adapter
            )
            {
              return []
            }
            return (yield* adapter.listSessions()).map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            }))
          }),
        ),
      )
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions)
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: 'unbounded' },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      )
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >()
      for (const bindingOption of persistedBindings)
      {
        const binding = Option.getOrUndefined(bindingOption)
        if (binding)
        {
          bindingsByThreadId.set(binding.threadId, binding)
        }
      }

      const sessions: ProviderSession[] = []
      for (const session of activeSessions)
      {
        const binding = bindingsByThreadId.get(session.threadId)
        if (!binding)
        {
          sessions.push(session)
          continue
        }

        const overrides: {
          resumeCursor?: ProviderSession['resumeCursor']
          runtimeMode?: ProviderSession['runtimeMode']
          providerInstanceId?: ProviderSession['providerInstanceId']
        } = {}
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          'ProviderService.listSessions',
          binding,
        )
        if (binding.provider !== session.provider)
        {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          )
        }
        if (overrides.providerInstanceId !== session.providerInstanceId)
        {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          )
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined)
        {
          overrides.resumeCursor = binding.resumeCursor
        }
        if (binding.runtimeMode !== undefined)
        {
          overrides.runtimeMode = binding.runtimeMode
        }
        sessions.push(Object.assign({}, session, overrides))
      }
      return sessions
    },
  )

  const getCapabilities: ProviderServiceMethod<'getCapabilities'> = (instanceId) =>
    adapterLifecycleLocks.withPermit(
      instanceId,
      registry
        .getByInstance(instanceId)
        .pipe(
          Effect.flatMap((adapter) =>
            requireHealthyAdapter('ProviderService.getCapabilities', instanceId, adapter).pipe(
              Effect.as(adapter.capabilities),
            ),
          ),
        ),
    )

  const getInstanceInfo: ProviderServiceMethod<'getInstanceInfo'> = (instanceId) =>
    registry.getInstanceInfo(instanceId)

  const hasRecoverableSession: NonNullable<ProviderServiceMethod<'hasRecoverableSession'>> = (
    threadId,
    instanceId,
  ) =>
    directory
      .getBinding(threadId)
      .pipe(
        Effect.map(
          Option.exists(
            (binding) =>
              binding.providerInstanceId === instanceId &&
              binding.resumeCursor !== undefined &&
              binding.resumeCursor !== null,
          ),
        ),
      )

  const rollbackConversation: ProviderServiceMethod<'rollbackConversation'> = Effect.fn(
    'rollbackConversation',
  )(function* (rawInput, context)
  {
    const input = yield* decodeInputOrValidationError({
      operation: 'ProviderService.rollbackConversation',
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    })
    if (input.numTurns === 0)
    {
      return
    }
    let metricProvider = 'unknown'
    return yield* withProviderInstanceLifecycle(
      {
        threadId: input.threadId,
        operation: 'ProviderService.rollbackConversation',
        requireActiveThread: true,
      },
      Effect.gen(function* ()
      {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: 'ProviderService.rollbackConversation',
          allowRecovery: true,
          expectedProviderInstanceId: input.expectedProviderInstanceId,
          ...(context !== undefined ? { context } : {}),
        })
        metricProvider = routed.adapter.provider
        if (routed.adapter.capabilities.conversationRollback !== 'exact')
        {
          return yield* toValidationError(
            'ProviderService.rollbackConversation',
            `Provider instance '${routed.instanceId}' does not support exact conversation rollback.`,
          )
        }
        yield* Effect.annotateCurrentSpan({
          'provider.operation': 'rollback-conversation',
          'provider.kind': routed.adapter.provider,
          'provider.thread_id': input.threadId,
          'provider.rollback_turns': input.numTurns,
        })
        yield* context === undefined
          ? routed.adapter.rollbackThread(routed.threadId, input.numTurns)
          : routed.adapter.rollbackThread(routed.threadId, input.numTurns, context)
        yield* analytics.record('provider.conversation.rolled_back', {
          provider: routed.adapter.provider,
          turns: input.numTurns,
        })
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: 'rollback',
            }),
        }),
      ),
    )
  })

  const rollbackConversationIfExact: ProviderServiceMethod<'rollbackConversationIfExact'> =
    Effect.fn('rollbackConversationIfExact')(function* (input, context)
    {
      if (input.numTurns === 0)
      {
        return yield* matchesSessionIdentity(input.identity)
      }
      return yield* withActiveThreadLifecycle(
        'ProviderService.rollbackConversationIfExact',
        input.identity.threadId,
        sessionLifecycleLocks.withPermit(
          input.identity.threadId,
          adapterLifecycleLocks.withPermit(
            input.identity.providerInstanceId,
            Effect.gen(function* ()
            {
              yield* requireRunning('ProviderService.rollbackConversationIfExact')
              if (!(yield* matchesSessionIdentity(input.identity)))
              {
                return false
              }
              const binding = Option.getOrUndefined(
                yield* directory.getBinding(input.identity.threadId),
              )
              if (binding?.providerInstanceId !== input.identity.providerInstanceId)
              {
                return false
              }
              const route = yield* registry.getRoute(input.identity.providerInstanceId)
              yield* requireHealthyAdapter(
                'ProviderService.rollbackConversationIfExact',
                input.identity.providerInstanceId,
                route.adapter,
              )
              if (route.adapter.capabilities.conversationRollback !== 'exact')
              {
                return yield* toValidationError(
                  'ProviderService.rollbackConversationIfExact',
                  `Provider instance '${input.identity.providerInstanceId}' does not support exact conversation rollback.`,
                )
              }
              if (!(yield* route.adapter.hasSession(input.identity.threadId)))
              {
                return false
              }
              const adapterBinding = yield* route.adapter.getSessionRuntimeBinding(
                input.identity.threadId,
              )
              if (
                adapterBinding === undefined ||
                adapterBinding.providerInstanceId !== input.identity.providerInstanceId ||
                adapterBinding.threadId !== input.identity.threadId ||
                adapterBinding.sessionGeneration !== input.identity.sessionGeneration ||
                !(yield* matchesSessionIdentity(input.identity))
              )
              {
                return false
              }
              yield* context === undefined
                ? route.adapter.rollbackThread(input.identity.threadId, input.numTurns)
                : route.adapter.rollbackThread(input.identity.threadId, input.numTurns, context)
              yield* analytics.record('provider.conversation.rolled_back', {
                provider: route.adapter.provider,
                turns: input.numTurns,
                exactGeneration: true,
              })
              return true
            }),
          ),
        ),
      )
    })

  const getConversationTurnCountIfExact: ProviderServiceMethod<'getConversationTurnCountIfExact'> =
    Effect.fn('getConversationTurnCountIfExact')(function* (identity)
    {
      return yield* withActiveThreadLifecycle(
        'ProviderService.getConversationTurnCountIfExact',
        identity.threadId,
        sessionLifecycleLocks.withPermit(
          identity.threadId,
          adapterLifecycleLocks.withPermit(
            identity.providerInstanceId,
            Effect.gen(function* ()
            {
              yield* requireRunning('ProviderService.getConversationTurnCountIfExact')
              if (!(yield* matchesSessionIdentity(identity)))
              {
                return Option.none<number>()
              }
              const route = yield* registry.getRoute(identity.providerInstanceId)
              yield* requireHealthyAdapter(
                'ProviderService.getConversationTurnCountIfExact',
                identity.providerInstanceId,
                route.adapter,
              )
              if (
                route.adapter.provider !== identity.provider ||
                !(yield* adapterHasExactSession(
                  'ProviderService.getConversationTurnCountIfExact',
                  route.adapter,
                  identity,
                ))
              )
              {
                return Option.none<number>()
              }
              const snapshot = yield* route.adapter.readThread(identity.threadId)
              return Option.some(snapshot.turns.length)
            }),
          ),
        ),
      )
    })

  interface ShutdownAdapterEntry
  {
    readonly instanceId: ProviderInstanceId
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>
  }

  const collectShutdownAdapters = Effect.fn('ProviderService.collectShutdownAdapters')(
    function* ()
    {
      const state = yield* Ref.get(adapterRoutingState)
      const entries: ShutdownAdapterEntry[] = []
      const add = (
        instanceId: ProviderInstanceId,
        adapter: ProviderAdapterShape<ProviderAdapterError>,
      ) =>
      {
        if (
          !entries.some((entry) => entry.instanceId === instanceId && entry.adapter === adapter)
        )
        {
          entries.push({ instanceId, adapter })
        }
      }
      for (const [instanceId, adapter] of state.subscribed)
      {
        add(instanceId, adapter.adapter)
      }
      for (const [instanceId, quarantine] of state.quarantined)
      {
        add(instanceId, quarantine.adapter)
      }
      for (const instanceId of yield* registry.listInstances())
      {
        add(instanceId, yield* registry.getByInstance(instanceId))
      }
      return entries
    },
  )

  const stopShutdownAdapter = Effect.fn('ProviderService.stopShutdownAdapter')(function* (
    entry: ShutdownAdapterEntry,
  )
  {
    return yield* adapterLifecycleLocks.withPermit(
      entry.instanceId,
      Effect.gen(function* ()
      {
        const sessions = yield* entry.adapter.listSessions()
        const identities = yield* Effect.forEach(sessions, (session) =>
          Effect.gen(function* ()
          {
            const storedBinding = yield* entry.adapter.getSessionRuntimeBinding(session.threadId)
            if (
              storedBinding === undefined ||
              storedBinding.providerInstanceId !== entry.instanceId ||
              storedBinding.threadId !== session.threadId
            )
            {
              yield* Effect.logWarning('provider shutdown found an unbound adapter session', {
                providerInstanceId: entry.instanceId,
                provider: entry.adapter.provider,
                threadId: session.threadId,
              })
              return Option.none<ProviderRuntimeSessionIdentity>()
            }
            const current = yield* runtimeInbox
              .getCurrentSession({
                providerInstanceId: entry.instanceId,
                threadId: session.threadId,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toValidationError(
                    'ProviderService.shutdown',
                    'Unable to compare an adapter session with its durable generation.',
                    cause,
                  ),
                ),
              )
            const exactIdentity = Option.filter(
              Option.map(current, (durable): ProviderRuntimeSessionIdentity => ({
                provider: durable.provider,
                providerInstanceId: durable.providerInstanceId,
                threadId: durable.threadId,
                sessionGeneration: durable.sessionGeneration,
              })),
              (durable) => durable.sessionGeneration === storedBinding.sessionGeneration,
            )
            if (Option.isSome(exactIdentity))
            {
              const directoryBinding = Option.getOrUndefined(
                yield* directory.getBinding(session.threadId),
              )
              if (directoryBinding?.providerInstanceId === entry.instanceId)
              {
                yield* upsertSessionBinding(
                  { ...session, providerInstanceId: entry.instanceId },
                  session.threadId,
                  {
                    lastRuntimeEvent: 'provider.stopAll',
                    lastRuntimeEventAt: yield* nowIso,
                  },
                )
              }
            }
            return exactIdentity
          }),
        )
        yield* entry.adapter.stopAll()
        const closingIdentities = identities.filter(Option.isSome).map((identity) => identity.value)
        yield* Effect.forEach(closingIdentities, awaitSessionExit, {
          concurrency: 'unbounded',
          discard: true,
        })
        return closingIdentities
      }),
    )
  })

  const readAllOpenRuntimeSessions = runtimeInbox
    .listAllOpenSessions()
    .pipe(
      Effect.mapError((cause) =>
        toValidationError(
          'ProviderService.shutdown',
          'Unable to enumerate durable provider sessions during shutdown.',
          cause,
        ),
      ),
    )

  const runStopAll = Effect.fn('runStopAll')(function* ()
  {
    const stoppedAdapters: ShutdownAdapterEntry[] = []
    const closingIdentities: ProviderRuntimeSessionIdentity[] = []

    // bounded follow-up passes catch a registry replacement that completed
    // while shutdown was waiting for an in-flight adapter lifecycle operation.
    for (let pass = 0; pass < 4; pass += 1)
    {
      const entries = yield* collectShutdownAdapters()
      const pending = entries.filter(
        (entry) =>
          !stoppedAdapters.some(
            (stopped) =>
              stopped.instanceId === entry.instanceId && stopped.adapter === entry.adapter,
          ),
      )
      for (const entry of pending)
      {
        closingIdentities.push(...(yield* stopShutdownAdapter(entry)))
        stoppedAdapters.push(entry)
      }
      if (pending.length === 0)
      {
        break
      }
    }

    const unstableAdapters = (yield* collectShutdownAdapters()).filter(
      (entry) =>
        !stoppedAdapters.some(
          (stopped) => stopped.instanceId === entry.instanceId && stopped.adapter === entry.adapter,
        ),
    )
    if (unstableAdapters.length > 0)
    {
      return yield* toValidationError(
        'ProviderService.shutdown',
        'Provider registry continued replacing adapters while shutdown was quiescing admission sources.',
      )
    }

    const subscriptionFibers = yield* Ref.modify(adapterRoutingState, (current) => [
      Array.from(current.subscribed.values(), (subscription) => subscription.fiber),
      { ...current, subscribed: new Map() },
    ])
    yield* Fiber.interruptAll(subscriptionFibers)

    // an in-flight quarantine owns the same keyed permit, so this barrier
    // joins every cleanup before the durable orphan pass and admission fence.
    const cleanupBarriers = yield* collectShutdownAdapters()
    yield* Effect.forEach(
      new Set(cleanupBarriers.map((entry) => entry.instanceId)),
      (instanceId) => adapterLifecycleLocks.withPermit(instanceId, Effect.void),
      { discard: true },
    )

    // after every live adapter has stopped, close crash-orphaned durable
    // generations directly with their immutable admission identity.
    const orphanedSessions = yield* readAllOpenRuntimeSessions
    yield* Effect.forEach(
      orphanedSessions,
      (session) =>
        Effect.gen(function* ()
        {
          const identity: ProviderRuntimeSessionIdentity = {
            provider: session.provider,
            providerInstanceId: session.providerInstanceId,
            threadId: session.threadId,
            sessionGeneration: session.sessionGeneration,
          }
          yield* ensureExactTerminalAdmission({
            identity,
            provider: identity.provider,
            eventIdPrefix: 'provider-shutdown-orphaned',
            reason: 'Closed a durable provider generation without a live adapter context',
            exitKind: 'graceful',
          })
          yield* awaitSessionExit(identity)
        }),
      { concurrency: 'unbounded', discard: true },
    )

    const remainingOpen = yield* readAllOpenRuntimeSessions
    if (remainingOpen.length > 0)
    {
      return yield* toValidationError(
        'ProviderService.shutdown',
        `Provider shutdown cannot fence admission while ${remainingOpen.length} durable generation(s) remain open.`,
      )
    }

    const bindings = yield* directory.listBindings()
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* ()
      {
        const providerInstanceId = yield* requireBindingInstanceId(
          'ProviderService.shutdown',
          binding,
        )
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: 'stopped',
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: 'provider.stopAll',
            lastRuntimeEventAt: yield* nowIso,
          },
        })
      }),
    ).pipe(Effect.asVoid)
    yield* analytics.record('provider.sessions.stopped_all', {
      sessionCount: bindings.length,
    })
    yield* analytics.flush
  }, Effect.ensuring(mcpSessionRegistry.revokeAll))

  const shutdown: ProviderServiceMethod<'shutdown'> = shutdownGate.withPermits(1)(
    providerInstanceMutationGate.withPermits(1)(
      Effect.gen(function* ()
      {
        const completed = yield* Ref.get(shutdownHighWater)
        if (Option.isSome(completed))
        {
          return completed.value
        }
        yield* Ref.set(shuttingDown, true)
        return yield* subscriptionReconciliationGate.withPermits(1)(
          Effect.gen(function* ()
          {
            yield* runStopAll()
            const admissionState = yield* runtimeInbox
              .setAdmissionMode({
                ownerId: admissionOwnerId,
                ownerGeneration: admission.ownerGeneration,
                mode: 'fenced',
                now: yield* nowIso,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toValidationError(
                    'ProviderService.shutdown',
                    'Unable to fence provider admission and capture its high-water.',
                    cause,
                  ),
                ),
              )
            const highWater = admissionState.highWaterSequence ?? admissionState.nextSequence - 1
            yield* Ref.set(shutdownHighWater, Option.some(highWater))
            return highWater
          }),
        )
      }),
    ),
  )

  const getAdmissionHandoffHighWater: ProviderServiceMethod<'getAdmissionHandoffHighWater'> =
    runtimeInbox.getAdmissionState.pipe(
      Effect.flatMap((state) =>
      {
        if (
          state.activeOwnerId !== admissionOwnerId ||
          state.ownerGeneration !== admission.ownerGeneration
        )
        {
          return Effect.fail(
            toValidationError(
              'ProviderService.getAdmissionHandoffHighWater',
              'Provider admission ownership changed before startup handoff completed.',
            ),
          )
        }
        return Effect.succeed(
          state.mode === 'fenced' ? (state.highWaterSequence ?? state.nextSequence - 1) : null,
        )
      }),
      Effect.mapError((cause) =>
        toValidationError(
          'ProviderService.getAdmissionHandoffHighWater',
          'Unable to read the persisted provider admission handoff.',
          cause,
        ),
      ),
    )

  const resumeAdmissionAfterHandoff: ProviderServiceMethod<'resumeAdmissionAfterHandoff'> =
    runtimeInbox
      .resumeAdmissionAfterHandoff({
        ownerId: admissionOwnerId,
        ownerGeneration: admission.ownerGeneration,
        now: yield* nowIso,
      })
      .pipe(
        Effect.mapError((cause) =>
          toValidationError(
            'ProviderService.resumeAdmissionAfterHandoff',
            'Unable to resume provider admission after durable consumer handoff.',
            cause,
          ),
        ),
        Effect.asVoid,
      )

  yield* Effect.addFinalizer(() =>
    shutdown.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('failed to stop provider service', {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  )

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    captureSessionIdentity,
    captureSessionIdentities,
    matchesSessionIdentity,
    getSessionIdentityState,
    stopSessionIfExact,
    getAdmissionHandoffHighWater,
    resumeAdmissionAfterHandoff,
    shutdown,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    hasRecoverableSession,
    rollbackConversation,
    rollbackConversationIfExact,
    getConversationTurnCountIfExact,
    // each access creates a fresh compatibility/observability subscription.
    // state-changing consumers replay only from the durable runtime inbox.
    get streamEvents(): ProviderServiceMethod<'streamEvents'>
    {
      return Stream.fromPubSub(runtimeEventPubSub)
    },
  } satisfies ProviderService.ProviderService['Service']
})

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  Effect.gen(function* ()
  {
    const registryMutator = yield* ProviderInstanceRegistryMutator
    return yield* makeProviderService({ registryMutator })
  }),
)

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions)
{
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options))
}
