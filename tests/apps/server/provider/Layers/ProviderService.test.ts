// tests/apps/server/provider/Layers/ProviderService.test.ts
// verifies provider routing, lazy recovery, persistence, and runtime lifecycle behavior

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from '@t3tools/contracts'
import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import { it, assert, vi } from '@effect/vitest'

import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Metric from 'effect/Metric'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from '../../../../../apps/server/src/provider/Errors.ts'
import type {
  ProviderAdapterRuntimeEvent,
  ProviderAdapterRuntimeSessionBinding,
  ProviderAdapterSessionStartInput,
  ProviderAdapterShape,
  ProviderEffectContext,
} from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'
import * as ProviderAdapterRegistry from '../../../../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts'
import { ProviderBackgroundTaskRegistry } from '../../../../../apps/server/src/provider/Services/ProviderBackgroundTaskRegistry.ts'
import * as ProviderInstanceRegistryMutator from '../../../../../apps/server/src/provider/Services/ProviderInstanceRegistryMutator.ts'
import * as ProviderService from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import { ProviderSessionReaper } from '../../../../../apps/server/src/provider/Services/ProviderSessionReaper.ts'
import * as ProviderSessionDirectory from '../../../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts'
import { ProviderBackgroundTaskRegistryLive } from '../../../../../apps/server/src/provider/Layers/ProviderBackgroundTaskRegistry.ts'
import { makeProviderServiceLive } from '../../../../../apps/server/src/provider/Layers/ProviderService.ts'
import { makeProviderSessionReaperLive } from '../../../../../apps/server/src/provider/Layers/ProviderSessionReaper.ts'
import { ORCHESTRATE_MODE_INSTRUCTIONS } from '../../../../../apps/server/src/provider/CollaborationModeInstructions.ts'
import { providerCapabilitiesForDriver } from '../../../../../apps/server/src/provider/providerCapabilities.ts'
import * as ProviderEventLoggers from '../../../../../apps/server/src/provider/Layers/ProviderEventLoggers.ts'
import { ProviderSessionDirectoryLive } from '../../../../../apps/server/src/provider/Layers/ProviderSessionDirectory.ts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as ProviderSessionRuntime from '../../../../../apps/server/src/persistence/Services/ProviderSessionRuntime.ts'
import * as ProviderSessionRuntimeLayers from '../../../../../apps/server/src/persistence/Layers/ProviderSessionRuntime.ts'
import { ProviderRuntimeInboxLive } from '../../../../../apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts'
import {
  ProviderRuntimeInbox,
  type ProviderRuntimeInboxAdmissionError,
} from '../../../../../apps/server/src/persistence/Services/ProviderRuntimeInbox.ts'
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as McpSessionRegistry from '../../../../../apps/server/src/mcp/McpSessionRegistry.ts'
import * as ServerSettings from '../../../../../apps/server/src/serverSettings.ts'
import * as AnalyticsServiceLayers from '../../../../../apps/server/src/telemetry/Layers/AnalyticsService.ts'
import { makeAdapterRegistryMock } from '../../../../../apps/server/src/provider/testUtils/providerAdapterRegistryMock.ts'
import { makeTestServerStorageLeaseLayer } from '../../support/serverStorageLease.ts'
import { ThreadArchiveLifecyclePermitLive } from '../../../../../apps/server/src/orchestration/Layers/ThreadArchiveLifecyclePermit.ts'
import { ThreadArchiveLifecyclePermit } from '../../../../../apps/server/src/orchestration/Services/ThreadArchiveLifecyclePermit.ts'
import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest()
const providerThreadLifecycleTestLayer = Layer.merge(
  ThreadArchiveLifecyclePermitLive,
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () => Effect.succeed(Option.some(null as never)),
  }),
)

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value)
const asEventId = (value: string): EventId => EventId.make(value)
const asThreadId = (value: string): ThreadId => ThreadId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)
const codexInstanceId = ProviderInstanceId.make('codex')
const claudeAgentInstanceId = ProviderInstanceId.make('claudeAgent')
const CODEX_DRIVER = ProviderDriverKind.make('codex')
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make('claudeAgent')
const CURSOR_DRIVER = ProviderDriverKind.make('cursor')
const CORAL_DRIVER = ProviderDriverKind.make('coral')

const providerRuntimeInboxMemoryLive = ProviderRuntimeInboxLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
)

const makeProviderServiceInboxBackedLive = (
  options?: Parameters<typeof makeProviderServiceLive>[0],
  lifecycleLayer = providerThreadLifecycleTestLayer,
  runtimeInboxLayer = Layer.fresh(providerRuntimeInboxMemoryLive),
) =>
  makeProviderServiceLive(options).pipe(
    Layer.provide(ProviderBackgroundTaskRegistryLive),
    Layer.provide(runtimeInboxLayer),
    Layer.provideMerge(lifecycleLayer),
    Layer.provide(NodeServices.layer),
  )

const makeProviderServiceTestLive = (
  options?: Parameters<typeof makeProviderServiceLive>[0],
  lifecycleLayer = providerThreadLifecycleTestLayer,
  runtimeInboxLayer = Layer.fresh(providerRuntimeInboxMemoryLive),
) =>
  makeProviderServiceInboxBackedLive(options, lifecycleLayer, runtimeInboxLayer).pipe(
    Layer.provide(McpSessionRegistry.disabledLayer),
  )

const observeProviderRuntimeAdmissionLayer = (
  observed: Deferred.Deferred<ProviderRuntimeInboxAdmissionError>,
) =>
  Layer.effect(
    ProviderRuntimeInbox,
    Effect.gen(function* ()
    {
      const inbox = yield* ProviderRuntimeInbox
      return ProviderRuntimeInbox.of({
        ...inbox,
        append: (input) =>
          inbox
            .append(input)
            .pipe(
              Effect.tapError((error) =>
                error._tag === 'ProviderRuntimeInboxAdmissionError'
                  ? Deferred.succeed(observed, error).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
      })
    }),
  ).pipe(Layer.provide(Layer.fresh(providerRuntimeInboxMemoryLive)))

type LegacyProviderRuntimeEvent = {
  readonly type: string
  readonly eventId: EventId
  readonly provider: ProviderDriverKind
  readonly createdAt: string
  readonly threadId: ThreadId
  readonly turnId?: string | undefined
  readonly itemId?: string | undefined
  readonly requestId?: string | undefined
  readonly payload?: unknown | undefined
  readonly [key: string]: unknown
}

function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER)
{
  const sessions = new Map<ThreadId, ProviderSession>()
  const runtimeSessionBindings = new Map<ThreadId, ProviderAdapterRuntimeSessionBinding>()
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderAdapterRuntimeEvent>())
  let exitEventOrdinal = 0

  const startSession = vi.fn(
    (
      input: ProviderAdapterSessionStartInput,
      _context?: ProviderEffectContext,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.sync((): ProviderSession =>
      {
        const now = '2026-01-01T00:00:00.000Z'
        const session: ProviderSession = {
          provider,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: 'ready',
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        }
        sessions.set(session.threadId, session)
        runtimeSessionBindings.set(session.threadId, input.runtimeSessionBinding)
        return session
      }),
  )

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
      _context?: ProviderEffectContext,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    {
      if (!sessions.has(input.threadId))
      {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        )
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      })
    },
  )

  const interruptTurn = vi.fn(
    (
      _threadId: ThreadId,
      _turnId?: TurnId,
      _context?: ProviderEffectContext,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  )

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
      _context?: ProviderEffectContext,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  )

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
      _context?: ProviderEffectContext,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  )

  const stopSession = vi.fn(
    (
      threadId: ThreadId,
      _context?: ProviderEffectContext,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* ()
      {
        if (!sessions.has(threadId))
        {
          return
        }
        exitEventOrdinal += 1
        const binding = runtimeSessionBindings.get(threadId)
        if (binding === undefined)
        {
          return yield* Effect.die(
            new Error(`fake adapter session '${threadId}' has no runtime generation binding`),
          )
        }
        yield* PubSub.publish(runtimeEventPubSub, {
          binding,
          event: {
            type: 'session.exited',
            eventId: EventId.make(`fake-session-exited-${exitEventOrdinal}`),
            provider,
            threadId,
            createdAt: '2026-01-01T00:00:00.000Z',
            payload: {
              reason: 'fake adapter stopped',
              recoverable: false,
              exitKind: 'graceful',
            },
          },
        })
        sessions.delete(threadId)
        runtimeSessionBindings.delete(threadId)
      }),
  )

  const listSessions = vi.fn((): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() => Array.from(sessions.values())),
  )

  const hasSession = vi.fn((threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(sessions.has(threadId)),
  )

  const getSessionRuntimeBinding = vi.fn((threadId: ThreadId) =>
    Effect.succeed(runtimeSessionBindings.get(threadId)),
  )

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId('turn-1'), items: [] }],
      }),
  )

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
      _context?: ProviderEffectContext,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  )

  const stopAll = vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
    Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
      discard: true,
    }),
  )

  // simulate a provider process disappearing without emitting graceful exits
  const clearSession = (threadId: ThreadId): void =>
  {
    sessions.delete(threadId)
    runtimeSessionBindings.delete(threadId)
  }
  const clearSessions = (): void =>
  {
    sessions.clear()
    runtimeSessionBindings.clear()
  }

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: providerCapabilitiesForDriver(provider),
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    getSessionRuntimeBinding,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents()
    {
      return Stream.fromPubSub(runtimeEventPubSub)
    },
  }

  const emit = (event: LegacyProviderRuntimeEvent): void =>
  {
    Effect.runSync(emitEffect(event))
  }

  const emitEffect = (event: LegacyProviderRuntimeEvent) =>
  {
    const binding = runtimeSessionBindings.get(event.threadId)
    return binding === undefined
      ? Effect.die(new Error(`fake adapter session '${event.threadId}' has no runtime binding`))
      : PubSub.publish(runtimeEventPubSub, {
          binding,
          event: event as unknown as ProviderRuntimeEvent,
        })
  }

  const emitWithBindingEffect = (
    binding: ProviderAdapterRuntimeSessionBinding,
    event: LegacyProviderRuntimeEvent,
  ) =>
    PubSub.publish(runtimeEventPubSub, {
      binding,
      event: event as unknown as ProviderRuntimeEvent,
    })

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void =>
  {
    const existing = sessions.get(threadId)
    if (!existing)
    {
      return
    }
    sessions.set(threadId, update(existing))
  }

  return {
    adapter,
    emit,
    emitEffect,
    emitWithBindingEffect,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    getSessionRuntimeBinding,
    readThread,
    rollbackThread,
    stopAll,
    clearSession,
    clearSessions,
  }
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow))

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  )

function makeProviderServiceLayer(
  mcpSessionRegistry: McpSessionRegistry.McpSessionRegistryShape = McpSessionRegistry.__testing
    .disabled,
  serverSettingsLayer = defaultServerSettingsLayer,
)
{
  const codex = makeFakeCodexAdapter()
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER)
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make('codex')]: codex.adapter,
    [ProviderDriverKind.make('claudeAgent')]: claude.adapter,
    [ProviderDriverKind.make('cursor')]: cursor.adapter,
  })

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  )
  const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  )
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceInboxBackedLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, mcpSessionRegistry)),
        Layer.provideMerge(AnalyticsServiceLayers.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  )

  return {
    codex,
    claude,
    cursor,
    layer,
  }
}

function makeRecordingMcpSessionRegistry()
{
  const issued: McpSessionRegistry.McpCredentialRequest[] = []
  const touched: ThreadId[] = []
  const bindings: Array<readonly [ThreadId, TurnId | undefined]> = []
  const revokedThreads: ThreadId[] = []
  const revokedExact: McpSessionRegistry.McpCredentialRequest[] = []
  let revokeAllCount = 0

  const service = McpSessionRegistry.McpSessionRegistry.of({
    enabled: true,
    issue: (request) =>
      Effect.sync(() =>
      {
        issued.push(request)
        const providerSessionId = `provider-session-${issued.length}`
        return {
          config: {
            environmentId: EnvironmentId.make('environment-provider-service-test'),
            threadId: request.threadId,
            providerSessionId,
            providerInstanceId: request.providerInstanceId,
            providerSessionGeneration: request.providerSessionGeneration,
            endpoint: 'http://127.0.0.1:43123/mcp',
            authorizationHeader: `Bearer token-${providerSessionId}`,
            previewToolsAvailable: request.capabilities?.has('preview') ?? true,
          },
        }
      }),
    resolve: () => Effect.as(Effect.void, undefined),
    touch: (threadId) =>
      Effect.sync(() =>
      {
        touched.push(threadId)
      }),
    bindActiveTurn: (threadId, turnId) =>
      Effect.sync(() =>
      {
        bindings.push([threadId, turnId])
      }),
    revokeProviderSession: () => Effect.void,
    revokeExact: (request) =>
      Effect.sync(() =>
      {
        revokedExact.push(request)
      }),
    revokeThread: (threadId) =>
      Effect.sync(() =>
      {
        revokedThreads.push(threadId)
      }),
    revokeAll: Effect.sync(() =>
    {
      revokeAllCount += 1
    }),
  })

  return {
    service,
    issued,
    touched,
    bindings,
    revokedThreads,
    revokedExact,
    get revokeAllCount()
    {
      return revokeAllCount
    },
  }
}

function makeProviderServiceTestLayer(
  registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'],
  lifecycleLayer = providerThreadLifecycleTestLayer,
  runtimeInboxLayer = Layer.fresh(providerRuntimeInboxMemoryLive),
)
{
  const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  )
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
  return makeProviderServiceTestLive(undefined, lifecycleLayer, runtimeInboxLayer).pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(AnalyticsServiceLayers.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  )
}

