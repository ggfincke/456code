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
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import { it, assert, vi } from '@effect/vitest'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
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
import type { ProviderAdapterShape } from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'
import * as ProviderAdapterRegistry from '../../../../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts'
import * as ProviderService from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import * as ProviderSessionDirectory from '../../../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts'
import { makeProviderServiceLive } from '../../../../../apps/server/src/provider/Layers/ProviderService.ts'
import { ORCHESTRATE_MODE_INSTRUCTIONS } from '../../../../../apps/server/src/provider/CollaborationModeInstructions.ts'
import * as ProviderEventLoggers from '../../../../../apps/server/src/provider/Layers/ProviderEventLoggers.ts'
import { ProviderSessionDirectoryLive } from '../../../../../apps/server/src/provider/Layers/ProviderSessionDirectory.ts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as ProviderSessionRuntime from '../../../../../apps/server/src/persistence/ProviderSessionRuntime.ts'
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as McpSessionRegistry from '../../../../../apps/server/src/mcp/McpSessionRegistry.ts'
import * as ServerSettings from '../../../../../apps/server/src/serverSettings.ts'
import * as AnalyticsService from '../../../../../apps/server/src/telemetry/AnalyticsService.ts'
import { makeAdapterRegistryMock } from '../../../../../apps/server/src/provider/testUtils/providerAdapterRegistryMock.ts'

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest()

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value)
const asEventId = (value: string): EventId => EventId.make(value)
const asThreadId = (value: string): ThreadId => ThreadId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)
const codexInstanceId = ProviderInstanceId.make('codex')
const claudeAgentInstanceId = ProviderInstanceId.make('claudeAgent')
const CODEX_DRIVER = ProviderDriverKind.make('codex')
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make('claudeAgent')
const CURSOR_DRIVER = ProviderDriverKind.make('cursor')

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
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>())

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() =>
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
      return session
    }),
  )

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
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
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  )

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  )

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  )

  const stopSession = vi.fn((threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() =>
    {
      sessions.delete(threadId)
    }),
  )

  const listSessions = vi.fn((): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() => Array.from(sessions.values())),
  )

  const hasSession = vi.fn((threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(sessions.has(threadId)),
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
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  )

  const stopAll = vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() =>
    {
      sessions.clear()
    }),
  )

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: 'in-session',
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
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
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent))
  }

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
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
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

function makeProviderServiceLayer()
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
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  )
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
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

function makeProviderServiceTestLayer(
  registry: ProviderAdapterRegistry.ProviderAdapterRegistry['Service'],
)
{
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  )
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
  return makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(directoryLayer),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  )
}

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
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
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
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
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
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      )
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
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
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
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
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const serviceLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
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

routing.layer('binds MCP proposal authority to the exact returned turn', (it) =>
{
  it.effect('clears the previous turn before send and binds the returned turn afterward', () =>
  {
    const bindings: Array<readonly [ThreadId, TurnId | undefined]> = []
    const bindSpy = vi
      .spyOn(McpSessionRegistry, 'bindActiveMcpTurn')
      .mockImplementation((threadId, turnId) =>
        Effect.sync(() =>
        {
          bindings.push([threadId, turnId])
        }),
      )

    return Effect.gen(function* ()
    {
      routing.codex.sendTurn.mockClear()
      const provider = yield* ProviderService.ProviderService
      const threadId = asThreadId('thread-mcp-turn-binding')
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: 'full-access',
      })
      const turn = yield* provider.sendTurn({
        threadId,
        input: 'bind this proposal turn',
        attachments: [],
      })

      assert.deepEqual(bindings, [
        [threadId, undefined],
        [threadId, turn.turnId],
      ])
      yield* provider.stopSession({ threadId })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() =>
        {
          bindSpy.mockRestore()
          routing.codex.sendTurn.mockClear()
        }),
      ),
    )
  })
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
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
    const providerLayer = makeProviderServiceLive({
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
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    )

    yield* Effect.gen(function* ()
    {
      yield* ProviderService.ProviderService
      yield* advanceTestClock(10)
      codex.emit({
        eventId: asEventId('evt-canonical-thread-segment'),
        provider: ProviderDriverKind.make('codex'),
        threadId: asThreadId('thread-canonical-thread-segment'),
        createdAt: '2026-01-01T00:00:00.000Z',
        type: 'turn.completed',
        payload: {
          state: 'completed',
        },
      })
      yield* advanceTestClock(20)
    }).pipe(Effect.provide(providerLayer))

    assert.equal(canonicalEvents.length, 1)
    assert.equal(canonicalEvents[0]?.threadId, 'thread-canonical-thread-segment')
    assert.deepEqual(canonicalThreadIds, ['thread-canonical-thread-segment'])
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

    const persistenceLayer = makeSqlitePersistenceLive(dbPath)
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
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
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
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
      const persistenceLayer = makeSqlitePersistenceLive(dbPath)
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
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
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
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

      const secondCodex = makeFakeCodexAdapter()
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make('codex')]: secondCodex.adapter,
      })
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      )

      secondCodex.startSession.mockClear()
      secondCodex.rollbackThread.mockClear()

      yield* Effect.gen(function* ()
      {
        const provider = yield* ProviderService.ProviderService
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
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
      yield* routing.codex.stopSession(initial.threadId)
      routing.codex.startSession.mockClear()
      routing.codex.rollbackThread.mockClear()

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
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
        readonly stopAll: () => Effect.Effect<void, ProviderAdapterError>
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

          yield* input.routing.stopAll()
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
      })
      assert.deepEqual(routing.claude.startSession.mock.calls[0]?.[0], {
        threadId: claudeThreadId,
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        cwd: '/tmp/imported-claude',
        modelSelection: claudeModelSelection,
        resumeCursor: claudeResumeCursor,
        runtimeMode: 'approval-required',
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

      yield* routing.codex.stopAll()
      yield* routing.claude.stopAll()

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
      const persistenceLayer = makeSqlitePersistenceLive(dbPath)
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      )

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make('claudeAgent')]: firstClaude.adapter,
      })
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      )
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
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
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
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
        const persistenceLayer = makeSqlitePersistenceLive(dbPath)
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        )

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER)
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make('claudeAgent')]: firstClaude.adapter,
        })
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        )
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
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
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
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
})

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