function makeProviderInstanceLifecycleOwnerTestRegistry(
  initialAdapter: ProviderAdapterShape<ProviderAdapterError>,
)
{
  let currentAdapter = initialAdapter
  let lifecycleOwner:
    ProviderInstanceRegistryMutator.ProviderInstanceRegistryLifecycleOwner | undefined
  let routeReadCount = 0

  const getRoute: ProviderAdapterRegistry.ProviderAdapterRegistryShape['getRoute'] = (
    instanceId,
  ) =>
  {
    routeReadCount += 1
    if (instanceId !== codexInstanceId)
    {
      return Effect.fail(
        new ProviderUnsupportedError({
          provider: ProviderDriverKind.make(instanceId),
        }),
      )
    }
    return Effect.succeed({
      info: {
        instanceId: codexInstanceId,
        driverKind: CODEX_DRIVER,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: CODEX_DRIVER,
          continuationKey: `codex:instance:${codexInstanceId}`,
        },
      },
      adapter: currentAdapter,
    })
  }

  const registry: ProviderAdapterRegistry.ProviderAdapterRegistryShape = {
    getRoute,
    getByInstance: (instanceId) => getRoute(instanceId).pipe(Effect.map((route) => route.adapter)),
    getInstanceInfo: (instanceId) => getRoute(instanceId).pipe(Effect.map((route) => route.info)),
    listInstances: () => Effect.succeed([codexInstanceId]),
    listProviders: () => Effect.succeed([CODEX_DRIVER]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (changes) =>
      PubSub.subscribe(changes),
    ),
  }
  const mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape = {
    reconcile: () => Effect.void,
    registerLifecycleOwner: (owner) =>
      Effect.sync(() =>
      {
        lifecycleOwner = owner
      }),
    unregisterLifecycleOwner: (owner) =>
      Effect.sync(() =>
      {
        if (lifecycleOwner === owner)
        {
          lifecycleOwner = undefined
        }
      }),
  }

  return {
    registry,
    mutator,
    replaceAdapter: (adapter: ProviderAdapterShape<ProviderAdapterError>) =>
    {
      currentAdapter = adapter
    },
    getLifecycleOwner: () =>
    {
      if (lifecycleOwner === undefined)
      {
        throw new Error('ProviderService did not register a provider instance lifecycle owner')
      }
      return lifecycleOwner
    },
    get routeReadCount()
    {
      return routeReadCount
    },
  }
}

function makeProviderLifecycleOwnerServiceTestLayer(
  registry: ProviderAdapterRegistry.ProviderAdapterRegistryShape,
  mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape,
  runtimeInboxLayer = Layer.fresh(providerRuntimeInboxMemoryLive),
)
{
  const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  )
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
  const registryLayer = Layer.merge(
    Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry),
    Layer.succeed(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, mutator),
  )
  const providerLayer = makeProviderServiceTestLive(
    undefined,
    providerThreadLifecycleTestLayer,
    runtimeInboxLayer,
  ).pipe(
    Layer.provide(registryLayer),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(AnalyticsServiceLayers.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  )
  return providerLayer
}

it.effect(
  'fences commands while an old subscription drains and closes exact generations before replacement',
  () =>
    Effect.gen(function* ()
    {
      const oldAdapter = makeFakeCodexAdapter()
      const replacementAdapter = makeFakeCodexAdapter()
      const registryHarness = makeProviderInstanceLifecycleOwnerTestRegistry(oldAdapter.adapter)
      const oldEventId = asEventId('evt-settings-retirement-old-route')
      const replacementEventId = asEventId('evt-settings-retirement-replacement-route')
      const oldAppendEntered = yield* Deferred.make<void>()
      const releaseOldAppend = yield* Deferred.make<void>()
      const oldEventAdmitted = yield* Deferred.make<number>()
      const replacementEventAdmitted = yield* Deferred.make<number>()
      const runtimeInboxLayer = Layer.effect(
        ProviderRuntimeInbox,
        Effect.gen(function* ()
        {
          const inbox = yield* ProviderRuntimeInbox
          return ProviderRuntimeInbox.of({
            ...inbox,
            append: (input) =>
            {
              const append = inbox
                .append(input)
                .pipe(
                  Effect.tap((result) =>
                    input.sourceEventId === oldEventId
                      ? Deferred.succeed(oldEventAdmitted, result.record.sequence).pipe(
                          Effect.asVoid,
                        )
                      : input.sourceEventId === replacementEventId
                        ? Deferred.succeed(replacementEventAdmitted, result.record.sequence).pipe(
                            Effect.asVoid,
                          )
                        : Effect.void,
                  ),
                )
              return input.sourceEventId === oldEventId
                ? Deferred.succeed(oldAppendEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseOldAppend)),
                    Effect.andThen(append),
                  )
                : append
            },
          })
        }),
      ).pipe(Layer.provide(Layer.fresh(providerRuntimeInboxMemoryLive)))
      const layer = makeProviderLifecycleOwnerServiceTestLayer(
        registryHarness.registry,
        registryHarness.mutator,
        runtimeInboxLayer,
      )

      yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        const lifecycleOwner = registryHarness.getLifecycleOwner()
        const threadId = asThreadId('thread-settings-retirement-old-route')
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: 'full-access',
        })
        const runtimeBinding = yield* oldAdapter.getSessionRuntimeBinding(threadId)
        assert.notEqual(runtimeBinding, undefined)
        if (runtimeBinding === undefined)
        {
          return
        }
        const runtimeIdentity = {
          provider: CODEX_DRIVER,
          ...runtimeBinding,
        }

        yield* oldAdapter.emitWithBindingEffect(runtimeBinding, {
          type: 'turn.completed',
          eventId: oldEventId,
          provider: CODEX_DRIVER,
          threadId,
          createdAt: '2026-01-01T00:00:00.000Z',
          payload: { state: 'completed' },
        })
        yield* Deferred.await(oldAppendEntered)

        let mutationSawClosedGeneration = false
        const routeReadsBeforeRetirement = registryHarness.routeReadCount
        const retirement = yield* Effect.forkChild(
          lifecycleOwner.aroundMutation(
            [codexInstanceId],
            Effect.gen(function* ()
            {
              const state = yield* provider.getSessionIdentityState(runtimeIdentity)
              mutationSawClosedGeneration =
                Option.isSome(state) &&
                state.value.status === 'closed' &&
                state.value.closedSequence !== null
              registryHarness.replaceAdapter(replacementAdapter.adapter)
            }),
          ),
        )
        while (registryHarness.routeReadCount === routeReadsBeforeRetirement)
        {
          yield* Effect.yieldNow
        }
        for (let index = 0; index < 5; index += 1)
        {
          yield* Effect.yieldNow
        }

        oldAdapter.sendTurn.mockClear()
        const fencedCommand = yield* Effect.forkChild(
          Effect.result(
            provider.sendTurn({
              threadId,
              input: 'must not cross the settings retirement fence',
              attachments: [],
            }),
          ),
        )
        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseOldAppend, undefined)

        const fencedResult = yield* Fiber.join(fencedCommand)
        assert.equal(fencedResult._tag, 'Failure')
        assert.equal(oldAdapter.sendTurn.mock.calls.length, 0)
        yield* Deferred.await(oldEventAdmitted)
        yield* Fiber.join(retirement)

        assert.equal(mutationSawClosedGeneration, true)
        const retiredState = yield* provider.getSessionIdentityState(runtimeIdentity)
        assert.equal(Option.isSome(retiredState), true)
        if (Option.isSome(retiredState))
        {
          assert.equal(retiredState.value.status, 'closed')
          assert.equal(typeof retiredState.value.closedSequence, 'number')
        }

        const replacementThreadId = asThreadId('thread-settings-retirement-replacement-route')
        yield* provider.startSession(replacementThreadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId: replacementThreadId,
          runtimeMode: 'full-access',
        })
        assert.equal(replacementAdapter.startSession.mock.calls.length, 1)
        yield* replacementAdapter.emitEffect({
          type: 'turn.completed',
          eventId: replacementEventId,
          provider: CODEX_DRIVER,
          threadId: replacementThreadId,
          createdAt: '2026-01-01T00:00:00.000Z',
          payload: { state: 'completed' },
        })
        yield* Deferred.await(replacementEventAdmitted)
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('keeps the old route live and resumes commands when retirement cleanup fails', () =>
  Effect.gen(function* ()
  {
    const oldAdapter = makeFakeCodexAdapter()
    const registryHarness = makeProviderInstanceLifecycleOwnerTestRegistry(oldAdapter.adapter)
    const runtimeInboxLayer = Layer.fresh(providerRuntimeInboxMemoryLive)
    const layer = makeProviderLifecycleOwnerServiceTestLayer(
      registryHarness.registry,
      registryHarness.mutator,
      runtimeInboxLayer,
    )

    yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const lifecycleOwner = registryHarness.getLifecycleOwner()
      const threadId = asThreadId('thread-settings-retirement-cleanup-failure')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      const runtimeBinding = yield* oldAdapter.getSessionRuntimeBinding(threadId)
      assert.notEqual(runtimeBinding, undefined)
      if (runtimeBinding === undefined)
      {
        return
      }
      const runtimeIdentity = {
        provider: CODEX_DRIVER,
        ...runtimeBinding,
      }
      oldAdapter.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: CODEX_DRIVER,
            method: 'stopSession',
            detail: 'simulated settings retirement cleanup failure',
          }),
        ),
      )

      let mutationCommitted = false
      const retirementResult = yield* Effect.result(
        lifecycleOwner.aroundMutation(
          [codexInstanceId],
          Effect.sync(() =>
          {
            mutationCommitted = true
          }),
        ),
      )

      assert.equal(retirementResult._tag, 'Failure')
      assert.equal(mutationCommitted, false)
      const stateAfterFailure = yield* provider.getSessionIdentityState(runtimeIdentity)
      assert.equal(Option.isSome(stateAfterFailure), true)
      if (Option.isSome(stateAfterFailure))
      {
        assert.equal(stateAfterFailure.value.status, 'open')
        assert.equal(stateAfterFailure.value.closedSequence, null)
      }
      oldAdapter.sendTurn.mockClear()
      yield* provider.sendTurn({
        threadId,
        input: 'commands resume against the unchanged route',
        attachments: [],
      })
      assert.equal(oldAdapter.sendTurn.mock.calls.length, 1)
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('serializes addition-only settings mutations with provider shutdown', () =>
  Effect.gen(function* ()
  {
    const adapter = makeFakeCodexAdapter()
    const registryHarness = makeProviderInstanceLifecycleOwnerTestRegistry(adapter.adapter)
    const layer = makeProviderLifecycleOwnerServiceTestLayer(
      registryHarness.registry,
      registryHarness.mutator,
    )

    yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const lifecycleOwner = registryHarness.getLifecycleOwner()
      const mutationEntered = yield* Deferred.make<void>()
      const releaseMutation = yield* Deferred.make<void>()
      const mutation = yield* Effect.forkChild(
        lifecycleOwner.aroundMutation(
          [],
          Deferred.succeed(mutationEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseMutation)),
          ),
        ),
      )
      yield* Deferred.await(mutationEntered)

      const shutdown = yield* Effect.forkChild(provider.shutdown)
      for (let index = 0; index < 5; index += 1)
      {
        yield* Effect.yieldNow
      }
      assert.equal(shutdown.pollUnsafe(), undefined)

      yield* Deferred.succeed(releaseMutation, undefined)
      yield* Fiber.join(mutation)
      assert.equal((yield* Fiber.join(shutdown)) >= 0, true)

      let postShutdownMutationCommitted = false
      const postShutdownResult = yield* Effect.result(
        lifecycleOwner.aroundMutation(
          [],
          Effect.sync(() =>
          {
            postShutdownMutationCommitted = true
          }),
        ),
      )
      assert.equal(postShutdownResult._tag, 'Failure')
      assert.equal(postShutdownMutationCommitted, false)
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('ProviderServiceLive catches stopAll failures during shutdown', () =>
  Effect.gen(function* ()
  {
    const codex = makeFakeCodexAdapter()
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: 'stopAll',
          detail: 'simulated stopAll failure',
        }),
      ),
    )
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    })
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    )
    const mcpSessionRegistry = makeRecordingMcpSessionRegistry()
    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = Layer.mergeAll(
      makeProviderServiceInboxBackedLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(
          Layer.succeed(McpSessionRegistry.McpSessionRegistry, mcpSessionRegistry.service),
        ),
        Layer.provideMerge(AnalyticsServiceLayers.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    )
    const scope = yield* Scope.make()
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope))

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices))
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit)

    assert.equal(Exit.isSuccess(closeExit), true)
    assert.equal(codex.stopAll.mock.calls.length, 1)
    assert.equal(mcpSessionRegistry.revokeAllCount, 1)
  }),
)

it.effect('ProviderServiceLive rejects new sessions for disabled providers', () =>
  Effect.gen(function* ()
  {
    const codex = makeFakeCodexAdapter()
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    })
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
      ...registryBase,
      getRoute: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? registryBase.getRoute(instanceId).pipe(
              Effect.map((route) => ({
                ...route,
                info: { ...route.info, enabled: false },
              })),
            )
          : registryBase.getRoute(instanceId),
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: 'claudeAgent:instance:claudeAgent',
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    }
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    )
    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = makeProviderServiceTestLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsServiceLayers.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    )

    const failure = yield* Effect.flip(
      Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        return yield* provider.startSession(asThreadId('thread-disabled'), {
          provider: ProviderDriverKind.make('claudeAgent'),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId('thread-disabled'),
          runtimeMode: 'full-access',
        })
      }).pipe(Effect.provide(providerLayer)),
    )

    assert.instanceOf(failure, ProviderValidationError)
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled")
    assert.equal(claude.startSession.mock.calls.length, 0)
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('ProviderServiceLive coerces unsupported Coral runtime modes before startSession', () =>
  Effect.gen(function* ()
  {
    const coralInstanceId = ProviderInstanceId.make('coral')
    const coral = makeFakeCodexAdapter(CORAL_DRIVER)
    const registry = makeAdapterRegistryMock({
      [CORAL_DRIVER]: coral.adapter,
    })

    const session = yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      return yield* provider.startSession(asThreadId('thread-coral-mode-coerce'), {
        provider: CORAL_DRIVER,
        providerInstanceId: coralInstanceId,
        threadId: asThreadId('thread-coral-mode-coerce'),
        runtimeMode: 'full-access',
      })
    }).pipe(Effect.provide(makeProviderServiceTestLayer(registry)))

    assert.equal(session.runtimeMode, 'approval-required')
    assert.equal(coral.startSession.mock.calls.length, 1)
    assert.equal(coral.startSession.mock.calls[0]?.[0].runtimeMode, 'approval-required')
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('ProviderServiceLive rejects resume on a cwd-sensitive ACP route', () =>
  Effect.gen(function* ()
  {
    const instanceId = ProviderInstanceId.make('cursor_relative')
    const cursor = makeFakeCodexAdapter(CURSOR_DRIVER)
    const getRoute = () =>
      Effect.succeed({
        info: {
          instanceId,
          driverKind: CURSOR_DRIVER,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind: CURSOR_DRIVER,
            continuationKey: 'cursor:acp:v1:relative',
          },
          continuationUnavailableReason:
            "the ACP executable './cursor-agent' is relative to each thread working directory",
        },
        adapter: cursor.adapter,
      })
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
      getRoute,
      getByInstance: () => getRoute().pipe(Effect.map((route) => route.adapter)),
      getInstanceInfo: () => getRoute().pipe(Effect.map((route) => route.info)),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CURSOR_DRIVER]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
    }

    const failure = yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      return yield* provider
        .startSession(asThreadId('thread-relative-acp-resume'), {
          provider: CURSOR_DRIVER,
          providerInstanceId: instanceId,
          threadId: asThreadId('thread-relative-acp-resume'),
          resumeCursor: { sessionId: 'native-session' },
          runtimeMode: 'full-access',
        })
        .pipe(Effect.flip)
    }).pipe(Effect.provide(makeProviderServiceTestLayer(registry)))

    assert.instanceOf(failure, ProviderValidationError)
    assert.include(failure.issue, 'cannot safely continue sessions')
    assert.equal(cursor.startSession.mock.calls.length, 0)
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('serializes provider lifecycle creation with archive cleanup in both directions', () =>
  Effect.gen(function* ()
  {
    let threadActive = true
    const codex = makeFakeCodexAdapter()
    const originalStart = codex.startSession.getMockImplementation()
    assert.isDefined(originalStart)
    if (originalStart === undefined) return
    const startEntered = yield* Deferred.make<void>()
    const releaseStart = yield* Deferred.make<void>()
    codex.startSession.mockImplementation((input, context) =>
      Deferred.succeed(startEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStart)),
        Effect.andThen(originalStart(input, context)),
      ),
    )
    const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter })
    const archivePermitLayer = Layer.fresh(ThreadArchiveLifecyclePermitLive)
    const lifecycleLayer = Layer.merge(
      archivePermitLayer,
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () =>
          Effect.sync(() => (threadActive ? Option.some(null as never) : Option.none())),
      }),
    )
    const providerLayer = makeProviderServiceTestLayer(registry, lifecycleLayer)

    yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const archivePermit = yield* ThreadArchiveLifecyclePermit
      const threadId = asThreadId('thread-provider-archive-permit')
      const starting = yield* Effect.forkChild(
        provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: 'full-access',
        }),
      )
      yield* Deferred.await(startEntered)

      const archiveEntered = yield* Deferred.make<void>()
      const capturing = yield* Effect.forkChild(
        archivePermit.withPermit(
          threadId,
          Effect.gen(function* ()
          {
            threadActive = false
            yield* Deferred.succeed(archiveEntered, undefined)
            return yield* provider.captureSessionIdentity({
              threadId,
            })
          }),
        ),
      )
      yield* Effect.yieldNow
      assert.isUndefined(capturing.pollUnsafe())

      yield* Deferred.succeed(releaseStart, undefined)
      yield* Fiber.join(starting)
      const captured = yield* Fiber.join(capturing)
      assert.equal(Option.isSome(captured), true)
      assert.equal(codex.startSession.mock.calls.length, 1)

      threadActive = true
      const archiveHolding = yield* Deferred.make<void>()
      const releaseArchive = yield* Deferred.make<void>()
      const archive = yield* Effect.forkChild(
        archivePermit.withPermit(
          threadId,
          Effect.sync(() =>
          {
            threadActive = false
          }).pipe(
            Effect.andThen(Deferred.succeed(archiveHolding, undefined)),
            Effect.andThen(Deferred.await(releaseArchive)),
          ),
        ),
      )
      yield* Deferred.await(archiveHolding)
      const blockedStart = yield* Effect.forkChild(
        Effect.exit(
          provider.startSession(threadId, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            runtimeMode: 'full-access',
          }),
        ),
      )
      yield* Effect.yieldNow
      assert.isUndefined(blockedStart.pollUnsafe())

      yield* Deferred.succeed(releaseArchive, undefined)
      yield* Fiber.join(archive)
      const blockedExit = yield* Fiber.join(blockedStart)
      assert.equal(Exit.isFailure(blockedExit), true)
      assert.equal(codex.startSession.mock.calls.length, 1)
    }).pipe(Effect.provide(providerLayer))
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'compensates allocated provider generations after interrupted starts and failed recovery',
  () =>
    Effect.gen(function* ()
    {
      const codex = makeFakeCodexAdapter()
      const originalStart = codex.startSession.getMockImplementation()
      assert.isDefined(originalStart)
      if (originalStart === undefined) return
      const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter })
      const providerLayer = makeProviderServiceTestLayer(registry)

      yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService

        const beforeAdapterThread = asThreadId('thread-start-interrupted-before-adapter')
        const beforeAdapterEntered = yield* Deferred.make<void>()
        const holdBeforeAdapter = yield* Deferred.make<void>()
        codex.startSession.mockImplementation((input, context) =>
          Deferred.succeed(beforeAdapterEntered, undefined).pipe(
            Effect.andThen(Deferred.await(holdBeforeAdapter)),
            Effect.andThen(originalStart(input, context)),
          ),
        )
        const beforeAdapterFiber = yield* Effect.forkChild(
          provider.startSession(beforeAdapterThread, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId: beforeAdapterThread,
            runtimeMode: 'full-access',
          }),
        )
        yield* Deferred.await(beforeAdapterEntered)
        yield* Fiber.interrupt(beforeAdapterFiber)
        const beforeAdapterState = yield* provider.getSessionIdentityState({
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId: beforeAdapterThread,
          sessionGeneration: 1,
        })
        assert.equal(Option.isSome(beforeAdapterState), true)
        if (Option.isSome(beforeAdapterState))
        {
          assert.equal(beforeAdapterState.value.status, 'closed')
          assert.equal(typeof beforeAdapterState.value.closedSequence, 'number')
        }
        assert.equal(yield* codex.hasSession(beforeAdapterThread), false)

        const afterAdapterThread = asThreadId('thread-start-interrupted-after-adapter')
        const afterAdapterEntered = yield* Deferred.make<void>()
        const holdAfterAdapter = yield* Deferred.make<void>()
        codex.startSession.mockImplementation((input, context) =>
          originalStart(input, context).pipe(
            Effect.tap(() => Deferred.succeed(afterAdapterEntered, undefined)),
            Effect.flatMap((session) => Deferred.await(holdAfterAdapter).pipe(Effect.as(session))),
          ),
        )
        const afterAdapterFiber = yield* Effect.forkChild(
          provider.startSession(afterAdapterThread, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId: afterAdapterThread,
            runtimeMode: 'full-access',
          }),
        )
        yield* Deferred.await(afterAdapterEntered)
        yield* Fiber.interrupt(afterAdapterFiber)
        const afterAdapterState = yield* provider.getSessionIdentityState({
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId: afterAdapterThread,
          sessionGeneration: 1,
        })
        assert.equal(Option.isSome(afterAdapterState), true)
        if (Option.isSome(afterAdapterState))
        {
          assert.equal(afterAdapterState.value.status, 'closed')
          assert.equal(typeof afterAdapterState.value.closedSequence, 'number')
        }
        assert.equal(yield* codex.hasSession(afterAdapterThread), false)

        codex.startSession.mockImplementation(originalStart)
        const recoveryThread = asThreadId('thread-recovery-start-failure')
        yield* provider.startSession(recoveryThread, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId: recoveryThread,
          runtimeMode: 'full-access',
        })
        codex.clearSession(recoveryThread)
        codex.startSession.mockImplementation(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: CODEX_DRIVER,
              method: 'startSession',
              detail: 'simulated recovery failure after durable allocation',
            }),
          ),
        )
        assert.equal(
          (yield* Effect.result(
            provider.sendTurn({
              threadId: recoveryThread,
              input: 'must fail recovery',
              attachments: [],
            }),
          ))._tag,
          'Failure',
        )
        const recoveryState = yield* provider.getSessionIdentityState({
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId: recoveryThread,
          sessionGeneration: 1,
        })
        assert.equal(Option.isSome(recoveryState), true)
        if (Option.isSome(recoveryState))
        {
          assert.equal(recoveryState.value.status, 'closed')
          assert.equal(typeof recoveryState.value.closedSequence, 'number')
        }
        assert.deepEqual(yield* provider.captureSessionIdentities({ threadId: recoveryThread }), [])
      }).pipe(Effect.provide(providerLayer))
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('closes a persisted exact generation after its configured route is removed', () =>
  Effect.gen(function* ()
  {
    const codex = makeFakeCodexAdapter()
    const subscriptionClosed = yield* Deferred.make<void>()
    const changes = yield* PubSub.unbounded<void>()
    let routeAvailable = true
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      ...codex.adapter,
      get streamEvents()
      {
        return codex.adapter.streamEvents.pipe(
          Stream.ensuring(Deferred.succeed(subscriptionClosed, undefined)),
        )
      },
    }
    const unsupported = () => new ProviderUnsupportedError({ provider: CODEX_DRIVER })
    const getRoute: ProviderAdapterRegistry.ProviderAdapterRegistry['Service']['getRoute'] = () =>
      routeAvailable
        ? Effect.succeed({
            info: {
              instanceId: codexInstanceId,
              driverKind: CODEX_DRIVER,
              displayName: undefined,
              enabled: true,
              continuationIdentity: {
                driverKind: CODEX_DRIVER,
                continuationKey: `codex:instance:${codexInstanceId}`,
              },
            },
            adapter,
          })
        : Effect.fail(unsupported())
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
      getRoute,
      getByInstance: (instanceId) =>
        getRoute(instanceId).pipe(Effect.map((route) => route.adapter)),
      getInstanceInfo: (instanceId) => getRoute(instanceId).pipe(Effect.map((route) => route.info)),
      listInstances: () => Effect.succeed(routeAvailable ? [codexInstanceId] : []),
      listProviders: () => Effect.succeed(routeAvailable ? [CODEX_DRIVER] : []),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    }

    yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-provider-route-removed')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      const identity = yield* provider.captureSessionIdentity({ threadId })
      assert.equal(Option.isSome(identity), true)
      if (Option.isNone(identity)) return

      codex.clearSession(threadId)
      routeAvailable = false
      yield* PubSub.publish(changes, undefined)
      yield* Deferred.await(subscriptionClosed)

      assert.equal(yield* provider.stopSessionIfExact(identity.value), true)
      const closed = yield* provider.getSessionIdentityState(identity.value)
      assert.equal(Option.isSome(closed), true)
      if (Option.isSome(closed))
      {
        assert.equal(closed.value.provider, CODEX_DRIVER)
        assert.equal(closed.value.status, 'closed')
        assert.equal(typeof closed.value.closedSequence, 'number')
      }
    }).pipe(Effect.provide(makeProviderServiceTestLayer(registry)))
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'ProviderServiceLive allows enabled custom instances when legacy driver is disabled',
  () =>
    Effect.gen(function* ()
    {
      const instanceId = ProviderInstanceId.make('codex_personal')
      const driverKind = CODEX_DRIVER
      const codex = makeFakeCodexAdapter()
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        })
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
        getRoute: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                info: {
                  instanceId,
                  driverKind,
                  displayName: 'Codex Personal',
                  enabled: true,
                  continuationIdentity: {
                    driverKind,
                    continuationKey: 'codex:/Users/example/.codex',
                  },
                },
                adapter: codex.adapter,
              })
            : Effect.fail(unsupported()),
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: 'Codex Personal',
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: 'codex:/Users/example/.codex',
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      }
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      )
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      })
      const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      )
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const providerLayer = makeProviderServiceTestLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(AnalyticsServiceLayers.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      )

      const session = yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        return yield* provider.startSession(asThreadId('thread-enabled-custom'), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId('thread-enabled-custom'),
          runtimeMode: 'full-access',
        })
      }).pipe(Effect.provide(providerLayer))

      assert.equal(session.providerInstanceId, instanceId)
      assert.equal(codex.startSession.mock.calls.length, 1)
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('ProviderServiceLive rejects new sessions for disabled custom instances', () =>
  Effect.gen(function* ()
  {
    const instanceId = ProviderInstanceId.make('codex_personal')
    const driverKind = ProviderDriverKind.make('codex')
    const codex = makeFakeCodexAdapter()
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make('codex'),
      })
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
      getRoute: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              info: {
                instanceId,
                driverKind,
                displayName: 'Codex Personal',
                enabled: false,
                continuationIdentity: {
                  driverKind,
                  continuationKey: 'codex:/Users/example/.codex',
                },
              },
              adapter: codex.adapter,
            })
          : Effect.fail(unsupported()),
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: 'Codex Personal',
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: 'codex:/Users/example/.codex',
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    }
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    )
    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = makeProviderServiceTestLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsServiceLayers.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    )

    const failure = yield* Effect.flip(
      Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        return yield* provider.startSession(asThreadId('thread-disabled-instance'), {
          provider: ProviderDriverKind.make('codex'),
          providerInstanceId: instanceId,
          threadId: asThreadId('thread-disabled-instance'),
          runtimeMode: 'full-access',
        })
      }).pipe(Effect.provide(providerLayer)),
    )

    assert.instanceOf(failure, ProviderValidationError)
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled")
    assert.equal(codex.startSession.mock.calls.length, 0)
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'ProviderServiceLive rejects a same-instance start after its continuation source changes',
  () =>
    Effect.gen(function* ()
    {
      const instanceId = ProviderInstanceId.make('shared-start-instance')
      const codex = makeFakeCodexAdapter(CODEX_DRIVER)
      const acceptedIdentity = {
        driverKind: CODEX_DRIVER,
        continuationKey: 'codex:home:/provider-home-a',
      }
      const currentIdentity = {
        driverKind: CODEX_DRIVER,
        continuationKey: 'codex:home:/provider-home-b',
      }
      const getRoute = () =>
        Effect.succeed({
          info: {
            instanceId,
            driverKind: CODEX_DRIVER,
            displayName: undefined,
            enabled: true,
            continuationIdentity: currentIdentity,
          },
          adapter: codex.adapter,
        })
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
        getRoute,
        getByInstance: () => getRoute().pipe(Effect.map((route) => route.adapter)),
        getInstanceInfo: () => getRoute().pipe(Effect.map((route) => route.info)),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([CODEX_DRIVER]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }

      return yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        const failure = yield* provider
          .startSession(
            asThreadId('thread-authorized-start'),
            {
              provider: CODEX_DRIVER,
              providerInstanceId: instanceId,
              threadId: asThreadId('thread-authorized-start'),
              runtimeMode: 'approval-required',
            },
            {
              provider: CODEX_DRIVER,
              providerInstanceId: instanceId,
              continuationIdentity: acceptedIdentity,
            },
          )
          .pipe(Effect.flip)

        assert.instanceOf(failure, ProviderValidationError)
        assert.include(failure.issue, 'continuation source changed')
        assert.include(failure.issue, acceptedIdentity.continuationKey)
        assert.include(failure.issue, currentIdentity.continuationKey)
        assert.equal(codex.startSession.mock.calls.length, 0)
      }).pipe(Effect.provide(makeProviderServiceTestLayer(registry)))
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'ProviderServiceLive retains continuation identity after send and rejects later source changes',
  () =>
    Effect.gen(function* ()
    {
      const instanceId = ProviderInstanceId.make('shared-send-instance')
      const threadId = asThreadId('thread-authorized-send')
      const codex = makeFakeCodexAdapter(CODEX_DRIVER)
      const acceptedIdentity = {
        driverKind: CODEX_DRIVER,
        continuationKey: 'codex:home:/provider-home-a',
      }
      let currentIdentity = acceptedIdentity
      const getRoute = () =>
        Effect.succeed({
          info: {
            instanceId,
            driverKind: CODEX_DRIVER,
            displayName: undefined,
            enabled: true,
            continuationIdentity: currentIdentity,
          },
          adapter: codex.adapter,
        })
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
        getRoute,
        getByInstance: () => getRoute().pipe(Effect.map((route) => route.adapter)),
        getInstanceInfo: () => getRoute().pipe(Effect.map((route) => route.info)),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([CODEX_DRIVER]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }

      return yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        yield* provider.startSession(
          threadId,
          {
            provider: CODEX_DRIVER,
            providerInstanceId: instanceId,
            threadId,
            runtimeMode: 'approval-required',
          },
          {
            provider: CODEX_DRIVER,
            providerInstanceId: instanceId,
            continuationIdentity: acceptedIdentity,
          },
        )
        yield* provider.sendTurn({
          threadId,
          input: 'first authorized turn',
          attachments: [],
        })

        currentIdentity = {
          driverKind: CODEX_DRIVER,
          continuationKey: 'codex:home:/provider-home-b',
        }
        const failure = yield* provider
          .sendTurn({
            threadId,
            input: 'must stay on the imported source',
            attachments: [],
          })
          .pipe(Effect.flip)

        assert.instanceOf(failure, ProviderValidationError)
        assert.include(failure.issue, 'continuation source changed')
        assert.include(failure.issue, acceptedIdentity.continuationKey)
        assert.include(failure.issue, currentIdentity.continuationKey)
        assert.equal(codex.startSession.mock.calls.length, 1)
        assert.equal(codex.sendTurn.mock.calls.length, 1)
      }).pipe(Effect.provide(makeProviderServiceTestLayer(registry)))
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('ProviderServiceLive resets authority when switching same-driver instances', () =>
  Effect.gen(function* ()
  {
    const firstInstanceId = ProviderInstanceId.make('codex_first')
    const secondInstanceId = ProviderInstanceId.make('codex_second')
    const first = makeFakeCodexAdapter(CODEX_DRIVER)
    const second = makeFakeCodexAdapter(CODEX_DRIVER)
    const adapters = new Map([
      [firstInstanceId, first.adapter],
      [secondInstanceId, second.adapter],
    ])
    const getRoute: ProviderAdapterRegistry.ProviderAdapterRegistry['Service']['getRoute'] = (
      instanceId,
    ) =>
    {
      const adapter = adapters.get(instanceId)
      return adapter === undefined
        ? Effect.fail(new ProviderUnsupportedError({ provider: instanceId }))
        : Effect.succeed({
            info: {
              instanceId,
              driverKind: CODEX_DRIVER,
              displayName: undefined,
              enabled: true,
              continuationIdentity: {
                driverKind: CODEX_DRIVER,
                continuationKey: `codex:file:v1:${instanceId}`,
              },
            },
            adapter,
          })
    }
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
      getRoute,
      getByInstance: (instanceId) =>
        getRoute(instanceId).pipe(Effect.map((route) => route.adapter)),
      getInstanceInfo: (instanceId) => getRoute(instanceId).pipe(Effect.map((route) => route.info)),
      listInstances: () => Effect.succeed([firstInstanceId, secondInstanceId]),
      listProviders: () => Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
    }
    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const serviceLayer = makeProviderServiceTestLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsServiceLayers.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    )
    const layer = Layer.mergeAll(serviceLayer, directoryLayer, runtimeRepositoryLayer)

    yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
      const threadId = asThreadId('thread-same-driver-switch')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: firstInstanceId,
        threadId,
        modelSelection: createModelSelection(firstInstanceId, 'model-a'),
        runtimeMode: 'full-access',
      })
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: secondInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })

      const binding = yield* directory.getBinding(threadId)
      assert.equal(Option.isSome(binding), true)
      if (Option.isSome(binding))
      {
        assert.equal(binding.value.providerInstanceId, secondInstanceId)
        assert.deepEqual(binding.value.runtimePayload, {
          cwd: process.cwd(),
          model: null,
          activeTurnId: null,
          lastError: null,
          continuationIdentity: {
            driverKind: CODEX_DRIVER,
            continuationKey: `codex:file:v1:${secondInstanceId}`,
          },
        })
      }
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.provide(NodeServices.layer)),
)

const routing = makeProviderServiceLayer()
const recordedMcp = makeRecordingMcpSessionRegistry()
const mcpRouting = makeProviderServiceLayer(recordedMcp.service)

mcpRouting.layer('scopes MCP credentials to provider sessions', (it) =>
{
  it.effect('passes launch config, binds turns, and revokes the stopped thread', () =>
    Effect.gen(function* ()
    {
      recordedMcp.issued.length = 0
      recordedMcp.touched.length = 0
      recordedMcp.bindings.length = 0
      recordedMcp.revokedThreads.length = 0
      recordedMcp.revokedExact.length = 0
      mcpRouting.codex.startSession.mockClear()
      mcpRouting.codex.sendTurn.mockClear()
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-mcp-turn-binding')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      const startInput = mcpRouting.codex.startSession.mock.calls[0]?.[0]
      assert.deepEqual(
        recordedMcp.issued[0]?.capabilities,
        new Set(['preview', 'proposal', 'orchestrate', 'architecture']),
      )
      assert.deepEqual(startInput?.mcp, {
        environmentId: EnvironmentId.make('environment-provider-service-test'),
        threadId,
        providerSessionId: 'provider-session-1',
        providerInstanceId: codexInstanceId,
        providerSessionGeneration: 1,
        endpoint: 'http://127.0.0.1:43123/mcp',
        authorizationHeader: 'Bearer token-provider-session-1',
        previewToolsAvailable: true,
      })
      const turn = yield* provider.sendTurn({
        threadId,
        input: 'bind this proposal turn',
        attachments: [],
      })

      assert.deepEqual(recordedMcp.touched, [threadId])
      assert.deepEqual(recordedMcp.bindings, [
        [threadId, undefined],
        [threadId, turn.turnId],
      ])
      yield* provider.stopSession({ threadId })
      assert.deepEqual(recordedMcp.revokedExact, [
        {
          threadId,
          providerInstanceId: codexInstanceId,
          providerSessionGeneration: 1,
        },
      ])
    }),
  )

  it.effect('retains the exact credential when provider stop leaves the session live', () =>
    Effect.gen(function* ()
    {
      recordedMcp.issued.length = 0
      recordedMcp.touched.length = 0
      recordedMcp.bindings.length = 0
      recordedMcp.revokedThreads.length = 0
      recordedMcp.revokedExact.length = 0
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-mcp-failed-stop')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      mcpRouting.codex.stopSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CODEX_DRIVER),
            method: 'stopSession',
            detail: 'simulated stop failure',
          }),
        ),
      )

      const result = yield* provider.stopSession({ threadId }).pipe(Effect.result)

      assert.equal(result._tag, 'Failure')
      assert.deepEqual(recordedMcp.revokedExact, [])
    }),
  )
})

const restrictedMcp = makeRecordingMcpSessionRegistry()
const restrictedMcpRouting = makeProviderServiceLayer(
  restrictedMcp.service,
  ServerSettings.ServerSettingsService.layerTest({ enableAgentBrowserAccess: false }),
)

restrictedMcpRouting.layer('agent browser access', (it) =>
{
  it.effect('withholds preview while retaining the other MCP capabilities', () =>
    Effect.gen(function* ()
    {
      restrictedMcp.issued.length = 0
      restrictedMcpRouting.codex.startSession.mockClear()
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-browser-access-off')

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })

      assert.deepEqual(
        restrictedMcp.issued[0]?.capabilities,
        new Set(['proposal', 'orchestrate', 'architecture']),
      )
      assert.equal(
        restrictedMcpRouting.codex.startSession.mock.calls[0]?.[0].mcp?.previewToolsAvailable,
        false,
      )
    }),
  )
})

it.effect('ProviderServiceLive writes canonical events to the emitting thread segment', () =>
  Effect.gen(function* ()
  {
    const codex = makeFakeCodexAdapter()
    const canonicalEvents: ProviderRuntimeEvent[] = []
    const canonicalThreadIds: Array<string | null> = []
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make('codex')]: codex.adapter,
    })
    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = makeProviderServiceTestLive({
      canonicalEventLogger: {
        filePath: 'memory://provider-canonical-events',
        write: (event, threadId) =>
        {
          canonicalEvents.push(event as ProviderRuntimeEvent)
          canonicalThreadIds.push(threadId ?? null)
          return Effect.void
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsServiceLayers.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    )

    yield* Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-canonical-thread-segment')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      yield* advanceTestClock(10)
      codex.emit({
        eventId: asEventId('evt-canonical-thread-segment'),
        provider: ProviderDriverKind.make('codex'),
        threadId,
        createdAt: '2026-01-01T00:00:00.000Z',
        type: 'turn.completed',
        payload: {
          state: 'completed',
        },
      })
      yield* advanceTestClock(20)
    }).pipe(Effect.provide(providerLayer))

    const emitted = canonicalEvents.find(
      (event) => event.eventId === 'evt-canonical-thread-segment',
    )
    assert.equal(emitted?.threadId, 'thread-canonical-thread-segment')
    assert.equal(
      canonicalThreadIds.every((threadId) => threadId === 'thread-canonical-thread-segment'),
      true,
    )
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect('ProviderServiceLive keeps persisted resumable sessions on startup', () =>
  Effect.gen(function* ()
  {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 't3-provider-service-'))
    const dbPath = NodePath.join(tempDir, 'orchestration.sqlite')

    const codex = makeFakeCodexAdapter()
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make('codex')]: codex.adapter,
    })

    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provideMerge(makeTestServerStorageLeaseLayer(tempDir)),
    )
    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(persistenceLayer),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))

    yield* Effect.gen(function* ()
    {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
      yield* directory.upsert({
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make('thread-stale'),
      })
    }).pipe(Effect.provide(directoryLayer))

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerThreadLifecycleTestLayer),
      Layer.provide(ProviderBackgroundTaskRegistryLive),
      Layer.provide(McpSessionRegistry.disabledLayer),
      Layer.provide(ProviderRuntimeInboxLive),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsServiceLayers.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(persistenceLayer),
    )

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer))

    const persistedProvider = yield* Effect.gen(function* ()
    {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
      return yield* directory.getProvider(asThreadId('thread-stale'))
    }).pipe(Effect.provide(directoryLayer))
    assert.equal(persistedProvider, 'codex')

    const runtime = yield* Effect.gen(function* ()
    {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository
      return yield* repository.getByThreadId({
        threadId: asThreadId('thread-stale'),
      })
    }).pipe(Effect.provide(runtimeRepositoryLayer))
    assert.equal(Option.isSome(runtime), true)

    const legacyTableRows = yield* Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `
    }).pipe(Effect.provide(persistenceLayer))
    assert.equal(legacyTableRows.length, 0)

    NodeFS.rmSync(tempDir, { recursive: true, force: true })
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'ProviderServiceLive restores rollback routing after restart using persisted thread mapping',
  () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-provider-service-restart-'),
      )
      const dbPath = NodePath.join(tempDir, 'orchestration.sqlite')
      const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
        Layer.provideMerge(makeTestServerStorageLeaseLayer(tempDir)),
      )
      const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
        Layer.provide(persistenceLayer),
      )

      const firstCodex = makeFakeCodexAdapter()
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make('codex')]: firstCodex.adapter,
      })

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerThreadLifecycleTestLayer),
        Layer.provide(ProviderBackgroundTaskRegistryLive),
        Layer.provide(McpSessionRegistry.disabledLayer),
        Layer.provide(ProviderRuntimeInboxLive),
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsServiceLayers.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provide(persistenceLayer),
      )
      const updatedResumeCursor = {
        threadId: asThreadId('thread-1'),
        resume: 'resume-session-1',
        resumeSessionAt: 'assistant-message-1',
        turnCount: 1,
      }

      const startedSession = yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        const threadId = asThreadId('thread-1')
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make('codex'),
          providerInstanceId: codexInstanceId,
          cwd: '/tmp/project',
          runtimeMode: 'full-access',
          threadId,
        })
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: 'ready',
          resumeCursor: updatedResumeCursor,
          updatedAt: '2026-01-01T00:00:01.000Z',
        }))
        return session
      }).pipe(Effect.provide(firstProviderLayer))

      const persistedAfterStopAll = yield* Effect.gen(function* ()
      {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        })
      }).pipe(Effect.provide(runtimeRepositoryLayer))
      assert.equal(Option.isSome(persistedAfterStopAll), true)
      if (Option.isSome(persistedAfterStopAll))
      {
        assert.equal(persistedAfterStopAll.value.status, 'stopped')
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor)
      }

      // mirror the production handoff after both durable lanes drain the fenced high-water
      yield* Effect.gen(function* ()
      {
        const sql = yield* SqlClient.SqlClient
        const control = yield* sql<{ readonly highWater: number }>`
          SELECT next_sequence - 1 AS "highWater"
          FROM provider_runtime_inbox_control
          WHERE singleton_id = 1
        `
        const highWater = control[0]?.highWater
        assert.equal(typeof highWater, 'number')
        if (highWater === undefined) return
        yield* Effect.forEach(
          ['provider-runtime-ingestion', 'provider-runtime-checkpoint'],
          (consumerId) => sql`
            INSERT INTO orchestration_reactor_progress (
              reactor_id,
              operation_version,
              mode,
              cursor_sequence,
              shadow_cursor_sequence,
              updated_at
            )
            VALUES (${consumerId}, 1, 'durable', ${highWater}, ${highWater}, ${'2026-01-01T00:00:02.000Z'})
            ON CONFLICT (reactor_id) DO UPDATE SET
              cursor_sequence = excluded.cursor_sequence,
              shadow_cursor_sequence = excluded.shadow_cursor_sequence,
              updated_at = excluded.updated_at
          `,
          { discard: true },
        )
      }).pipe(Effect.provide(persistenceLayer))

      const secondCodex = makeFakeCodexAdapter()
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make('codex')]: secondCodex.adapter,
      })
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerThreadLifecycleTestLayer),
        Layer.provide(ProviderBackgroundTaskRegistryLive),
        Layer.provide(McpSessionRegistry.disabledLayer),
        Layer.provide(ProviderRuntimeInboxLive),
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsServiceLayers.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provide(persistenceLayer),
      )

      secondCodex.startSession.mockClear()
      secondCodex.rollbackThread.mockClear()

      yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
          expectedProviderInstanceId: ProviderInstanceId.make('codex'),
        })
      }).pipe(Effect.provide(secondProviderLayer))

      assert.equal(secondCodex.startSession.mock.calls.length, 1)
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0]
      assert.equal(typeof resumedStartInput === 'object' && resumedStartInput !== null, true)
      if (resumedStartInput && typeof resumedStartInput === 'object')
      {
        const startPayload = resumedStartInput as {
          provider?: string
          cwd?: string
          resumeCursor?: unknown
          threadId?: string
        }
        assert.equal(startPayload.provider, 'codex')
        assert.equal(startPayload.cwd, '/tmp/project')
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor)
        assert.equal(startPayload.threadId, startedSession.threadId)
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1)
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0]
      assert.equal(typeof rollbackCall?.[0], 'string')
      assert.equal(rollbackCall?.[1], 1)

      NodeFS.rmSync(tempDir, { recursive: true, force: true })
    }).pipe(Effect.provide(NodeServices.layer)),
)

routing.layer('ProviderServiceLive routing', (it) =>
{
  it.effect('persists the live continuation identity on an ordinary start', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
      const threadId = asThreadId('thread-ordinary-identity')

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })

      const binding = yield* directory.getBinding(threadId)
      assert.equal(Option.isSome(binding), true)
      if (Option.isSome(binding))
      {
        assert.deepEqual(
          (binding.value.runtimePayload as Record<string, unknown>).continuationIdentity,
          {
            driverKind: CODEX_DRIVER,
            continuationKey: `codex:instance:${codexInstanceId}`,
          },
        )
      }
      yield* provider.stopSession({ threadId })
    }),
  )

  it.effect('routes provider operations and rollback conversation', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      const session = yield* provider.startSession(asThreadId('thread-1'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-1'),
        cwd: '/tmp/project',
        runtimeMode: 'full-access',
      })
      assert.equal(session.provider, 'codex')

      const sessions = yield* provider.listSessions()
      assert.equal(sessions.length, 1)

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: 'hello',
        attachments: [],
      })
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1)

      yield* provider.interruptTurn({ threadId: session.threadId })
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]])

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId('req-1'),
        decision: 'accept',
      })
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId('req-1'), 'accept'],
      ])

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId('req-user-input-1'),
        answers: {
          sandbox_mode: 'workspace-write',
        },
      })
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId('req-user-input-1'),
          {
            sandbox_mode: 'workspace-write',
          },
        ],
      ])

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
        expectedProviderInstanceId: ProviderInstanceId.make('codex'),
      })

      yield* provider.stopSession({ threadId: session.threadId })
      routing.codex.startSession.mockClear()
      routing.codex.sendTurn.mockClear()

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: 'after-stop',
        attachments: [],
      })

      assert.equal(routing.codex.startSession.mock.calls.length, 1)
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0]
      assert.equal(typeof resumedStartInput === 'object' && resumedStartInput !== null, true)
      if (resumedStartInput && typeof resumedStartInput === 'object')
      {
        const startPayload = resumedStartInput as {
          provider?: string
          cwd?: string
          resumeCursor?: unknown
          threadId?: string
        }
        assert.equal(startPayload.provider, 'codex')
        assert.equal(startPayload.cwd, '/tmp/project')
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor)
        assert.equal(startPayload.threadId, session.threadId)
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1)
    }),
  )

  it.effect('propagates durable provider effect context without changing adapter behavior', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-provider-effect-context')
      const context = {
        actionId: 'provider-action-1',
        idempotencyKey: 'provider-action-1',
        sourceSequence: 42,
        operationVersion: 1,
      }

      yield* provider.startSession(
        threadId,
        {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: 'full-access',
        },
        undefined,
        context,
      )
      yield* provider.sendTurn(
        { threadId, input: 'context turn', attachments: [] },
        undefined,
        context,
      )
      yield* provider.interruptTurn({ threadId }, context)
      yield* provider.respondToRequest(
        { threadId, requestId: asRequestId('context-request'), decision: 'accept' },
        context,
      )
      yield* provider.respondToUserInput(
        {
          threadId,
          requestId: asRequestId('context-input'),
          answers: { sandbox_mode: 'workspace-write' },
        },
        context,
      )
      yield* provider.rollbackConversation(
        { threadId, numTurns: 1, expectedProviderInstanceId: ProviderInstanceId.make('codex') },
        context,
      )
      yield* provider.stopSession({ threadId }, context)

      assert.deepEqual(routing.codex.startSession.mock.calls.at(-1)?.[1], context)
      assert.deepEqual(routing.codex.sendTurn.mock.calls.at(-1)?.[1], context)
      assert.deepEqual(routing.codex.interruptTurn.mock.calls.at(-1)?.[2], context)
      assert.deepEqual(routing.codex.respondToRequest.mock.calls.at(-1)?.[3], context)
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls.at(-1)?.[3], context)
      assert.deepEqual(routing.codex.rollbackThread.mock.calls.at(-1)?.[2], context)
      assert.deepEqual(routing.codex.stopSession.mock.calls.at(-1)?.[1], context)
    }),
  )

  it.effect('delivers orchestrate mode instructions to non-Codex lead providers', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-claude-orchestrate')
      routing.claude.startSession.mockClear()
      routing.claude.sendTurn.mockClear()

      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      yield* provider.sendTurn({
        threadId,
        input: 'review every provider path',
        attachments: [],
        interactionMode: 'orchestrate',
      })

      const sent = routing.claude.sendTurn.mock.calls[0]?.[0]
      assert.equal(sent?.interactionMode, 'orchestrate')
      assert.equal(
        sent?.input,
        `${ORCHESTRATE_MODE_INSTRUCTIONS}\n\n<user_request>\nreview every provider path\n</user_request>`,
      )
      assert.match(sent?.input ?? '', /proposal_preview_upsert/)
      assert.match(sent?.input ?? '', /architecture_blast_radius/)
      assert.match(sent?.input ?? '', /orchestratePlan: \{ runId, revision \}/)
      assert.match(sent?.input ?? '', /same committed .*runId.* and .*revision/)
      assert.match(sent?.input ?? '', /non-empty decided edit set/)
      assert.match(sent?.input ?? '', /standing-project/)

      yield* provider.stopSession({ threadId })
      routing.claude.startSession.mockClear()
      routing.claude.sendTurn.mockClear()
    }),
  )

  it.effect('recovers stale persisted sessions for rollback by resuming thread identity', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      const initial = yield* provider.startSession(asThreadId('thread-1'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-1'),
        cwd: '/tmp/project',
        runtimeMode: 'full-access',
      })
      routing.codex.clearSession(initial.threadId)
      routing.codex.startSession.mockClear()
      routing.codex.rollbackThread.mockClear()

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
        expectedProviderInstanceId: ProviderInstanceId.make('codex'),
      })

      assert.equal(routing.codex.startSession.mock.calls.length, 1)
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0]
      assert.equal(typeof resumedStartInput === 'object' && resumedStartInput !== null, true)
      if (resumedStartInput && typeof resumedStartInput === 'object')
      {
        const startPayload = resumedStartInput as {
          provider?: string
          cwd?: string
          resumeCursor?: unknown
          threadId?: string
        }
        assert.equal(startPayload.provider, 'codex')
        assert.equal(startPayload.cwd, '/tmp/project')
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor)
        assert.equal(startPayload.threadId, initial.threadId)
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1)
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0]
      assert.equal(rollbackCall?.[1], 1)
    }),
  )

  it.effect('preserves the persisted binding when stopping a session', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository

      const initial = yield* provider.startSession(asThreadId('thread-reap-preserve'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-reap-preserve'),
        cwd: '/tmp/project-reap-preserve',
        runtimeMode: 'full-access',
      })

      yield* provider.stopSession({ threadId: initial.threadId })

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      })
      assert.equal(Option.isSome(persistedAfterStop), true)
      if (Option.isSome(persistedAfterStop))
      {
        assert.equal(persistedAfterStop.value.status, 'stopped')
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor)
      }

      routing.codex.startSession.mockClear()
      routing.codex.sendTurn.mockClear()

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: 'resume after reap',
        attachments: [],
      })

      assert.equal(routing.codex.startSession.mock.calls.length, 1)
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0]
      assert.equal(typeof resumedStartInput === 'object' && resumedStartInput !== null, true)
      if (resumedStartInput && typeof resumedStartInput === 'object')
      {
        const startPayload = resumedStartInput as {
          provider?: string
          cwd?: string
          resumeCursor?: unknown
          threadId?: string
        }
        assert.equal(startPayload.provider, 'codex')
        assert.equal(startPayload.cwd, '/tmp/project-reap-preserve')
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor)
        assert.equal(startPayload.threadId, initial.threadId)
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1)
    }),
  )

  it.effect('routes explicit claudeAgent provider session starts to the claude adapter', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      const session = yield* provider.startSession(asThreadId('thread-claude'), {
        provider: ProviderDriverKind.make('claudeAgent'),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId('thread-claude'),
        cwd: '/tmp/project-claude',
        runtimeMode: 'full-access',
      })

      assert.equal(session.provider, 'claudeAgent')
      assert.equal(routing.claude.startSession.mock.calls.length, 1)
      const startInput = routing.claude.startSession.mock.calls[0]?.[0]
      assert.equal(typeof startInput === 'object' && startInput !== null, true)
      if (startInput && typeof startInput === 'object')
      {
        const startPayload = startInput as {
          provider?: string
          providerInstanceId?: ProviderInstanceId
          cwd?: string
        }
        assert.equal(startPayload.provider, 'claudeAgent')
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId)
        assert.equal(startPayload.cwd, '/tmp/project-claude')
      }
    }),
  )

  it.effect('dies when an active session conflicts with its persisted binding', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
      const threadId = asThreadId('thread-binding-mismatch')

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: '/tmp/project-binding-mismatch',
        runtimeMode: 'full-access',
      })
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make('claudeAgent'),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: 'full-access',
      })

      const exit = yield* Effect.exit(provider.listSessions())
      assert.equal(Exit.hasDies(exit), true)
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        runtimeMode: 'full-access',
      })
    }),
  )

  it.effect('stops stale sessions in other providers after a successful replacement start', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-provider-replacement')

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: '/tmp/project-provider-replacement',
        runtimeMode: 'full-access',
      })

      routing.codex.stopSession.mockClear()
      routing.claude.stopSession.mockClear()

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make('claudeAgent'),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: '/tmp/project-provider-replacement',
        runtimeMode: 'full-access',
      })

      assert.equal(codexSession.provider, 'codex')
      assert.equal(claudeSession.provider, 'claudeAgent')
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]])
      assert.equal(routing.claude.stopSession.mock.calls.length, 0)

      const sessions = yield* provider.listSessions()
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ['claudeAgent'],
      )
    }),
  )

  it.effect('preserves the active generation when replacement route validation fails', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-invalid-provider-replacement')

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: '/tmp/project-invalid-provider-replacement',
        runtimeMode: 'full-access',
      })
      const activeIdentity = yield* provider.captureSessionIdentity({ threadId })
      assert.equal(Option.isSome(activeIdentity), true)

      routing.codex.stopSession.mockClear()
      const failure = yield* Effect.flip(
        provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          cwd: '/tmp/project-invalid-provider-replacement',
          runtimeMode: 'full-access',
        }),
      )

      assert.instanceOf(failure, ProviderValidationError)
      assert.include(failure.issue, "belongs to driver 'claudeAgent', not 'codex'")
      assert.equal(routing.codex.stopSession.mock.calls.length, 0)
      if (Option.isSome(activeIdentity))
      {
        assert.equal(yield* provider.matchesSessionIdentity(activeIdentity.value), true)
      }
      assert.equal(yield* routing.codex.hasSession(threadId), true)

      yield* provider.stopSession({ threadId })
    }),
  )

  it.effect('recovers stale sessions for sendTurn using persisted cwd', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      type RoutingAdapter = {
        readonly startSession: {
          readonly mockClear: () => void
          readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> }
        }
        readonly sendTurn: {
          readonly mockClear: () => void
          readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> }
        }
        readonly clearSessions: () => void
      }

      const recoverStaleSendTurn = (input: {
        readonly threadId: ThreadId
        readonly driver: ProviderDriverKind
        readonly providerInstanceId: typeof codexInstanceId
        readonly cwd: string
        readonly modelSelection?: ReturnType<typeof createModelSelection>
        readonly routing: RoutingAdapter
        readonly resumeInput: string
        readonly expectModelSelection?: ReturnType<typeof createModelSelection>
      }) =>
        Effect.gen(function* ()
        {
          const initial = yield* provider.startSession(input.threadId, {
            provider: input.driver,
            providerInstanceId: input.providerInstanceId,
            threadId: input.threadId,
            cwd: input.cwd,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            runtimeMode: 'full-access',
          })

          input.routing.clearSessions()
          input.routing.startSession.mockClear()
          input.routing.sendTurn.mockClear()

          yield* provider.sendTurn({
            threadId: initial.threadId,
            input: input.resumeInput,
            attachments: [],
          })

          assert.equal(input.routing.startSession.mock.calls.length, 1)
          const resumedStartInput = input.routing.startSession.mock.calls[0]?.[0]
          assert.equal(typeof resumedStartInput === 'object' && resumedStartInput !== null, true)
          if (resumedStartInput && typeof resumedStartInput === 'object')
          {
            const startPayload = resumedStartInput as {
              provider?: string
              cwd?: string
              modelSelection?: unknown
              resumeCursor?: unknown
              threadId?: string
            }
            assert.equal(startPayload.provider, input.driver)
            assert.equal(startPayload.cwd, input.cwd)
            if (input.expectModelSelection !== undefined)
            {
              assert.deepEqual(startPayload.modelSelection, input.expectModelSelection)
            }
            assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor)
            assert.equal(startPayload.threadId, initial.threadId)
          }
          assert.equal(input.routing.sendTurn.mock.calls.length, 1)
        })

      const claudeModelSelection = createModelSelection(
        ProviderInstanceId.make('claudeAgent'),
        'claude-opus-4-6',
        [{ id: 'effort', value: 'max' }],
      )

      yield* recoverStaleSendTurn({
        threadId: asThreadId('thread-1'),
        driver: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        cwd: '/tmp/project-send-turn',
        routing: routing.codex,
        resumeInput: 'resume',
      })

      yield* recoverStaleSendTurn({
        threadId: asThreadId('thread-claude-send-turn'),
        driver: ProviderDriverKind.make('claudeAgent'),
        providerInstanceId: claudeAgentInstanceId,
        cwd: '/tmp/project-claude-send-turn',
        modelSelection: claudeModelSelection,
        routing: routing.claude,
        resumeInput: 'resume with claude',
        expectModelSelection: claudeModelSelection,
      })
    }),
  )

  it.effect('lazily recovers exact imported Codex and Claude bindings on first send', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
      const codexThreadId = asThreadId('thread-imported-codex-lazy')
      const claudeThreadId = asThreadId('thread-imported-claude-lazy')
      const codexResumeCursor = { threadId: 'native-codex-session' }
      const claudeResumeCursor = {
        threadId: claudeThreadId,
        resume: '550e8400-e29b-41d4-a716-446655440000',
      }
      const codexModelSelection = {
        instanceId: codexInstanceId,
        model: 'gpt-5.4',
      }
      const claudeModelSelection = {
        instanceId: claudeAgentInstanceId,
        model: 'claude-opus-4-6',
      }

      routing.codex.startSession.mockClear()
      routing.codex.sendTurn.mockClear()
      routing.claude.startSession.mockClear()
      routing.claude.sendTurn.mockClear()

      yield* directory.upsert({
        threadId: codexThreadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        adapterKey: CODEX_DRIVER,
        status: 'stopped',
        resumeCursor: codexResumeCursor,
        runtimePayload: {
          cwd: '/tmp/imported-codex',
          modelSelection: codexModelSelection,
        },
        runtimeMode: 'approval-required',
      })
      yield* directory.upsert({
        threadId: claudeThreadId,
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        adapterKey: CLAUDE_AGENT_DRIVER,
        status: 'stopped',
        resumeCursor: claudeResumeCursor,
        runtimePayload: {
          cwd: '/tmp/imported-claude',
          modelSelection: claudeModelSelection,
        },
        runtimeMode: 'approval-required',
      })

      assert.equal(yield* routing.codex.hasSession(codexThreadId), false)
      assert.equal(yield* routing.claude.hasSession(claudeThreadId), false)
      assert.equal(routing.codex.startSession.mock.calls.length, 0)
      assert.equal(routing.claude.startSession.mock.calls.length, 0)

      yield* provider.sendTurn({
        threadId: codexThreadId,
        input: 'continue codex',
        attachments: [],
      })
      yield* provider.sendTurn({
        threadId: claudeThreadId,
        input: 'continue claude',
        attachments: [],
      })

      assert.deepEqual(routing.codex.startSession.mock.calls[0]?.[0], {
        threadId: codexThreadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        cwd: '/tmp/imported-codex',
        modelSelection: codexModelSelection,
        resumeCursor: codexResumeCursor,
        runtimeMode: 'approval-required',
        runtimeSessionBinding: {
          providerInstanceId: codexInstanceId,
          threadId: codexThreadId,
          sessionGeneration: 1,
        },
      })
      assert.deepEqual(routing.claude.startSession.mock.calls[0]?.[0], {
        threadId: claudeThreadId,
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        cwd: '/tmp/imported-claude',
        modelSelection: claudeModelSelection,
        resumeCursor: claudeResumeCursor,
        runtimeMode: 'approval-required',
        runtimeSessionBinding: {
          providerInstanceId: claudeAgentInstanceId,
          threadId: claudeThreadId,
          sessionGeneration: 1,
        },
      })
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1)
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1)
    }),
  )

  it.effect('lists no sessions after adapter runtime clears', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      yield* provider.startSession(asThreadId('thread-1'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-1'),
        runtimeMode: 'full-access',
      })
      yield* provider.startSession(asThreadId('thread-2'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-2'),
        runtimeMode: 'full-access',
      })

      routing.codex.clearSessions()
      routing.claude.clearSessions()

      const remaining = yield* provider.listSessions()
      assert.equal(remaining.length, 0)
    }),
  )

  it.effect('persists runtime status transitions in provider_session_runtime', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository

      const threadId = asThreadId('thread-runtime-status')
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: 'hello',
        attachments: [],
      })

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      })
      assert.equal(Option.isSome(runningRuntime), true)
      if (Option.isSome(runningRuntime))
      {
        assert.equal(runningRuntime.value.status, 'running')
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor)
        const payload = runningRuntime.value.runtimePayload
        assert.equal(payload !== null && typeof payload === 'object', true)
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload))
        {
          const runtimePayload = payload as {
            cwd: string
            model: string | null
            activeTurnId: string | null
            lastError: string | null
            lastRuntimeEvent: string | null
          }
          assert.equal(runtimePayload.cwd, session.cwd)
          assert.equal(runtimePayload.model, null)
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`)
          assert.equal(runtimePayload.lastError, null)
          assert.equal(runtimePayload.lastRuntimeEvent, 'provider.sendTurn')
        }
      }
    }),
  )

  it.effect('reuses persisted resume cursor when startSession is called after a restart', () =>
    Effect.gen(function* ()
    {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-provider-service-start-'),
      )
      const dbPath = NodePath.join(tempDir, 'orchestration.sqlite')
      const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
        Layer.provideMerge(makeTestServerStorageLeaseLayer(tempDir)),
      )
      const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
        Layer.provide(persistenceLayer),
      )

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make('claudeAgent')]: firstClaude.adapter,
      })
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const firstProviderLayer = makeProviderServiceTestLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsServiceLayers.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      )

      const initial = yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        return yield* provider.startSession(asThreadId('thread-claude-start'), {
          provider: ProviderDriverKind.make('claudeAgent'),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId('thread-claude-start'),
          cwd: '/tmp/project-claude-start',
          runtimeMode: 'full-access',
        })
      }).pipe(Effect.provide(firstProviderLayer))

      yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        yield* provider.listSessions()
      }).pipe(Effect.provide(firstProviderLayer))

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make('claudeAgent')]: secondClaude.adapter,
      })
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const secondProviderLayer = makeProviderServiceTestLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsServiceLayers.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      )

      secondClaude.startSession.mockClear()

      yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make('claudeAgent'),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: '/tmp/project-claude-start',
          runtimeMode: 'full-access',
        })
      }).pipe(Effect.provide(secondProviderLayer))

      assert.equal(secondClaude.startSession.mock.calls.length, 1)
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0]
      assert.equal(typeof resumedStartInput === 'object' && resumedStartInput !== null, true)
      if (resumedStartInput && typeof resumedStartInput === 'object')
      {
        const startPayload = resumedStartInput as {
          provider?: string
          cwd?: string
          resumeCursor?: unknown
          threadId?: string
        }
        assert.equal(startPayload.provider, 'claudeAgent')
        assert.equal(startPayload.cwd, '/tmp/project-claude-start')
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor)
        assert.equal(startPayload.threadId, initial.threadId)
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true })
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect(
    'reuses persisted cwd when startSession resumes a claude session without cwd input',
    () =>
      Effect.gen(function* ()
      {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), 't3-provider-service-cwd-'),
        )
        const dbPath = NodePath.join(tempDir, 'orchestration.sqlite')
        const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
          Layer.provideMerge(makeTestServerStorageLeaseLayer(tempDir)),
        )
        const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
          Layer.provide(persistenceLayer),
        )

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make('claudeAgent')]: firstClaude.adapter,
        })
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        )
        const firstProviderLayer = makeProviderServiceTestLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsServiceLayers.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        )

        const initial = yield* Effect.gen(function* ()
        {
          const provider = yield* ProviderService.ProviderService
          return yield* provider.startSession(asThreadId('thread-claude-cwd'), {
            provider: ProviderDriverKind.make('claudeAgent'),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId('thread-claude-cwd'),
            cwd: '/tmp/project-claude-cwd',
            runtimeMode: 'full-access',
          })
        }).pipe(Effect.provide(firstProviderLayer))

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make('claudeAgent')]: secondClaude.adapter,
        })
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        )
        const secondProviderLayer = makeProviderServiceTestLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsServiceLayers.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        )

        secondClaude.startSession.mockClear()

        yield* Effect.gen(function* ()
        {
          const provider = yield* ProviderService.ProviderService
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make('claudeAgent'),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: 'full-access',
          })
        }).pipe(Effect.provide(secondProviderLayer))

        assert.equal(secondClaude.startSession.mock.calls.length, 1)
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0]
        assert.equal(typeof resumedStartInput === 'object' && resumedStartInput !== null, true)
        if (resumedStartInput && typeof resumedStartInput === 'object')
        {
          const startPayload = resumedStartInput as {
            provider?: string
            cwd?: string
            resumeCursor?: unknown
            threadId?: string
          }
          assert.equal(startPayload.provider, 'claudeAgent')
          assert.equal(startPayload.cwd, '/tmp/project-claude-cwd')
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor)
          assert.equal(startPayload.threadId, initial.threadId)
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true })
      }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('captures the current logical generation with its immutable creation time', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-provider-identity-cutoff')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })

      const captured = yield* provider.captureSessionIdentity({ threadId })
      assert.equal(Option.isSome(captured), true)
      if (Option.isNone(captured)) return

      const recaptured = yield* provider.captureSessionIdentity({ threadId })
      const wrongInstance = yield* provider.captureSessionIdentity({
        threadId,
        expectedProviderInstanceId: claudeAgentInstanceId,
      })

      assert.deepEqual(recaptured, captured)
      assert.equal(Option.isNone(wrongInstance), true)
      yield* provider.stopSessionIfExact(captured.value)
    }),
  )

  it.effect('rotates explicit starts and stops only the exact current generation', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-provider-exact-generation')
      const first = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      const firstIdentity = yield* provider.captureSessionIdentity({ threadId })
      assert.equal(Option.isSome(firstIdentity), true)
      if (Option.isNone(firstIdentity)) return

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        resumeCursor: first.resumeCursor,
        runtimeMode: 'full-access',
      })
      const replacementIdentity = yield* provider.captureSessionIdentity({ threadId })
      assert.equal(Option.isSome(replacementIdentity), true)
      if (Option.isNone(replacementIdentity)) return

      assert.equal(
        replacementIdentity.value.sessionGeneration > firstIdentity.value.sessionGeneration,
        true,
      )
      assert.equal(yield* provider.stopSessionIfExact(firstIdentity.value), false)
      assert.equal(yield* provider.matchesSessionIdentity(replacementIdentity.value), true)
      assert.equal(yield* provider.stopSessionIfExact(replacementIdentity.value), true)
      assert.equal(yield* provider.matchesSessionIdentity(replacementIdentity.value), false)
    }),
  )

  it.effect('durably closes an exact open generation after its adapter disappears', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-provider-exact-inactive')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      const identity = yield* provider.captureSessionIdentity({ threadId })
      assert.equal(Option.isSome(identity), true)
      if (Option.isNone(identity)) return

      routing.codex.clearSession(threadId)
      routing.codex.stopSession.mockClear()

      assert.equal(yield* provider.stopSessionIfExact(identity.value), true)
      assert.equal(routing.codex.stopSession.mock.calls.length, 0)
      assert.equal(yield* provider.matchesSessionIdentity(identity.value), false)
    }),
  )

  it.effect('durably closes every active generation before layer shutdown', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const shutdown = yield* Effect.forkChild(provider.shutdown)
      yield* advanceTestClock(10_000)
      assert.equal((yield* Fiber.join(shutdown)) >= 0, true)
    }),
  )
})

it.effect('shares accepted background-task liveness with the exact session reaper', () =>
  Effect.gen(function* ()
  {
    const taskStartedEventId = asEventId('evt-background-task-accepted-once')
    const taskCompletedEventId = asEventId('evt-background-task-completed')
    const taskId = RuntimeTaskId.make('task-background-reaper-integration')
    const taskStartedAppendEntered = yield* Deferred.make<void>()
    const releaseTaskStartedAppend = yield* Deferred.make<void>()
    const duplicateTaskStartedObserved = yield* Deferred.make<void>()
    const reaperReadDirectoryBinding = yield* Deferred.make<void>()
    const codex = makeFakeCodexAdapter()
    const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter })
    let taskStartedAppendCount = 0
    let reaperStarted = false

    const runtimeInboxLayer = Layer.effect(
      ProviderRuntimeInbox,
      Effect.gen(function* ()
      {
        const inbox = yield* ProviderRuntimeInbox
        return ProviderRuntimeInbox.of({
          ...inbox,
          append: (input) =>
            Effect.gen(function* ()
            {
              if (input.sourceEventId === taskStartedEventId)
              {
                taskStartedAppendCount += 1
                if (taskStartedAppendCount === 1)
                {
                  yield* Deferred.succeed(taskStartedAppendEntered, undefined)
                  yield* Deferred.await(releaseTaskStartedAppend)
                }
              }

              const result = yield* inbox.append(input)
              if (input.sourceEventId === taskStartedEventId && result.duplicate)
              {
                yield* Deferred.succeed(duplicateTaskStartedObserved, undefined)
              }
              return result
            }),
        })
      }),
    ).pipe(Layer.provide(Layer.fresh(providerRuntimeInboxMemoryLive)))

    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const lifecycleLayer = Layer.merge(
      ThreadArchiveLifecyclePermitLive,
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () =>
          Effect.sync(() => reaperStarted).pipe(
            Effect.flatMap((started) =>
              started
                ? Deferred.succeed(reaperReadDirectoryBinding, undefined).pipe(
                    Effect.as(Option.some(null as never)),
                  )
                : Effect.succeed(Option.some(null as never)),
            ),
          ),
        getThreadDetailById: () => Effect.succeed(Option.some({ orchestratePlans: [] } as never)),
      }),
    )
    const backgroundTasksLayer = Layer.fresh(ProviderBackgroundTaskRegistryLive)
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(runtimeInboxLayer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(McpSessionRegistry.disabledLayer),
      Layer.provide(AnalyticsServiceLayers.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provideMerge(directoryLayer),
      Layer.provideMerge(lifecycleLayer),
      Layer.provideMerge(backgroundTasksLayer),
      Layer.provideMerge(NodeServices.layer),
    )
    const integratedLayer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1,
      sweepIntervalMs: 60_000,
    }).pipe(Layer.provideMerge(providerLayer))

    yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        const backgroundTasks = yield* ProviderBackgroundTaskRegistry
        const reaper = yield* ProviderSessionReaper
        const threadId = asThreadId('thread-background-reaper-integration')
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: 'full-access',
        })
        const captured = yield* provider.captureSessionIdentity({ threadId })
        assert.equal(Option.isSome(captured), true)
        if (Option.isNone(captured)) return
        const identity = captured.value

        const taskStarted: LegacyProviderRuntimeEvent = {
          type: 'task.started',
          eventId: taskStartedEventId,
          provider: CODEX_DRIVER,
          createdAt: '2026-01-01T00:00:00.000Z',
          threadId,
          payload: { taskId },
        }
        const taskStartedPublished = yield* Stream.take(provider.streamEvents, 1).pipe(
          Stream.runDrain,
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        yield* codex.emitEffect(taskStarted)
        yield* Deferred.await(taskStartedAppendEntered)
        assert.equal(yield* backgroundTasks.hasLiveTasks(identity), false)

        yield* Deferred.succeed(releaseTaskStartedAppend, undefined)
        yield* Fiber.join(taskStartedPublished)
        assert.equal(yield* backgroundTasks.hasLiveTasks(identity), true)

        yield* advanceTestClock(10)
        reaperStarted = true
        yield* reaper.start()
        yield* Deferred.await(reaperReadDirectoryBinding)
        yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
          discard: true,
        })
        assert.equal(codex.stopSession.mock.calls.length, 0)
        assert.equal(yield* provider.matchesSessionIdentity(identity), true)

        const taskCompletedPublished = yield* Stream.take(provider.streamEvents, 1).pipe(
          Stream.runDrain,
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        yield* codex.emitEffect({
          type: 'task.completed',
          eventId: taskCompletedEventId,
          provider: CODEX_DRIVER,
          createdAt: '2026-01-01T00:00:01.000Z',
          threadId,
          payload: {
            taskId,
            status: 'completed',
          },
        })
        yield* Fiber.join(taskCompletedPublished)
        assert.equal(yield* backgroundTasks.hasLiveTasks(identity), false)

        yield* codex.emitEffect(taskStarted)
        yield* Deferred.await(duplicateTaskStartedObserved)
        assert.equal(yield* backgroundTasks.hasLiveTasks(identity), false)

        const sessionExitedPublished = yield* provider.streamEvents.pipe(
          Stream.filter((event) => event.type === 'session.exited'),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        yield* reaper.start()
        yield* Fiber.join(sessionExitedPublished)

        assert.equal(codex.stopSession.mock.calls.length, 1)
        assert.equal(yield* provider.matchesSessionIdentity(identity), false)
        assert.equal(yield* backgroundTasks.hasLiveTasks(identity), false)
      }).pipe(Effect.provide(integratedLayer)),
    )
  }).pipe(Effect.provide(NodeServices.layer)),
)

const fanout = makeProviderServiceLayer()
fanout.layer('ProviderServiceLive fanout', (it) =>
{
  it.effect('fans out adapter turn completion events', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const session = yield* provider.startSession(asThreadId('thread-1'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-1'),
        runtimeMode: 'full-access',
      })

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([])
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild)
      yield* advanceTestClock(50)

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: 'turn.completed',
        eventId: asEventId('evt-1'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        threadId: session.threadId,
        turnId: asTurnId('turn-1'),
        status: 'completed',
      }

      fanout.codex.emit(completedEvent)
      yield* advanceTestClock(50)

      const events = yield* Ref.get(eventsRef)
      yield* Fiber.interrupt(consumer)

      assert.equal(
        events.some((entry) => entry.type === 'turn.completed'),
        true,
      )
      assert.equal(
        events.some(
          (entry) =>
            entry.type === 'turn.completed' && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      )
    }),
  )

  it.effect('refreshes lastSeenAt on turn.completed and session ready', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory
      const threadId = asThreadId('thread-last-seen')
      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })

      const initialBinding = yield* directory.getBinding(threadId)
      assert.equal(Option.isSome(initialBinding), true)
      if (Option.isNone(initialBinding)) return
      const initialLastSeenAt = initialBinding.value.lastSeenAt

      const turnCompleted = yield* provider.streamEvents.pipe(
        Stream.filter((event) => event.type === 'turn.completed'),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      )
      yield* advanceTestClock(1_000)
      fanout.codex.emit({
        type: 'turn.completed',
        eventId: asEventId('evt-last-seen-turn'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:01.000Z',
        threadId,
        turnId: asTurnId('turn-last-seen'),
        status: 'completed',
      })
      yield* Fiber.join(turnCompleted)

      const afterTurn = yield* directory.getBinding(threadId)
      assert.equal(Option.isSome(afterTurn), true)
      if (Option.isNone(afterTurn)) return
      const afterTurnLastSeenAt = afterTurn.value.lastSeenAt
      assert.notEqual(afterTurnLastSeenAt, initialLastSeenAt)

      const sessionReady = yield* provider.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === 'session.state.changed' && event.payload.state === 'ready',
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      )
      yield* advanceTestClock(1_000)
      fanout.codex.emit({
        type: 'session.state.changed',
        eventId: asEventId('evt-last-seen-ready'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:02.000Z',
        threadId,
        payload: { state: 'ready' },
      })
      yield* Fiber.join(sessionReady)

      const afterReady = yield* directory.getBinding(threadId)
      assert.equal(Option.isSome(afterReady), true)
      if (Option.isNone(afterReady)) return
      assert.notEqual(afterReady.value.lastSeenAt, afterTurnLastSeenAt)
    }),
  )

  it.effect('fans out canonical runtime events in emission order', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const session = yield* provider.startSession(asThreadId('thread-seq'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-seq'),
        runtimeMode: 'full-access',
      })

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([])
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      )
      yield* advanceTestClock(50)

      fanout.codex.emit({
        type: 'tool.started',
        eventId: asEventId('evt-seq-1'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        threadId: session.threadId,
        turnId: asTurnId('turn-1'),
        toolKind: 'command',
        title: 'Ran command',
      })
      fanout.codex.emit({
        type: 'tool.completed',
        eventId: asEventId('evt-seq-2'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        threadId: session.threadId,
        turnId: asTurnId('turn-1'),
        toolKind: 'command',
        title: 'Ran command',
      })
      fanout.codex.emit({
        type: 'turn.completed',
        eventId: asEventId('evt-seq-3'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: '2026-01-01T00:00:00.000Z',
        threadId: session.threadId,
        turnId: asTurnId('turn-1'),
        status: 'completed',
      })

      yield* Fiber.join(consumer)
      const received = yield* Ref.get(receivedRef)
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId('evt-seq-1'), asEventId('evt-seq-2'), asEventId('evt-seq-3')],
      )
    }),
  )

  it.effect('quarantines an adapter after a durable source-event collision', () =>
    Effect.gen(function* ()
    {
      const admissionFailed = yield* Deferred.make<ProviderRuntimeInboxAdmissionError>()
      const quarantineStopped = yield* Deferred.make<void>()
      const codex = makeFakeCodexAdapter()
      codex.stopAll.mockImplementationOnce(() =>
        Effect.sync(() => codex.clearSessions()).pipe(
          Effect.andThen(Deferred.succeed(quarantineStopped, undefined)),
          Effect.asVoid,
        ),
      )
      const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter })
      const providerLayer = makeProviderServiceTestLayer(
        registry,
        providerThreadLifecycleTestLayer,
        observeProviderRuntimeAdmissionLayer(admissionFailed),
      )

      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const provider = yield* ProviderService.ProviderService
          const threadId = asThreadId('thread-admission-collision')
          yield* provider.startSession(threadId, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            runtimeMode: 'full-access',
          })
          codex.sendTurn.mockClear()
          const firstObserved = yield* Stream.take(provider.streamEvents, 1).pipe(
            Stream.runDrain,
            Effect.forkChild,
          )
          yield* Effect.yieldNow

          yield* codex.emitEffect({
            type: 'tool.completed',
            eventId: asEventId('evt-admission-collision'),
            provider: CODEX_DRIVER,
            createdAt: '2026-01-01T00:00:00.000Z',
            threadId,
            turnId: asTurnId('turn-admission-collision'),
            toolKind: 'command',
            title: 'first canonical body',
          })
          yield* Fiber.join(firstObserved)
          yield* codex.emitEffect({
            type: 'tool.completed',
            eventId: asEventId('evt-admission-collision'),
            provider: CODEX_DRIVER,
            createdAt: '2026-01-01T00:00:00.000Z',
            threadId,
            turnId: asTurnId('turn-admission-collision'),
            toolKind: 'command',
            title: 'changed canonical body',
          })

          assert.equal((yield* Deferred.await(admissionFailed)).reason, 'event-collision')
          yield* Deferred.await(quarantineStopped)
          const health = yield* Effect.result(provider.getCapabilities(codexInstanceId))
          assert.equal(health._tag, 'Failure')
          if (health._tag === 'Failure') assert.match(health.failure.message, /quarantined/)

          const send = yield* Effect.result(
            provider.sendTurn({
              threadId,
              input: 'must not route after quarantine',
              interactionMode: 'default',
            }),
          )
          assert.equal(send._tag, 'Failure')
          if (send._tag === 'Failure') assert.match(send.failure.message, /quarantined/)
          assert.equal(codex.sendTurn.mock.calls.length, 0)
          assert.equal(codex.stopAll.mock.calls.length, 1)
        }).pipe(Effect.provide(providerLayer)),
      )
    }),
  )

  it.effect('quarantines an adapter that emits after its durable session terminal', () =>
    Effect.gen(function* ()
    {
      const admissionFailed = yield* Deferred.make<ProviderRuntimeInboxAdmissionError>()
      const quarantineStopped = yield* Deferred.make<void>()
      const codex = makeFakeCodexAdapter()
      codex.stopAll.mockImplementationOnce(() =>
        Effect.sync(() => codex.clearSessions()).pipe(
          Effect.andThen(Deferred.succeed(quarantineStopped, undefined)),
          Effect.asVoid,
        ),
      )
      const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter })
      const providerLayer = makeProviderServiceTestLayer(
        registry,
        providerThreadLifecycleTestLayer,
        observeProviderRuntimeAdmissionLayer(admissionFailed),
      )

      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const provider = yield* ProviderService.ProviderService
          const threadId = asThreadId('thread-admission-after-terminal')
          yield* provider.startSession(threadId, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            runtimeMode: 'full-access',
          })
          codex.sendTurn.mockClear()
          const terminalObserved = yield* Stream.take(provider.streamEvents, 1).pipe(
            Stream.runDrain,
            Effect.forkChild,
          )
          yield* Effect.yieldNow

          yield* codex.emitEffect({
            type: 'session.exited',
            eventId: asEventId('evt-admission-terminal'),
            provider: CODEX_DRIVER,
            createdAt: '2026-01-01T00:00:00.000Z',
            threadId,
            payload: {
              reason: 'provider claimed terminal',
              recoverable: false,
              exitKind: 'graceful',
            },
          })
          yield* Fiber.join(terminalObserved)
          yield* codex.emitEffect({
            type: 'tool.completed',
            eventId: asEventId('evt-admission-after-terminal'),
            provider: CODEX_DRIVER,
            createdAt: '2026-01-01T00:00:01.000Z',
            threadId,
            turnId: asTurnId('turn-admission-after-terminal'),
            toolKind: 'command',
            title: 'late output',
          })

          assert.equal((yield* Deferred.await(admissionFailed)).reason, 'session-closed')
          yield* Deferred.await(quarantineStopped)
          const send = yield* Effect.result(
            provider.sendTurn({
              threadId,
              input: 'must not recover a quarantined route',
              interactionMode: 'default',
            }),
          )
          assert.equal(send._tag, 'Failure')
          if (send._tag === 'Failure') assert.match(send.failure.message, /quarantined/)
          assert.equal(codex.sendTurn.mock.calls.length, 0)
          assert.equal(codex.stopAll.mock.calls.length, 1)
        }).pipe(Effect.provide(providerLayer)),
      )
    }),
  )

  it.effect('keeps a rebuilt adapter fenced until prior quarantine cleanup completes', () =>
    Effect.gen(function* ()
    {
      const admissionFailed = yield* Deferred.make<ProviderRuntimeInboxAdmissionError>()
      const cleanupAttempted = yield* Deferred.make<void>()
      const cleanupSucceeded = yield* Deferred.make<void>()
      const replacementSubscribed = yield* Deferred.make<void>()
      const allowCleanup = yield* Ref.make(false)
      const oldCodex = makeFakeCodexAdapter()
      oldCodex.stopAll.mockImplementation(() =>
        Ref.get(allowCleanup).pipe(
          Effect.flatMap((allowed) =>
            allowed
              ? Effect.sync(() => oldCodex.clearSessions()).pipe(
                  Effect.andThen(Deferred.succeed(cleanupSucceeded, undefined)),
                  Effect.asVoid,
                )
              : Deferred.succeed(cleanupAttempted, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: String(CODEX_DRIVER),
                        method: 'stopAll',
                        detail: 'simulated quarantine cleanup failure',
                      }),
                    ),
                  ),
                ),
          ),
        ),
      )
      const replacementCodex = makeFakeCodexAdapter()
      const replacementAdapter: ProviderAdapterShape<ProviderAdapterError> = {
        ...replacementCodex.adapter,
        streamEvents: Stream.unwrap(
          Deferred.succeed(replacementSubscribed, undefined).pipe(
            Effect.as(replacementCodex.adapter.streamEvents),
          ),
        ),
      }
      const currentAdapter = yield* Ref.make(oldCodex.adapter)
      const changes = yield* PubSub.unbounded<void>()
      const getRoute: ProviderAdapterRegistry.ProviderAdapterRegistry['Service']['getRoute'] = (
        instanceId,
      ) =>
        instanceId === codexInstanceId
          ? Ref.get(currentAdapter).pipe(
              Effect.map((adapter) => ({
                info: {
                  instanceId: codexInstanceId,
                  driverKind: CODEX_DRIVER,
                  displayName: undefined,
                  enabled: true,
                  continuationIdentity: {
                    driverKind: CODEX_DRIVER,
                    continuationKey: `codex:instance:${codexInstanceId}`,
                  },
                },
                adapter,
              })),
            )
          : Effect.fail(
              new ProviderUnsupportedError({ provider: ProviderDriverKind.make(instanceId) }),
            )
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
        getRoute,
        getByInstance: (instanceId) =>
          getRoute(instanceId).pipe(Effect.map((route) => route.adapter)),
        getInstanceInfo: (instanceId) =>
          getRoute(instanceId).pipe(Effect.map((route) => route.info)),
        listInstances: () => Effect.succeed([codexInstanceId]),
        listProviders: () => Effect.succeed([CODEX_DRIVER]),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes),
      }
      const providerLayer = makeProviderServiceTestLayer(
        registry,
        providerThreadLifecycleTestLayer,
        observeProviderRuntimeAdmissionLayer(admissionFailed),
      )

      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const provider = yield* ProviderService.ProviderService
          const threadId = asThreadId('thread-quarantine-replacement')
          yield* provider.startSession(threadId, {
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            threadId,
            runtimeMode: 'full-access',
          })
          const firstObserved = yield* Stream.take(provider.streamEvents, 1).pipe(
            Stream.runDrain,
            Effect.forkChild,
          )
          yield* Effect.yieldNow
          yield* oldCodex.emitEffect({
            type: 'tool.completed',
            eventId: asEventId('evt-quarantine-replacement'),
            provider: CODEX_DRIVER,
            createdAt: '2026-01-01T00:00:00.000Z',
            threadId,
            turnId: asTurnId('turn-quarantine-replacement'),
            toolKind: 'command',
            title: 'first body',
          })
          yield* Fiber.join(firstObserved)
          yield* oldCodex.emitEffect({
            type: 'tool.completed',
            eventId: asEventId('evt-quarantine-replacement'),
            provider: CODEX_DRIVER,
            createdAt: '2026-01-01T00:00:00.000Z',
            threadId,
            turnId: asTurnId('turn-quarantine-replacement'),
            toolKind: 'command',
            title: 'changed body',
          })
          assert.equal((yield* Deferred.await(admissionFailed)).reason, 'event-collision')
          yield* Deferred.await(cleanupAttempted)

          yield* Ref.set(currentAdapter, replacementAdapter)
          yield* PubSub.publish(changes, undefined)
          const fenced = yield* Effect.result(provider.getCapabilities(codexInstanceId))
          assert.equal(fenced._tag, 'Failure')
          replacementCodex.startSession.mockClear()
          const blockedStart = yield* Effect.result(
            provider.startSession(threadId, {
              provider: CODEX_DRIVER,
              providerInstanceId: codexInstanceId,
              threadId,
              runtimeMode: 'full-access',
            }),
          )
          assert.equal(blockedStart._tag, 'Failure')
          assert.equal(replacementCodex.startSession.mock.calls.length, 0)

          yield* Ref.set(allowCleanup, true)
          yield* Effect.yieldNow
          yield* PubSub.publish(changes, undefined)
          yield* Deferred.await(cleanupSucceeded)
          yield* Deferred.await(replacementSubscribed)
          yield* Effect.yieldNow

          const healthy = yield* Effect.result(provider.getCapabilities(codexInstanceId))
          assert.equal(healthy._tag, 'Success')
        }).pipe(Effect.provide(providerLayer)),
      )
    }),
  )

  it.effect(
    'subscribes a replacement when cleanup completes before its atomic reconciliation claim',
    () =>
      Effect.gen(function* ()
      {
        const admissionFailed = yield* Deferred.make<ProviderRuntimeInboxAdmissionError>()
        const cleanupStarted = yield* Deferred.make<void>()
        const allowCleanup = yield* Deferred.make<void>()
        const cleanupReturned = yield* Deferred.make<void>()
        const replacementLookupPaused = yield* Deferred.make<void>()
        const allowReplacementLookup = yield* Deferred.make<void>()
        const replacementSubscribed = yield* Deferred.make<void>()
        const pauseReplacementLookup = yield* Ref.make(false)
        const oldCodex = makeFakeCodexAdapter()
        oldCodex.stopAll.mockImplementationOnce(() =>
          Deferred.succeed(cleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowCleanup)),
            Effect.andThen(Effect.sync(() => oldCodex.clearSessions())),
            Effect.andThen(Deferred.succeed(cleanupReturned, undefined)),
            Effect.asVoid,
          ),
        )
        const replacementCodex = makeFakeCodexAdapter()
        const replacementAdapter: ProviderAdapterShape<ProviderAdapterError> = {
          ...replacementCodex.adapter,
          streamEvents: Stream.unwrap(
            Deferred.succeed(replacementSubscribed, undefined).pipe(
              Effect.as(replacementCodex.adapter.streamEvents),
            ),
          ),
        }
        const currentAdapter = yield* Ref.make(oldCodex.adapter)
        const changes = yield* PubSub.unbounded<void>()
        const getRoute: ProviderAdapterRegistry.ProviderAdapterRegistry['Service']['getRoute'] = (
          instanceId,
        ) =>
          instanceId === codexInstanceId
            ? Ref.get(currentAdapter).pipe(
                Effect.map((adapter) => ({
                  info: {
                    instanceId: codexInstanceId,
                    driverKind: CODEX_DRIVER,
                    displayName: undefined,
                    enabled: true,
                    continuationIdentity: {
                      driverKind: CODEX_DRIVER,
                      continuationKey: `codex:instance:${codexInstanceId}`,
                    },
                  },
                  adapter,
                })),
              )
            : Effect.fail(
                new ProviderUnsupportedError({ provider: ProviderDriverKind.make(instanceId) }),
              )
        const registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'] = {
          getRoute,
          getByInstance: (instanceId) =>
            getRoute(instanceId).pipe(
              Effect.flatMap((route) =>
                Ref.get(pauseReplacementLookup).pipe(
                  Effect.flatMap((shouldPause) =>
                    shouldPause && route.adapter === replacementAdapter
                      ? Deferred.succeed(replacementLookupPaused, undefined).pipe(
                          Effect.andThen(Deferred.await(allowReplacementLookup)),
                          Effect.as(route.adapter),
                        )
                      : Effect.succeed(route.adapter),
                  ),
                ),
              ),
            ),
          getInstanceInfo: (instanceId) =>
            getRoute(instanceId).pipe(Effect.map((route) => route.info)),
          listInstances: () => Effect.succeed([codexInstanceId]),
          listProviders: () => Effect.succeed([CODEX_DRIVER]),
          streamChanges: Stream.fromPubSub(changes),
          subscribeChanges: PubSub.subscribe(changes),
        }
        const providerLayer = makeProviderServiceTestLayer(
          registry,
          providerThreadLifecycleTestLayer,
          observeProviderRuntimeAdmissionLayer(admissionFailed),
        )

        yield* Effect.scoped(
          Effect.gen(function* ()
          {
            const provider = yield* ProviderService.ProviderService
            const threadId = asThreadId('thread-quarantine-completion-race')
            yield* provider.startSession(threadId, {
              provider: CODEX_DRIVER,
              providerInstanceId: codexInstanceId,
              threadId,
              runtimeMode: 'full-access',
            })
            const firstObserved = yield* Stream.take(provider.streamEvents, 1).pipe(
              Stream.runDrain,
              Effect.forkChild,
            )
            yield* Effect.yieldNow
            yield* oldCodex.emitEffect({
              type: 'tool.completed',
              eventId: asEventId('evt-quarantine-completion-race'),
              provider: CODEX_DRIVER,
              createdAt: '2026-01-01T00:00:00.000Z',
              threadId,
              turnId: asTurnId('turn-quarantine-completion-race'),
              toolKind: 'command',
              title: 'first body',
            })
            yield* Fiber.join(firstObserved)
            yield* oldCodex.emitEffect({
              type: 'tool.completed',
              eventId: asEventId('evt-quarantine-completion-race'),
              provider: CODEX_DRIVER,
              createdAt: '2026-01-01T00:00:00.000Z',
              threadId,
              turnId: asTurnId('turn-quarantine-completion-race'),
              toolKind: 'command',
              title: 'changed body',
            })
            assert.equal((yield* Deferred.await(admissionFailed)).reason, 'event-collision')
            yield* Deferred.await(cleanupStarted)

            yield* Ref.set(currentAdapter, replacementAdapter)
            yield* Ref.set(pauseReplacementLookup, true)
            yield* PubSub.publish(changes, undefined)
            yield* Deferred.await(replacementLookupPaused)

            yield* Deferred.succeed(allowCleanup, undefined)
            yield* Deferred.await(cleanupReturned)
            yield* Effect.yieldNow
            yield* Deferred.succeed(allowReplacementLookup, undefined)
            yield* Deferred.await(replacementSubscribed)
            yield* Effect.yieldNow

            const healthy = yield* Effect.result(provider.getCapabilities(codexInstanceId))
            assert.equal(healthy._tag, 'Success')
            assert.equal(oldCodex.stopAll.mock.calls.length, 1)
          }).pipe(Effect.provide(providerLayer)),
        )
      }),
  )

  it.effect('keeps subscriber delivery ordered and isolates failing subscribers', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const session = yield* provider.startSession(asThreadId('thread-1'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-1'),
        runtimeMode: 'full-access',
      })

      const receivedByHealthy: string[] = []
      const expectedEventIds = new Set<string>(['evt-ordered-1', 'evt-ordered-2', 'evt-ordered-3'])
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() =>
          {
            receivedByHealthy.push(event.eventId)
          }),
        ),
        Effect.forkChild,
      )
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail('listener crash')),
        Effect.forkChild,
      )
      yield* advanceTestClock(50)

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: 'tool.completed',
          eventId: asEventId('evt-ordered-1'),
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.000Z',
          threadId: session.threadId,
          turnId: asTurnId('turn-1'),
          toolKind: 'command',
          title: 'Ran command',
          detail: 'echo one',
        },
        {
          type: 'message.delta',
          eventId: asEventId('evt-ordered-2'),
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.000Z',
          threadId: session.threadId,
          turnId: asTurnId('turn-1'),
          delta: 'hello',
        },
        {
          type: 'turn.completed',
          eventId: asEventId('evt-ordered-3'),
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.000Z',
          threadId: session.threadId,
          turnId: asTurnId('turn-1'),
          status: 'completed',
        },
      ]

      for (const event of events)
      {
        fanout.codex.emit(event)
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber))
      assert.equal(failingResult._tag, 'Failure')
      yield* Fiber.join(healthyFiber)

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ['evt-ordered-1', 'evt-ordered-2', 'evt-ordered-3'],
      )
    }),
  )

  it.effect('records provider metrics with the routed provider label', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      const session = yield* provider.startSession(asThreadId('thread-metrics'), {
        provider: ProviderDriverKind.make('claudeAgent'),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId('thread-metrics'),
        cwd: '/tmp/project',
        runtimeMode: 'full-access',
      })

      yield* provider.interruptTurn({ threadId: session.threadId })
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId('req-metrics-1'),
        decision: 'accept',
      })
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId('req-metrics-2'),
        answers: {
          sandbox_mode: 'workspace-write',
        },
      })
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
        expectedProviderInstanceId: claudeAgentInstanceId,
      })
      yield* provider.stopSession({ threadId: session.threadId })

      const snapshots = yield* Metric.snapshot

      assert.equal(
        hasMetricSnapshot(snapshots, 't3_provider_turns_total', {
          provider: ProviderDriverKind.make('claudeAgent'),
          operation: 'interrupt',
          outcome: 'success',
        }),
        true,
      )
      assert.equal(
        hasMetricSnapshot(snapshots, 't3_provider_turns_total', {
          provider: ProviderDriverKind.make('claudeAgent'),
          operation: 'approval-response',
          outcome: 'success',
        }),
        true,
      )
      assert.equal(
        hasMetricSnapshot(snapshots, 't3_provider_turns_total', {
          provider: ProviderDriverKind.make('claudeAgent'),
          operation: 'user-input-response',
          outcome: 'success',
        }),
        true,
      )
      assert.equal(
        hasMetricSnapshot(snapshots, 't3_provider_turns_total', {
          provider: ProviderDriverKind.make('claudeAgent'),
          operation: 'rollback',
          outcome: 'success',
        }),
        true,
      )
      assert.equal(
        hasMetricSnapshot(snapshots, 't3_provider_sessions_total', {
          provider: ProviderDriverKind.make('claudeAgent'),
          operation: 'stop',
          outcome: 'success',
        }),
        true,
      )
    }),
  )

  it.effect(
    'records sendTurn metrics with the resolved provider when modelSelection is omitted',
    () =>
      Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService

        const session = yield* provider.startSession(asThreadId('thread-send-metrics'), {
          provider: ProviderDriverKind.make('claudeAgent'),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId('thread-send-metrics'),
          cwd: '/tmp/project-send-metrics',
          runtimeMode: 'full-access',
        })

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: 'hello',
          attachments: [],
        })

        const snapshots = yield* Metric.snapshot

        assert.equal(
          hasMetricSnapshot(snapshots, 't3_provider_turns_total', {
            provider: ProviderDriverKind.make('claudeAgent'),
            operation: 'send',
            outcome: 'success',
          }),
          true,
        )
        assert.equal(
          hasMetricSnapshot(snapshots, 't3_provider_turn_duration', {
            provider: ProviderDriverKind.make('claudeAgent'),
            operation: 'send',
          }),
          true,
        )
      }),
  )
})

const validation = makeProviderServiceLayer()
validation.layer('ProviderServiceLive validation', (it) =>
{
  it.effect('rejects session starts without an explicit provider instance id', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      validation.codex.startSession.mockClear()
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId('thread-missing-instance-id'), {
          provider: ProviderDriverKind.make('codex'),
          threadId: asThreadId('thread-missing-instance-id'),
          runtimeMode: 'full-access',
        }),
      )

      assert.instanceOf(failure, ProviderValidationError)
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.")
      assert.equal(validation.codex.startSession.mock.calls.length, 0)
    }),
  )

  it.effect('rejects mismatched provider kind and provider instance id', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      validation.codex.startSession.mockClear()
      validation.claude.startSession.mockClear()
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId('thread-instance-mismatch'), {
          provider: ProviderDriverKind.make('codex'),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId('thread-instance-mismatch'),
          runtimeMode: 'full-access',
        }),
      )

      assert.instanceOf(failure, ProviderValidationError)
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      )
      assert.equal(validation.codex.startSession.mock.calls.length, 0)
      assert.equal(validation.claude.startSession.mock.calls.length, 0)
    }),
  )

  it.effect('returns ProviderValidationError for invalid input payloads', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService

      const failure = yield* Effect.result(
        provider.startSession(asThreadId('thread-validation'), {
          threadId: asThreadId('thread-validation'),
          provider: 'invalid-provider',
          runtimeMode: 'full-access',
        } as never),
      )

      assert.equal(failure._tag, 'Failure')
      if (failure._tag !== 'Failure')
      {
        return
      }
      assert.equal(failure.failure._tag, 'ProviderValidationError')
      if (failure.failure._tag !== 'ProviderValidationError')
      {
        return
      }
      assert.equal(failure.failure.operation, 'ProviderService.startSession')
      assert.equal(failure.failure.issue.includes('invalid-provider'), true)
    }),
  )

  it.effect('accepts startSession when adapter has not emitted provider thread id yet', () =>
    Effect.gen(function* ()
    {
      const provider = yield* ProviderService.ProviderService
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() =>
        {
          const now = '2026-01-01T00:00:00.000Z'
          return {
            provider: ProviderDriverKind.make('codex'),
            status: 'ready',
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession
        }),
      )

      const session = yield* provider.startSession(asThreadId('thread-missing'), {
        provider: ProviderDriverKind.make('codex'),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId('thread-missing'),
        cwd: '/tmp/project',
        runtimeMode: 'full-access',
      })

      assert.equal(session.threadId, asThreadId('thread-missing'))

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      })
      assert.equal(Option.isSome(runtime), true)
      if (Option.isSome(runtime))
      {
        assert.equal(runtime.value.threadId, session.threadId)
      }
    }),
  )
})
