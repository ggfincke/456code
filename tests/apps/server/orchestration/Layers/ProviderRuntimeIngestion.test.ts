// tests/apps/server/orchestration/Layers/ProviderRuntimeIngestion.test.ts
// verifies provider runtime events are projected into thread state

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import {
  ContextWindowUpdatedActivityPayload,
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from '@t3tools/contracts'
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { it as effectIt } from '@effect/vitest'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import {
  ProviderService,
  type ProviderServiceShape,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import { CODEX_PROVIDER_CAPABILITIES } from '../../../../../apps/server/src/provider/providerCapabilities.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import { OrchestrationEngineLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { ProviderRuntimeIngestionLive } from '../../../../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts'
import { DEFAULT_THREAD_TITLE } from '../../../../../apps/server/src/orchestration/threadTitles.ts'
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ProviderRuntimeIngestionService } from '../../../../../apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts'
import * as VcsProcess from '../../../../../apps/server/src/vcs/VcsProcess.ts'
import * as VcsDriverRegistry from '../../../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as CheckpointStore from '../../../../../apps/server/src/checkpointing/CheckpointStore.ts'
import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { ServerSettingsService } from '../../../../../apps/server/src/serverSettings.ts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { ProviderRuntimeInbox } from '../../../../../apps/server/src/persistence/Services/ProviderRuntimeInbox.ts'
import { OrchestrationReactorDelivery } from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import {
  makeProviderRuntimeInboxTestAdmission,
  ProviderRuntimeInboxTestInfrastructureLive,
} from '../../support/providerRuntimeInbox.ts'

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {})
{
  return ServerSettingsService.layerTest(overrides)
}

const asProjectId = (value: string): ProjectId => ProjectId.make(value)
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value)
const asEventId = (value: string): EventId => EventId.make(value)
const asMessageId = (value: string): MessageId => MessageId.make(value)
const asThreadId = (value: string): ThreadId => ThreadId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)

type LegacyProviderRuntimeEvent = {
  readonly type: string
  readonly eventId: EventId
  readonly provider: ProviderRuntimeEvent['provider']
  readonly createdAt: string
  readonly threadId: ThreadId
  readonly turnId?: string | undefined
  readonly itemId?: string | undefined
  readonly requestId?: string | undefined
  readonly payload?: unknown | undefined
  readonly [key: string]: unknown
}

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: 'turn.completed'
  readonly payload?: undefined
  readonly status: 'completed' | 'failed' | 'interrupted' | 'cancelled'
  readonly errorMessage?: string | undefined
}

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent
{
  return (
    event.type === 'turn.completed' &&
    event.payload === undefined &&
    typeof event.status === 'string'
  )
}

function createProviderServiceHarness()
{
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>())
  const runtimeSessions: ProviderSession[] = []
  let appendRuntimeEvent:
    ((event: ProviderRuntimeEvent) => Effect.Effect<unknown, Error>) | undefined
  let admissionTail = Promise.resolve()

  const unsupported = () => Effect.die(new Error('Unsupported provider call in test')) as never
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    captureSessionIdentity: () => unsupported(),
    captureSessionIdentities: () => Effect.succeed([]),
    getSessionIdentityState: () => Effect.succeed(Option.none()),
    matchesSessionIdentity: () => unsupported(),
    stopSessionIfExact: () => unsupported(),
    getAdmissionHandoffHighWater: Effect.succeed(null),
    resumeAdmissionAfterHandoff: Effect.void,
    shutdown: Effect.succeed(0),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed(CODEX_PROVIDER_CAPABILITIES),
    getInstanceInfo: (instanceId) =>
    {
      const driverKind = ProviderDriverKind.make(String(instanceId))
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      })
    },
    rollbackConversation: () => unsupported(),
    rollbackConversationIfExact: () => Effect.succeed(false),
    getConversationTurnCountIfExact: () => Effect.succeed(Option.none()),
    get streamEvents()
    {
      return Stream.fromPubSub(runtimeEventPubSub)
    },
  }

  const setSession = (session: ProviderSession): void =>
  {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId)
    if (existingIndex >= 0)
    {
      runtimeSessions[existingIndex] = session
      return
    }
    runtimeSessions.push(session)
  }

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent =>
  {
    if (isLegacyTurnCompletedEvent(event))
    {
      const normalized: Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>, 'payload'>),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === 'string' ? { errorMessage: event.errorMessage } : {}),
        },
      }
      return normalized
    }

    let payload = event.payload
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as { readonly status?: string }).status === 'in_progress'
    )
    {
      payload = { ...payload, status: 'inProgress' }
    }
    if (
      event.type === 'turn.plan.updated' &&
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      Array.isArray((payload as { readonly plan?: unknown }).plan)
    )
    {
      payload = {
        ...payload,
        plan: (payload as { readonly plan: ReadonlyArray<Record<string, unknown>> }).plan.map(
          (step) => (step.status === 'in_progress' ? { ...step, status: 'inProgress' } : step),
        ),
      }
    }
    if (payload === undefined)
    {
      payload =
        event.type === 'session.started' && typeof event.message === 'string'
          ? { message: event.message }
          : {}
    }

    return { ...event, payload } as ProviderRuntimeEvent
  }

  const emit = (event: LegacyProviderRuntimeEvent): void =>
  {
    // mirror ProviderService.streamEvents stamping: ingestion now fences events
    // by provider instance (megacore U-072) and this harness bypasses the
    // service boundary that stamps providerInstanceId in production
    const normalized = normalizeLegacyEvent(event)
    const stamped: ProviderRuntimeEvent = {
      ...normalized,
      providerInstanceId:
        normalized.providerInstanceId ?? ProviderInstanceId.make(String(normalized.provider)),
    }
    if (appendRuntimeEvent === undefined)
    {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, stamped))
      return
    }
    admissionTail = admissionTail.then(() =>
      Effect.runPromise(
        appendRuntimeEvent!(stamped).pipe(
          Effect.andThen(PubSub.publish(runtimeEventPubSub, stamped)),
          Effect.asVoid,
        ),
      ),
    )
  }

  return {
    service,
    emit,
    setSession,
    setAdmission: (
      append: (event: ProviderRuntimeEvent) => Effect.Effect<unknown, Error>,
    ): void =>
    {
      appendRuntimeEvent = append
    },
    flushAdmissions: (): Promise<void> => admissionTail,
  }
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel['threads'][number]
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread['messages'][number]
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread['proposedPlans'][number]
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread['activities'][number]
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread['checkpoints'][number]

async function waitForThread(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId('thread-1'),
)
{
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs
  const poll = async (): Promise<ProviderRuntimeTestThread> =>
  {
    const snapshot = await readModel()
    const thread = snapshot.threads.find((entry) => entry.id === threadId)
    if (thread && predicate(thread))
    {
      return thread
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline)
    {
      throw new Error('Timed out waiting for thread state')
    }
    await Effect.runPromise(Effect.yieldNow)
    return poll()
  }
  return poll()
}

describe('ProviderRuntimeIngestion', () =>
{
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | ProviderRuntimeInbox
    | OrchestrationReactorDelivery
    | SqlClient.SqlClient,
    unknown
  > | null = null
  let scope: Scope.Closeable | null = null
  const tempDirs: string[] = []

  function makeTempDir(prefix: string): string
  {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () =>
  {
    if (scope)
    {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    scope = null
    if (runtime)
    {
      await runtime.dispose()
    }
    runtime = null
    for (const dir of tempDirs.splice(0))
    {
      NodeFS.rmSync(dir, { recursive: true, force: true })
    }
  })

  async function createHarness(options?: {
    serverSettings?: Partial<ServerSettings>
    threadTitle?: string
    beforeDispatchInternal?: (
      command: Parameters<OrchestrationEngineShape['dispatchInternal']>[0],
      authority: Parameters<OrchestrationEngineShape['dispatchInternal']>[1],
    ) => Effect.Effect<void>
  })
  {
    const workspaceRoot = makeTempDir('t3-provider-project-')
    // repository detection now goes through the vcs registry (megacore XC2-1),
    // so the fixture needs a real repo rather than an empty .git directory
    NodeChildProcess.execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot })
    const provider = createProviderServiceHarness()
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(AttachmentLifecycleRepositoryLive),
      Layer.provideMerge(CheckpointRevertOperationsLive),
      Layer.provide(SqlitePersistenceMemory),
    )
    let domainSubscriptionCount = 0
    const observedOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* ()
      {
        const engine = yield* OrchestrationEngineService
        return OrchestrationEngineService.of({
          readEvents: engine.readEvents,
          readThreadEvents: engine.readThreadEvents,
          getThreadReplayStats: engine.getThreadReplayStats,
          dispatch: engine.dispatch,
          dispatchInternal: (command, authority) =>
            (options?.beforeDispatchInternal?.(command, authority) ?? Effect.void).pipe(
              Effect.andThen(engine.dispatchInternal(command, authority)),
            ),
          get streamDomainEvents()
          {
            domainSubscriptionCount += 1
            return engine.streamDomainEvents
          },
          streamDomainEventsForAggregate: engine.streamDomainEventsForAggregate,
          latestSequence: engine.latestSequence,
        })
      }),
    ).pipe(Layer.provide(orchestrationLayer))
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(AttachmentLifecycleRepositoryLive),
      Layer.provideMerge(CheckpointRevertOperationsLive),
      Layer.provide(SqlitePersistenceMemory),
    )
    const layer = ProviderRuntimeIngestionLive.pipe(
      // ingestion now resolves repositories through CheckpointStore (megacore XC2-1)
      Layer.provideMerge(CheckpointStore.layer),
      Layer.provideMerge(VcsDriverRegistry.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(observedOrchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ProviderRuntimeInboxTestInfrastructureLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    )
    runtime = ManagedRuntime.make(layer)
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery))
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService))
    const delivery = await runtime.runPromise(Effect.service(OrchestrationReactorDelivery))
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
    const admission = await runtime.runPromise(makeProviderRuntimeInboxTestAdmission)
    provider.setAdmission(admission.append)
    scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)))
    const drain = async () =>
    {
      await provider.flushAdmissions()
      await Effect.runPromise(ingestion.drain)
    }

    const createdAt = '2026-01-01T00:00:00.000Z'
    await Effect.runPromise(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-provider-project-create'),
        projectId: asProjectId('project-1'),
        title: 'Provider Project',
        workspaceRoot,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await Effect.runPromise(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-create'),
        threadId: ThreadId.make('thread-1'),
        projectId: asProjectId('project-1'),
        title: options?.threadTitle ?? 'Thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    )
    await Effect.runPromise(
      engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-seed'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    )
    provider.setSession({
      provider: ProviderDriverKind.make('codex'),
      status: 'ready',
      runtimeMode: 'approval-required',
      threadId: ThreadId.make('thread-1'),
      createdAt,
      updatedAt: createdAt,
    })

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      emit: provider.emit,
      setProviderSession: provider.setSession,
      readRuntimeIngestionProgress: () =>
        runtime!.runPromise(delivery.getProgress('provider-runtime-ingestion')),
      sql,
      drain,
      domainSubscriptionCount: () => domainSubscriptionCount,
    }
  }

  // ingestion fence (megacore U-072) drops events whose provider instance does
  // not match the bound session — bind before emitting provider-scoped events
  const bindSessionFence = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly providerName: string
      readonly providerInstanceId: ProviderInstanceId
      readonly commandSuffix?: string
    },
  ) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make(
          `cmd-session-seed-${input.commandSuffix ?? String(input.providerInstanceId)}-fence`,
        ),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: input.providerName,
          providerInstanceId: input.providerInstanceId,
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastError: null,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )

  const startBufferedTurn = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    turnId: string,
    now = '2026-01-01T00:00:00.000Z',
  ) =>
  {
    harness.emit({
      type: 'turn.started',
      eventId: asEventId(`evt-turn-started-${turnId}`),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId(turnId),
    })
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === 'running' && thread.session?.activeTurnId === turnId,
    )
  }

  it('does not subscribe to thread.turn-start-requested domain events', async () =>
  {
    const harness = await createHarness()
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-provider-ingestion-domain-owner-check'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: MessageId.make('message-provider-ingestion-domain-owner-check'),
          role: 'user',
          text: 'domain owner check',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    await harness.drain()

    expect(harness.domainSubscriptionCount()).toBe(0)
  })

  it('maps turn started/completed events into thread session updates', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started'),
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      createdAt: now,
      turnId: asTurnId('turn-1'),
    })

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === 'running' && thread.session?.activeTurnId === 'turn-1',
    )

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed'),
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      createdAt: '2026-01-01T00:00:00.000Z',
      turnId: asTurnId('turn-1'),
      payload: {
        state: 'failed',
        errorMessage: 'turn failed',
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'error' &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === 'turn failed',
    )
    expect(thread.session?.status).toBe('error')
    expect(thread.session?.lastError).toBe('turn failed')
  })

  it('applies provider session.state.changed transitions directly', async () =>
  {
    const harness = await createHarness()
    const waitingAt = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'session.state.changed',
      eventId: asEventId('evt-session-state-waiting'),
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      createdAt: waitingAt,
      payload: {
        state: 'waiting',
        reason: 'awaiting approval',
      },
    })

    let thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === 'running' && entry.session?.activeTurnId === null,
    )
    expect(thread.session?.status).toBe('running')
    expect(thread.session?.lastError).toBeNull()

    harness.emit({
      type: 'session.state.changed',
      eventId: asEventId('evt-session-state-error'),
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        state: 'error',
        reason: 'provider crashed',
      },
    })

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'error' &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === 'provider crashed',
    )
    expect(thread.session?.status).toBe('error')
    expect(thread.session?.lastError).toBe('provider crashed')

    harness.emit({
      type: 'session.state.changed',
      eventId: asEventId('evt-session-state-stopped'),
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        state: 'stopped',
      },
    })

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'stopped' &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === 'provider crashed',
    )
    expect(thread.session?.status).toBe('stopped')
    expect(thread.session?.lastError).toBe('provider crashed')

    harness.emit({
      type: 'session.state.changed',
      eventId: asEventId('evt-session-state-ready'),
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: {
        state: 'ready',
      },
    })

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'ready' &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    )
    expect(thread.session?.status).toBe('ready')
    expect(thread.session?.lastError).toBeNull()
  })

  it('clears active turn when provider session becomes ready', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-session-ready'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-session-ready'),
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' &&
        thread.session?.activeTurnId === 'turn-session-ready',
      10_000,
    )

    harness.emit({
      type: 'session.state.changed',
      eventId: asEventId('evt-session-state-ready-with-active-turn'),
      provider: ProviderDriverKind.make('codex'),
      threadId: asThreadId('thread-1'),
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: {
        state: 'ready',
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'ready' &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
      10_000,
    )
    expect(thread.session?.status).toBe('ready')
    expect(thread.session?.activeTurnId).toBeNull()
    expect(thread.session?.lastError).toBeNull()
  })

  effectIt.effect(
    'keeps a reconnecting pending turn starting while ready clears stale active state',
    () =>
      Effect.gen(function* ()
      {
        const harness = yield* Effect.promise(() => createHarness())
        const threadId = asThreadId('thread-1')
        const staleTurnId = asTurnId('turn-stale-before-reconnect')

        yield* harness.engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make('cmd-turn-start-pending-reconnect'),
          threadId,
          message: {
            messageId: MessageId.make('message-pending-reconnect'),
            role: 'user',
            text: 'resume after reconnect',
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: '2026-01-01T00:00:01.000Z',
        })
        yield* harness.engine.dispatch({
          type: 'thread.session.set',
          commandId: CommandId.make('cmd-session-starting-pending-reconnect'),
          threadId,
          session: {
            threadId,
            status: 'starting',
            providerName: 'codex',
            runtimeMode: 'approval-required',
            activeTurnId: staleTurnId,
            lastError: null,
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
          createdAt: '2026-01-01T00:00:01.000Z',
        })

        harness.emit({
          type: 'session.state.changed',
          eventId: asEventId('evt-session-ready-pending-reconnect'),
          provider: ProviderDriverKind.make('codex'),
          threadId,
          createdAt: '2026-01-01T00:00:02.000Z',
          payload: { state: 'ready' },
        })

        let thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) => entry.session?.status === 'starting' && entry.session.activeTurnId === null,
          ),
        )
        expect(thread.session?.status).toBe('starting')
        expect(thread.session?.activeTurnId).toBeNull()

        harness.emit({
          type: 'session.started',
          eventId: asEventId('evt-session-started-pending-reconnect'),
          provider: ProviderDriverKind.make('codex'),
          threadId,
          createdAt: '2026-01-01T00:00:03.000Z',
        })
        yield* Effect.promise(() => harness.drain())
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!
        expect(thread.session?.status).toBe('starting')
        expect(thread.session?.activeTurnId).toBeNull()

        harness.emit({
          type: 'turn.started',
          eventId: asEventId('evt-turn-started-pending-reconnect'),
          provider: ProviderDriverKind.make('codex'),
          threadId,
          turnId: asTurnId('turn-after-reconnect'),
          createdAt: '2026-01-01T00:00:04.000Z',
        })
        thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) =>
              entry.session?.status === 'running' &&
              entry.session.activeTurnId === asTurnId('turn-after-reconnect'),
          ),
        )
        expect(thread.session?.status).toBe('running')

        harness.emit({
          type: 'session.started',
          eventId: asEventId('evt-session-started-duplicate-midturn'),
          provider: ProviderDriverKind.make('codex'),
          threadId,
          createdAt: '2026-01-01T00:00:05.000Z',
        })
        yield* Effect.promise(() => harness.drain())
        thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        )!
        expect(thread.session?.status).toBe('running')
        expect(thread.session?.activeTurnId).toBe(asTurnId('turn-after-reconnect'))
      }),
  )

  effectIt.effect('keeps an aborted pending start stopped across duplicate exit events', () =>
    Effect.gen(function* ()
    {
      const harness = yield* Effect.promise(() => createHarness())
      const threadId = asThreadId('thread-1')
      const stoppedAt = '2026-01-01T00:00:02.000Z'

      yield* harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-before-stop'),
        threadId,
        message: {
          messageId: MessageId.make('message-before-stop'),
          role: 'user',
          text: 'stop this startup',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:01.000Z',
      })
      yield* harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-starting-before-stop'),
        threadId,
        session: {
          threadId,
          status: 'starting',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        createdAt: '2026-01-01T00:00:01.000Z',
      })
      yield* harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-stop-pending-start'),
        threadId,
        session: {
          threadId,
          status: 'stopped',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: stoppedAt,
        },
        createdAt: stoppedAt,
      })

      harness.emit({
        type: 'session.exited',
        eventId: asEventId('evt-session-exited-after-stop'),
        provider: ProviderDriverKind.make('codex'),
        threadId,
        createdAt: '2026-01-01T00:00:03.000Z',
        payload: {
          exitKind: 'error',
          reason: 'ACP process exited with code 9',
          recoverable: false,
        },
      })
      harness.emit({
        type: 'session.exited',
        eventId: asEventId('evt-session-exited-after-stop'),
        provider: ProviderDriverKind.make('codex'),
        threadId,
        createdAt: '2026-01-01T00:00:03.000Z',
        payload: {
          exitKind: 'error',
          reason: 'ACP process exited with code 9',
          recoverable: false,
        },
      })

      yield* Effect.promise(() => harness.drain())
      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      )
      expect(thread?.session?.status).toBe('stopped')
      expect(thread?.session?.activeTurnId).toBeNull()
      expect(thread?.session?.lastError).toBe('ACP process exited with code 9')
    }),
  )

  it('does not clear active turn when session/thread started arrives mid-turn', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-midturn-lifecycle'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-midturn-lifecycle'),
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' &&
        thread.session?.activeTurnId === 'turn-midturn-lifecycle',
      10_000,
    )

    harness.emit({
      type: 'thread.started',
      eventId: asEventId('evt-thread-started-midturn-lifecycle'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
    })
    harness.emit({
      type: 'session.started',
      eventId: asEventId('evt-session-started-midturn-lifecycle'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
    })

    await harness.drain()
    const midReadModel = await harness.readModel()
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(midThread?.session?.status).toBe('running')
    expect(midThread?.session?.activeTurnId).toBe('turn-midturn-lifecycle')

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-midturn-lifecycle'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-midturn-lifecycle'),
      status: 'completed',
    })

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === 'ready' && thread.session?.activeTurnId === null,
      10_000,
    )
  })

  it('accepts claude turn lifecycle when seeded thread id is a synthetic placeholder', async () =>
  {
    const harness = await createHarness()
    const seededAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-seed-claude-placeholder'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'claudeAgent',
          providerInstanceId: ProviderInstanceId.make('claudeAgent'),
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    )

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-claude-placeholder'),
      provider: ProviderDriverKind.make('claudeAgent'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-claude-placeholder'),
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' &&
        thread.session?.activeTurnId === 'turn-claude-placeholder',
    )

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-claude-placeholder'),
      provider: ProviderDriverKind.make('claudeAgent'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-claude-placeholder'),
      status: 'completed',
    })

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === 'ready' && thread.session?.activeTurnId === null,
    )
  })

  it('rejects an untargeted turn completion when no turn is active', async () =>
  {
    const harness = await createHarness()
    const seededAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-seed-untargeted-completion'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'starting',
          providerName: 'claudeAgent',
          providerInstanceId: ProviderInstanceId.make('claudeAgent'),
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    )

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-untargeted'),
      provider: ProviderDriverKind.make('claudeAgent'),
      createdAt: seededAt,
      threadId: asThreadId('thread-1'),
      status: 'completed',
    })

    await harness.drain()
    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make('thread-1'),
    )
    expect(thread?.session?.status).toBe('starting')
    expect(thread?.session?.activeTurnId).toBeNull()
  })

  it('ignores auxiliary turn completions from a different provider thread', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-primary'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-primary'),
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' && thread.session?.activeTurnId === 'turn-primary',
    )

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-aux'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-aux'),
      status: 'completed',
    })

    await harness.drain()
    const midReadModel = await harness.readModel()
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(midThread?.session?.status).toBe('running')
    expect(midThread?.session?.activeTurnId).toBe('turn-primary')

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-primary'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-primary'),
      status: 'completed',
    })

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === 'ready' && thread.session?.activeTurnId === null,
    )
  })

  it('ignores non-active turn completion when runtime omits thread id', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-guarded'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-guarded-main'),
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' &&
        thread.session?.activeTurnId === 'turn-guarded-main',
    )

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-guarded-other'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-guarded-other'),
      status: 'completed',
    })

    await harness.drain()
    const midReadModel = await harness.readModel()
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(midThread?.session?.status).toBe('running')
    expect(midThread?.session?.activeTurnId).toBe('turn-guarded-main')

    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-guarded-main'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-guarded-main'),
      status: 'completed',
    })

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === 'ready' && thread.session?.activeTurnId === null,
    )
  })

  it('maps canonical content delta/item completed into finalized assistant messages', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'content.delta',
      eventId: asEventId('evt-message-delta-1'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-2'),
      itemId: asItemId('item-1'),
      payload: {
        streamKind: 'assistant_text',
        delta: 'hello',
      },
    })
    harness.emit({
      type: 'content.delta',
      eventId: asEventId('evt-message-delta-2'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-2'),
      itemId: asItemId('item-1'),
      payload: {
        streamKind: 'assistant_text',
        delta: ' world',
      },
    })
    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-message-completed'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-2'),
      itemId: asItemId('item-1'),
      payload: {
        itemType: 'assistant_message',
        status: 'completed',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === 'assistant:item-1' && !message.streaming,
      ),
    )
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === 'assistant:item-1',
    )
    expect(message?.text).toBe('hello world')
    expect(message?.streaming).toBe(false)
  })

  it('uses assistant item completion detail when no assistant deltas were streamed', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-assistant-item-completed-no-delta'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-no-delta'),
      itemId: asItemId('item-no-delta'),
      payload: {
        itemType: 'assistant_message',
        status: 'completed',
        detail: 'assistant-only final text',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === 'assistant:item-no-delta' && !message.streaming,
      ),
    )
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === 'assistant:item-no-delta',
    )
    expect(message?.text).toBe('assistant-only final text')
    expect(message?.streaming).toBe(false)
  })

  it('preserves completed tool metadata on projected tool activities', async () =>
  {
    const harness = await createHarness()
    // the ingestion fence (megacore U-072) drops events whose provider
    // instance does not match the bound session; bind a claude session first
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-seed-claude-fence'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'cursor',
          providerInstanceId: ProviderInstanceId.make('cursor'),
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastError: null,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-tool-completed-with-data'),
      provider: ProviderDriverKind.make('cursor'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-tool-completed'),
      itemId: asItemId('item-tool-completed'),
      payload: {
        itemType: 'dynamic_tool_call',
        status: 'completed',
        title: 'Read file',
        data: {
          toolCallId: 'tool-read-1',
          kind: 'read',
          rawOutput: {
            content: 'import * as Effect from "effect/Effect"\n',
          },
        },
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-tool-completed-with-data',
      ),
    )
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === 'evt-tool-completed-with-data',
    )
    const payload =
      activity?.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : undefined
    const data =
      payload?.data && typeof payload.data === 'object'
        ? (payload.data as Record<string, unknown>)
        : undefined
    const rawOutput =
      data?.rawOutput && typeof data.rawOutput === 'object'
        ? (data.rawOutput as Record<string, unknown>)
        : undefined

    expect(activity?.kind).toBe('tool.completed')
    expect(activity?.summary).toBe('Read file')
    expect(payload?.itemType).toBe('dynamic_tool_call')
    expect(payload?.detail).toBeUndefined()
    expect(data?.toolCallId).toBe('tool-read-1')
    expect(data?.kind).toBe('read')
    expect(rawOutput?.content).toBe('import * as Effect from "effect/Effect"\n')
  })

  it('normalizes command execution activities to ran-command summaries', async () =>
  {
    const harness = await createHarness()
    // the ingestion fence (megacore U-072) drops events whose provider
    // instance does not match the bound session; bind a claude session first
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-seed-claude-fence'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'cursor',
          providerInstanceId: ProviderInstanceId.make('cursor'),
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastError: null,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-command-completed'),
      provider: ProviderDriverKind.make('cursor'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-command-completed'),
      itemId: asItemId('item-command-completed'),
      payload: {
        itemType: 'command_execution',
        status: 'completed',
        title: 'Ran command',
        detail: 'bun run lint',
        data: {
          toolCallId: 'tool-command-1',
          kind: 'execute',
          command: 'bun run lint',
        },
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-command-completed',
      ),
    )
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === 'evt-command-completed',
    )
    const payload =
      activity?.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : undefined

    expect(activity?.summary).toBe('Ran command')
    expect(payload?.detail).toBe('bun run lint')
  })

  it('uses structured read-file paths when available', async () =>
  {
    const harness = await createHarness()
    // the ingestion fence (megacore U-072) drops events whose provider
    // instance does not match the bound session; bind a claude session first
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-seed-claude-fence'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'cursor',
          providerInstanceId: ProviderInstanceId.make('cursor'),
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastError: null,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-read-path-completed'),
      provider: ProviderDriverKind.make('cursor'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-read-path'),
      itemId: asItemId('item-read-path'),
      payload: {
        itemType: 'dynamic_tool_call',
        status: 'completed',
        title: 'Read file',
        detail: '/tmp/app.ts',
        data: {
          toolCallId: 'tool-read-path-1',
          kind: 'read',
          locations: [{ path: '/tmp/app.ts' }],
        },
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-read-path-completed',
      ),
    )
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === 'evt-read-path-completed',
    )
    const payload =
      activity?.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : undefined

    expect(activity?.summary).toBe('Read file')
    expect(payload?.detail).toBe('/tmp/app.ts')
  })

  it('projects completed plan items into first-class proposed plans', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.proposed.completed',
      eventId: asEventId('evt-plan-item-completed'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-plan-final'),
      payload: {
        planMarkdown: '## Ship plan\n\n- wire projection\n- render follow-up',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === 'plan:thread-1:turn:turn-plan-final',
      ),
    )
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === 'plan:thread-1:turn:turn-plan-final',
    )
    expect(proposedPlan?.planMarkdown).toBe('## Ship plan\n\n- wire projection\n- render follow-up')
  })

  it('marks the source proposed plan implemented only after the target turn starts', async () =>
  {
    const harness = await createHarness()
    const sourceThreadId = asThreadId('thread-plan')
    const targetThreadId = asThreadId('thread-implement')
    const sourceTurnId = asTurnId('turn-plan-source')
    const targetTurnId = asTurnId('turn-plan-implement')
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-create-plan-source'),
        threadId: sourceThreadId,
        projectId: asProjectId('project-1'),
        title: 'Plan Source',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: 'plan',
        runtimeMode: 'approval-required',
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-plan-source'),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-create-plan-target'),
        threadId: targetThreadId,
        projectId: asProjectId('project-1'),
        title: 'Plan Target',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-plan-target'),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    )
    harness.setProviderSession({
      provider: ProviderDriverKind.make('codex'),
      status: 'ready',
      runtimeMode: 'approval-required',
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    })

    harness.emit({
      type: 'turn.proposed.completed',
      eventId: asEventId('evt-plan-source-completed'),
      provider: ProviderDriverKind.make('codex'),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: '# Source plan',
      },
    })

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === 'plan:thread-plan:turn:turn-plan-source' &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    )
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === 'plan:thread-plan:turn:turn-plan-source',
    )
    expect(sourcePlan).toBeDefined()
    if (!sourcePlan)
    {
      throw new Error('Expected source plan to exist.')
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-plan-target'),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId('msg-plan-target'),
          role: 'user',
          text: 'PLEASE IMPLEMENT THIS PLAN:\n# Source plan',
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )

    const sourceThreadBeforeStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    )
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    })

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-plan-target-started'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: targetThreadId,
      turnId: targetTurnId,
    })

    const sourceThreadAfterStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    )
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: 'thread-implement',
    })
  })

  effectIt.effect.each([
    {
      label: 'rejected stale turn.started',
      targetThreadId: 'thread-1',
      createTargetThread: false,
      prebindActiveTurnId: 'turn-already-running',
      providerActiveTurnIdBeforeEmit: null,
      emittedTurnId: 'turn-stale-start',
      assertTargetKeepsActiveTurn: 'turn-already-running',
    },
    {
      label: 'unrelated turn.started with no tracked active turn',
      targetThreadId: 'thread-implement',
      createTargetThread: true,
      prebindActiveTurnId: null,
      providerActiveTurnIdBeforeEmit: 'turn-plan-implement',
      emittedTurnId: 'turn-replayed',
      assertTargetKeepsActiveTurn: null,
    },
  ])(
    'does not mark the source proposed plan implemented for a $label',
    ({
      targetThreadId: targetThreadIdValue,
      createTargetThread,
      prebindActiveTurnId,
      providerActiveTurnIdBeforeEmit,
      emittedTurnId,
      assertTargetKeepsActiveTurn,
    }) =>
      Effect.gen(function* ()
      {
        const harness = yield* Effect.promise(() => createHarness())
        const sourceThreadId = asThreadId('thread-plan')
        const targetThreadId = asThreadId(targetThreadIdValue)
        const sourceTurnId = asTurnId('turn-plan-source')
        const createdAt = '2026-01-01T00:00:00.000Z'
        const suffix = createTargetThread ? 'unrelated' : 'guarded'

        yield* harness.engine.dispatch({
          type: 'thread.create',
          commandId: CommandId.make(`cmd-thread-create-plan-source-${suffix}`),
          threadId: sourceThreadId,
          projectId: asProjectId('project-1'),
          title: 'Plan Source',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          interactionMode: 'plan',
          runtimeMode: 'approval-required',
          branch: null,
          worktreePath: null,
          createdAt,
        })
        yield* harness.engine.dispatch({
          type: 'thread.session.set',
          commandId: CommandId.make(`cmd-session-set-plan-source-${suffix}`),
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: 'ready',
            providerName: 'codex',
            runtimeMode: 'approval-required',
            activeTurnId: null,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        })

        if (createTargetThread)
        {
          yield* harness.engine.dispatch({
            type: 'thread.create',
            commandId: CommandId.make(`cmd-thread-create-plan-target-${suffix}`),
            threadId: targetThreadId,
            projectId: asProjectId('project-1'),
            title: 'Plan Target',
            modelSelection: {
              instanceId: ProviderInstanceId.make('codex'),
              model: 'gpt-5-codex',
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: 'approval-required',
            branch: null,
            worktreePath: null,
            createdAt,
          })
          yield* harness.engine.dispatch({
            type: 'thread.session.set',
            commandId: CommandId.make(`cmd-session-set-plan-target-${suffix}`),
            threadId: targetThreadId,
            session: {
              threadId: targetThreadId,
              status: 'ready',
              providerName: 'codex',
              runtimeMode: 'approval-required',
              activeTurnId: null,
              updatedAt: createdAt,
              lastError: null,
            },
            createdAt,
          })
        }

        if (prebindActiveTurnId !== null)
        {
          const activeTurnId = asTurnId(prebindActiveTurnId)
          harness.setProviderSession({
            provider: ProviderDriverKind.make('codex'),
            status: 'running',
            runtimeMode: 'approval-required',
            threadId: targetThreadId,
            createdAt,
            updatedAt: createdAt,
            activeTurnId,
          })
          harness.emit({
            type: 'turn.started',
            eventId: asEventId('evt-turn-started-already-running'),
            provider: ProviderDriverKind.make('codex'),
            createdAt,
            threadId: targetThreadId,
            turnId: activeTurnId,
          })
          yield* Effect.promise(() =>
            waitForThread(
              harness.readModel,
              (thread) =>
                thread.session?.status === 'running' &&
                thread.session?.activeTurnId === activeTurnId,
              2_000,
              targetThreadId,
            ),
          )
        }

        harness.emit({
          type: 'turn.proposed.completed',
          eventId: asEventId(`evt-plan-source-completed-${suffix}`),
          provider: ProviderDriverKind.make('codex'),
          createdAt,
          threadId: sourceThreadId,
          turnId: sourceTurnId,
          payload: {
            planMarkdown: '# Source plan',
          },
        })

        const sourceThreadWithPlan = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (thread) =>
              thread.proposedPlans.some(
                (proposedPlan: ProviderRuntimeTestProposedPlan) =>
                  proposedPlan.id === 'plan:thread-plan:turn:turn-plan-source' &&
                  proposedPlan.implementedAt === null,
              ),
            2_000,
            sourceThreadId,
          ),
        )
        const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
          (entry: ProviderRuntimeTestProposedPlan) =>
            entry.id === 'plan:thread-plan:turn:turn-plan-source',
        )
        expect(sourcePlan).toBeDefined()
        if (!sourcePlan)
        {
          throw new Error('Expected source plan to exist.')
        }

        yield* harness.engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make(`cmd-turn-start-plan-target-${suffix}`),
          threadId: targetThreadId,
          message: {
            messageId: asMessageId(`msg-plan-target-${suffix}`),
            role: 'user',
            text: 'PLEASE IMPLEMENT THIS PLAN:\n# Source plan',
            attachments: [],
          },
          sourceProposedPlan: {
            threadId: sourceThreadId,
            planId: sourcePlan.id,
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: '2026-01-01T00:00:00.000Z',
        })

        if (providerActiveTurnIdBeforeEmit !== null)
        {
          harness.setProviderSession({
            provider: ProviderDriverKind.make('codex'),
            status: 'running',
            runtimeMode: 'approval-required',
            threadId: targetThreadId,
            createdAt,
            updatedAt: createdAt,
            activeTurnId: asTurnId(providerActiveTurnIdBeforeEmit),
          })
        }

        harness.emit({
          type: 'turn.started',
          eventId: asEventId(`evt-turn-started-${suffix}-plan-implementation`),
          provider: ProviderDriverKind.make('codex'),
          createdAt: '2026-01-01T00:00:00.000Z',
          threadId: targetThreadId,
          turnId: asTurnId(emittedTurnId),
        })

        yield* Effect.promise(() => harness.drain())

        const readModel = yield* Effect.promise(() => harness.readModel())
        const sourceThreadAfterNegativeStart = readModel.threads.find(
          (entry) => entry.id === sourceThreadId,
        )
        expect(
          sourceThreadAfterNegativeStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
        ).toMatchObject({
          implementedAt: null,
          implementationThreadId: null,
        })

        if (assertTargetKeepsActiveTurn !== null)
        {
          const targetThreadAfterNegativeStart = readModel.threads.find(
            (entry) => entry.id === targetThreadId,
          )
          expect(targetThreadAfterNegativeStart?.session?.status).toBe('running')
          expect(targetThreadAfterNegativeStart?.session?.activeTurnId).toBe(
            assertTargetKeepsActiveTurn,
          )
        }
      }),
  )

  effectIt.effect(
    'accepts a conflicting turn.started for a pending turn start when the provider expects that turn',
    () =>
      Effect.gen(function* ()
      {
        // steering a running turn: the server requests a new turn while the old
        // one is still active, and providers like opencode open the new turn
        // without ever completing the superseded one. The new turn.started must
        // replace the active turn instead of being rejected as stale.
        const harness = yield* Effect.promise(() => createHarness())
        const threadId = asThreadId('thread-1')
        const oldTurnId = asTurnId('turn-steered-over')
        const newTurnId = asTurnId('turn-from-steer')
        const createdAt = '2026-01-01T00:00:00.000Z'

        harness.setProviderSession({
          provider: ProviderDriverKind.make('codex'),
          status: 'running',
          runtimeMode: 'approval-required',
          threadId,
          createdAt,
          updatedAt: createdAt,
          activeTurnId: oldTurnId,
        })
        harness.emit({
          type: 'turn.started',
          eventId: asEventId('evt-turn-started-steered-over'),
          provider: ProviderDriverKind.make('codex'),
          createdAt,
          threadId,
          turnId: oldTurnId,
        })
        yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (thread) =>
              thread.session?.status === 'running' && thread.session?.activeTurnId === oldTurnId,
            2_000,
            threadId,
          ),
        )

        // the steer: a user-requested turn start while the old turn still runs.
        yield* harness.engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make('cmd-turn-start-steer'),
          threadId,
          message: {
            messageId: asMessageId('msg-steer'),
            role: 'user',
            text: 'actually, do 15 instead',
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt,
        })

        // the provider session tracks the new turn before emitting turn.started
        // (sendTurn updates the session first).
        harness.setProviderSession({
          provider: ProviderDriverKind.make('codex'),
          status: 'running',
          runtimeMode: 'approval-required',
          threadId,
          createdAt,
          updatedAt: createdAt,
          activeTurnId: newTurnId,
        })
        harness.emit({
          type: 'turn.started',
          eventId: asEventId('evt-turn-started-from-steer'),
          provider: ProviderDriverKind.make('codex'),
          createdAt,
          threadId,
          turnId: newTurnId,
        })

        const threadAfterSteer = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (thread) =>
              thread.session?.status === 'running' && thread.session?.activeTurnId === newTurnId,
            2_000,
            threadId,
          ),
        )
        expect(threadAfterSteer.session?.activeTurnId).toBe(newTurnId)
        expect(threadAfterSteer.latestTurn?.turnId).toBe(newTurnId)
        expect(threadAfterSteer.latestTurn?.state).toBe('running')
      }),
  )

  it('finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-plan-buffer'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-plan-buffer'),
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' && thread.session?.activeTurnId === 'turn-plan-buffer',
    )

    harness.emit({
      type: 'turn.proposed.delta',
      eventId: asEventId('evt-plan-delta-1'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-plan-buffer'),
      payload: {
        delta: '## Buffered plan\n\n- first',
      },
    })
    harness.emit({
      type: 'turn.proposed.delta',
      eventId: asEventId('evt-plan-delta-2'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-plan-buffer'),
      payload: {
        delta: '\n- second',
      },
    })
    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-plan-buffer'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-plan-buffer'),
      payload: {
        state: 'completed',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === 'plan:thread-1:turn:turn-plan-buffer',
      ),
    )
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === 'plan:thread-1:turn:turn-plan-buffer',
    )
    expect(proposedPlan?.planMarkdown).toBe('## Buffered plan\n\n- first\n- second')
  })

  it('buffers assistant deltas by default until completion', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-buffered'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffered'),
    })
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' && thread.session?.activeTurnId === 'turn-buffered',
    )

    harness.emit({
      type: 'content.delta',
      eventId: asEventId('evt-message-delta-buffered'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffered'),
      itemId: asItemId('item-buffered'),
      payload: {
        streamKind: 'assistant_text',
        delta: 'buffer me',
      },
    })

    await harness.drain()
    const midReadModel = await harness.readModel()
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === 'assistant:item-buffered',
      ),
    ).toBe(false)

    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-message-completed-buffered'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffered'),
      itemId: asItemId('item-buffered'),
      payload: {
        itemType: 'assistant_message',
        status: 'completed',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === 'assistant:item-buffered' && !message.streaming,
      ),
    )
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === 'assistant:item-buffered',
    )
    expect(message?.text).toBe('buffer me')
    expect(message?.streaming).toBe(false)
  })

  it.each([
    {
      label: 'approval request',
      turnId: 'turn-buffered-request-flush',
      itemId: 'item-buffered-request-flush',
      delta: 'visible before approval',
      interruptEvent: {
        type: 'request.opened' as const,
        eventId: 'evt-request-opened-buffered-request-flush',
        requestId: 'req-buffered-request-flush',
        payload: {
          requestType: 'command_execution_approval' as const,
          detail: 'pwd',
        },
      },
    },
    {
      label: 'user input request',
      turnId: 'turn-buffered-user-input-flush',
      itemId: 'item-buffered-user-input-flush',
      delta: 'visible before user input',
      interruptEvent: {
        type: 'user-input.requested' as const,
        eventId: 'evt-user-input-requested-buffered-user-input-flush',
        requestId: 'req-buffered-user-input-flush',
        payload: {
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Pick one',
              options: [{ label: 'A', description: 'Option A' }],
            },
          ],
        },
      },
    },
  ])(
    'flushes and completes buffered assistant text when $label opens',
    async ({ turnId, itemId, delta, interruptEvent }) =>
    {
      const harness = await createHarness()
      const now = '2026-01-01T00:00:00.000Z'
      await startBufferedTurn(harness, turnId, now)

      harness.emit({
        type: 'content.delta',
        eventId: asEventId(`evt-message-delta-${itemId}`),
        provider: ProviderDriverKind.make('codex'),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        turnId: asTurnId(turnId),
        itemId: asItemId(itemId),
        payload: {
          streamKind: 'assistant_text',
          delta,
        },
      })
      harness.emit({
        ...interruptEvent,
        eventId: asEventId(interruptEvent.eventId),
        provider: ProviderDriverKind.make('codex'),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        turnId: asTurnId(turnId),
        requestId: ApprovalRequestId.make(interruptEvent.requestId),
      })

      const thread = await waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === `assistant:${itemId}` && !message.streaming && message.text === delta,
        ),
      )
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === `assistant:${itemId}`,
      )
      expect(message?.streaming).toBe(false)
    },
  )

  it('does not create assistant segments for whitespace-only buffered text at approval boundaries', async () =>
  {
    const harness = await createHarness()
    const startedAt = '2026-03-28T06:28:00.000Z'
    const pausedAt = '2026-03-28T06:28:01.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-buffered-whitespace-request'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: startedAt,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffered-whitespace-request'),
    })
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' &&
        thread.session?.activeTurnId === 'turn-buffered-whitespace-request',
    )

    harness.emit({
      type: 'content.delta',
      eventId: asEventId('evt-message-delta-buffered-whitespace-request'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: startedAt,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffered-whitespace-request'),
      itemId: asItemId('item-buffered-whitespace-request'),
      payload: {
        streamKind: 'assistant_text',
        delta: '\n\n\n',
      },
    })
    harness.emit({
      type: 'request.opened',
      eventId: asEventId('evt-request-opened-buffered-whitespace-request'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: pausedAt,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffered-whitespace-request'),
      requestId: ApprovalRequestId.make('req-buffered-whitespace-request'),
      payload: {
        requestType: 'command_execution_approval',
        detail: 'pwd',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === 'approval.requested',
      ),
    )
    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === 'assistant:item-buffered-whitespace-request',
      ),
    ).toBe(false)
  })

  effectIt.effect.each([
    {
      name: 'buffered',
      streaming: false as const,
      firstText: 'first half',
      secondText: ' second half',
      assertEventCount: true,
    },
    {
      name: 'streaming',
      streaming: true as const,
      firstText: 'before approval',
      secondText: ' after approval',
      assertEventCount: false,
    },
  ])(
    'starts a new $name assistant message segment after approval',
    ({ name: mode, streaming, firstText, secondText, assertEventCount }) =>
      Effect.gen(function* ()
      {
        const harness = yield* Effect.promise(() =>
          createHarness(
            streaming ? { serverSettings: { enableAssistantStreaming: true } } : undefined,
          ),
        )
        const startedAt = '2026-03-28T06:07:00.000Z'
        const pausedAt = '2026-03-28T06:07:01.000Z'
        const resumedAt = '2026-03-28T06:07:02.000Z'
        const completedAt = '2026-03-28T06:07:03.000Z'
        const turnId = `turn-${mode}-request-append`
        const itemId = `item-${mode}-request-append`
        const requestId = `req-${mode}-request-append`
        const baseMessageId = `assistant:${itemId}`
        const segmentMessageId = `${baseMessageId}:segment:1`

        harness.emit({
          type: 'turn.started',
          eventId: asEventId(`evt-turn-started-${mode}-request-append`),
          provider: ProviderDriverKind.make('codex'),
          createdAt: startedAt,
          threadId: asThreadId('thread-1'),
          turnId: asTurnId(turnId),
        })
        yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (thread) =>
              thread.session?.status === 'running' && thread.session?.activeTurnId === turnId,
          ),
        )

        harness.emit({
          type: 'content.delta',
          eventId: asEventId(`evt-message-delta-${mode}-request-append-initial`),
          provider: ProviderDriverKind.make('codex'),
          createdAt: startedAt,
          threadId: asThreadId('thread-1'),
          turnId: asTurnId(turnId),
          itemId: asItemId(itemId),
          payload: { streamKind: 'assistant_text', delta: firstText },
        })
        harness.emit({
          type: 'request.opened',
          eventId: asEventId(`evt-request-opened-${mode}-request-append`),
          provider: ProviderDriverKind.make('codex'),
          createdAt: pausedAt,
          threadId: asThreadId('thread-1'),
          turnId: asTurnId(turnId),
          requestId: ApprovalRequestId.make(requestId),
          payload: { requestType: 'command_execution_approval', detail: 'pwd' },
        })

        yield* Effect.promise(() =>
          waitForThread(harness.readModel, (entry) =>
            entry.messages.some(
              (message: ProviderRuntimeTestMessage) =>
                message.id === baseMessageId && !message.streaming && message.text === firstText,
            ),
          ),
        )

        harness.emit({
          type: 'content.delta',
          eventId: asEventId(`evt-message-delta-${mode}-request-append-followup`),
          provider: ProviderDriverKind.make('codex'),
          createdAt: resumedAt,
          threadId: asThreadId('thread-1'),
          turnId: asTurnId(turnId),
          itemId: asItemId(itemId),
          payload: { streamKind: 'assistant_text', delta: secondText },
        })
        harness.emit({
          type: 'item.completed',
          eventId: asEventId(`evt-message-completed-${mode}-request-append`),
          provider: ProviderDriverKind.make('codex'),
          createdAt: completedAt,
          threadId: asThreadId('thread-1'),
          turnId: asTurnId(turnId),
          itemId: asItemId(itemId),
          payload: { itemType: 'assistant_message', status: 'completed' },
        })

        const thread = yield* Effect.promise(() =>
          waitForThread(harness.readModel, (entry) =>
            entry.messages.some(
              (message: ProviderRuntimeTestMessage) =>
                message.id === segmentMessageId &&
                !message.streaming &&
                message.text === secondText,
            ),
          ),
        )
        expect(
          thread.messages.find((entry: ProviderRuntimeTestMessage) => entry.id === baseMessageId)
            ?.text,
        ).toBe(firstText)
        expect(
          thread.messages.find((entry: ProviderRuntimeTestMessage) => entry.id === segmentMessageId)
            ?.text,
        ).toBe(secondText)

        if (!assertEventCount)
        {
          return
        }

        const events = yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        )
        const assistantEvents = events.filter(
          (event): event is Extract<(typeof events)[number], { type: 'thread.message-sent' }> =>
            event.type === 'thread.message-sent' &&
            event.payload.messageId.startsWith(baseMessageId),
        )
        expect(assistantEvents).toHaveLength(4)
        expect(assistantEvents[0]?.payload.streaming).toBe(true)
        expect(assistantEvents[0]?.payload.text).toBe(firstText)
        expect(assistantEvents[1]?.payload.streaming).toBe(false)
        expect(assistantEvents[1]?.payload.text).toBe('')
        expect(assistantEvents[2]?.payload.messageId).toBe(segmentMessageId)
        expect(assistantEvents[2]?.payload.streaming).toBe(true)
        expect(assistantEvents[2]?.payload.text).toBe(secondText)
        expect(assistantEvents[3]?.payload.messageId).toBe(segmentMessageId)
        expect(assistantEvents[3]?.payload.streaming).toBe(false)
        expect(assistantEvents[3]?.payload.text).toBe('')
      }),
  )

  effectIt.effect('streams assistant deltas when thread.turn.start requests streaming mode', () =>
    Effect.gen(function* ()
    {
      const harness = yield* Effect.promise(() =>
        createHarness({ serverSettings: { enableAssistantStreaming: true } }),
      )
      const now = '2026-01-01T00:00:00.000Z'

      yield* harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-streaming-mode'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('message-streaming-mode'),
          role: 'user',
          text: 'stream please',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      })
      yield* Effect.promise(() => harness.drain())

      harness.emit({
        type: 'turn.started',
        eventId: asEventId('evt-turn-started-streaming-mode'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-streaming-mode'),
      })
      yield* Effect.promise(() =>
        waitForThread(
          harness.readModel,
          (thread) =>
            thread.session?.status === 'running' &&
            thread.session?.activeTurnId === 'turn-streaming-mode',
        ),
      )

      harness.emit({
        type: 'content.delta',
        eventId: asEventId('evt-message-delta-streaming-mode'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-streaming-mode'),
        itemId: asItemId('item-streaming-mode'),
        payload: {
          streamKind: 'assistant_text',
          delta: 'hello live',
        },
      })

      const liveThread = yield* Effect.promise(() =>
        waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === 'assistant:item-streaming-mode' &&
              message.streaming &&
              message.text === 'hello live',
          ),
        ),
      )
      const liveMessage = liveThread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === 'assistant:item-streaming-mode',
      )
      expect(liveMessage?.streaming).toBe(true)

      harness.emit({
        type: 'item.completed',
        eventId: asEventId('evt-message-completed-streaming-mode'),
        provider: ProviderDriverKind.make('codex'),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        turnId: asTurnId('turn-streaming-mode'),
        itemId: asItemId('item-streaming-mode'),
        payload: {
          itemType: 'assistant_message',
          status: 'completed',
          detail: 'hello live',
        },
      })

      const finalThread = yield* Effect.promise(() =>
        waitForThread(harness.readModel, (entry) =>
          entry.messages.some(
            (message: ProviderRuntimeTestMessage) =>
              message.id === 'assistant:item-streaming-mode' && !message.streaming,
          ),
        ),
      )
      const finalMessage = finalThread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === 'assistant:item-streaming-mode',
      )
      expect(finalMessage?.text).toBe('hello live')
      expect(finalMessage?.streaming).toBe(false)
    }),
  )

  it('spills oversized buffered deltas and still finalizes full assistant text', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'
    const oversizedText = 'x'.repeat(40_000)

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-buffer-spill'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffer-spill'),
    })
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' &&
        thread.session?.activeTurnId === 'turn-buffer-spill',
    )

    harness.emit({
      type: 'content.delta',
      eventId: asEventId('evt-message-delta-buffer-spill'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffer-spill'),
      itemId: asItemId('item-buffer-spill'),
      payload: {
        streamKind: 'assistant_text',
        delta: oversizedText,
      },
    })
    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-message-completed-buffer-spill'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-buffer-spill'),
      itemId: asItemId('item-buffer-spill'),
      payload: {
        itemType: 'assistant_message',
        status: 'completed',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === 'assistant:item-buffer-spill' && !message.streaming,
      ),
    )
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === 'assistant:item-buffer-spill',
    )
    expect(message?.text.length).toBe(oversizedText.length)
    expect(message?.text).toBe(oversizedText)
    expect(message?.streaming).toBe(false)
  })

  it('does not duplicate assistant completion when item.completed is followed by turn.completed', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-turn-started-for-complete-dedup'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-complete-dedup'),
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'running' &&
        thread.session?.activeTurnId === 'turn-complete-dedup',
    )

    harness.emit({
      type: 'content.delta',
      eventId: asEventId('evt-message-delta-for-complete-dedup'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-complete-dedup'),
      itemId: asItemId('item-complete-dedup'),
      payload: {
        streamKind: 'assistant_text',
        delta: 'done',
      },
    })
    harness.emit({
      type: 'item.completed',
      eventId: asEventId('evt-message-completed-for-complete-dedup'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-complete-dedup'),
      itemId: asItemId('item-complete-dedup'),
      payload: {
        itemType: 'assistant_message',
        status: 'completed',
      },
    })
    harness.emit({
      type: 'turn.completed',
      eventId: asEventId('evt-turn-completed-for-complete-dedup'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-complete-dedup'),
      payload: {
        state: 'completed',
      },
    })

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === 'ready' &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === 'assistant:item-complete-dedup' && !message.streaming,
        ),
    )

    // oxlint-disable-next-line 456code/no-manual-effect-runtime-in-tests -- the harness owns its runtime; this collects from an already-running engine outside it.effect
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    )
    const completionEvents = events.filter((event) =>
    {
      if (event.type !== 'thread.message-sent')
      {
        return false
      }
      return (
        event.payload.messageId === 'assistant:item-complete-dedup' &&
        event.payload.streaming === false
      )
    })
    expect(completionEvents).toHaveLength(1)
  })

  it('maps canonical request events into approval activities with requestKind', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'request.opened',
      eventId: asEventId('evt-request-opened'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      requestId: ApprovalRequestId.make('req-open'),
      payload: {
        requestType: 'command_execution_approval',
        detail: 'pwd',
      },
    })

    harness.emit({
      type: 'request.resolved',
      eventId: asEventId('evt-request-resolved'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      requestId: ApprovalRequestId.make('req-open'),
      payload: {
        requestType: 'command_execution_approval',
        decision: 'accept',
      },
    })

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'approval.requested',
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'approval.resolved',
        ),
    )

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread).toBeDefined()

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-request-opened',
    )
    const requestedPayload =
      requested?.payload && typeof requested.payload === 'object'
        ? (requested.payload as Record<string, unknown>)
        : undefined
    expect(requestedPayload?.requestKind).toBe('command')
    expect(requestedPayload?.requestType).toBe('command_execution_approval')

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-request-resolved',
    )
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === 'object'
        ? (resolved.payload as Record<string, unknown>)
        : undefined
    expect(resolvedPayload?.requestKind).toBe('command')
    expect(resolvedPayload?.requestType).toBe('command_execution_approval')
  })

  it('maps runtime.error into errored session state and records the activity', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'runtime.error',
      eventId: asEventId('evt-runtime-error'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-3'),
      payload: {
        message: 'runtime exploded',
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'error' &&
        entry.session?.activeTurnId === 'turn-3' &&
        entry.session?.lastError === 'runtime exploded' &&
        entry.activities.some((activity) => activity.id === 'evt-runtime-error'),
    )
    expect(thread.session?.status).toBe('error')
    expect(thread.session?.activeTurnId).toBe('turn-3')
    expect(thread.session?.lastError).toBe('runtime exploded')

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === 'evt-runtime-error',
    )
    const activityPayload =
      activity?.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : undefined

    expect(activity?.kind).toBe('runtime.error')
    expect(activityPayload?.message).toBe('runtime exploded')
  })

  it('keeps the session running when a runtime.warning arrives during an active turn', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'turn.started',
      eventId: asEventId('evt-warning-turn-started'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-warning'),
      payload: {},
    })

    harness.emit({
      type: 'runtime.warning',
      eventId: asEventId('evt-warning-runtime'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-warning'),
      payload: {
        message: 'Reconnecting... 2/5',
        detail: {
          willRetry: true,
        },
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'running' &&
        entry.session?.activeTurnId === 'turn-warning' &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === 'evt-warning-runtime' && activity.kind === 'runtime.warning',
        ),
    )
    expect(thread.session?.status).toBe('running')
    expect(thread.session?.activeTurnId).toBe('turn-warning')
    expect(thread.session?.lastError).toBeNull()
  })

  it('maps session/thread lifecycle and item.started into session/activity projections', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'session.started',
      eventId: asEventId('evt-session-started'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      message: 'session started',
    })
    harness.emit({
      type: 'thread.started',
      eventId: asEventId('evt-thread-started'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
    })
    harness.emit({
      type: 'item.started',
      eventId: asEventId('evt-tool-started'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-9'),
      payload: {
        itemType: 'command_execution',
        status: 'in_progress',
        title: 'Read file',
        detail: '/tmp/file.ts',
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === 'ready' &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'tool.started',
        ),
    )

    expect(thread.session?.status).toBe('ready')
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === 'tool.started',
      ),
    ).toBe(true)
  })

  it('consumes P1 runtime events into thread metadata, diff checkpoints, and activities', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'thread.metadata.updated',
      eventId: asEventId('evt-thread-metadata-updated'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      payload: {
        name: 'Renamed by provider',
        metadata: { source: 'provider' },
      },
    })

    harness.emit({
      type: 'turn.plan.updated',
      eventId: asEventId('evt-turn-plan-updated'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-p1'),
      payload: {
        explanation: 'Working through the plan',
        plan: [
          { step: 'Inspect files', status: 'completed' },
          { step: 'Apply patch', status: 'in_progress' },
        ],
      },
    })

    harness.emit({
      type: 'item.updated',
      eventId: asEventId('evt-item-updated'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-p1'),
      itemId: asItemId('item-p1-tool'),
      payload: {
        itemType: 'command_execution',
        status: 'inProgress',
        title: 'Run tests',
        detail: 'bun test',
        data: { pid: 123 },
      },
    })

    harness.emit({
      type: 'runtime.warning',
      eventId: asEventId('evt-runtime-warning'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-p1'),
      payload: {
        message: 'Provider got slow',
        detail: { latencyMs: 1500 },
      },
    })

    harness.emit({
      type: 'turn.diff.updated',
      eventId: asEventId('evt-turn-diff-updated'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-p1'),
      itemId: asItemId('item-p1-assistant'),
      payload: {
        unifiedDiff: 'diff --git a/file.txt b/file.txt\n+hello\n',
      },
    })

    await harness.drain()
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.title === 'Thread' &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'turn.plan.updated',
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'tool.updated',
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'runtime.warning',
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === 'turn-p1',
        ),
    )

    expect(thread.title).toBe('Thread')

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-turn-plan-updated',
    )
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === 'object'
        ? (planActivity.payload as Record<string, unknown>)
        : undefined
    expect(planActivity?.kind).toBe('turn.plan.updated')
    expect(Array.isArray(planPayload?.plan)).toBe(true)

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-item-updated',
    )
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === 'object'
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined
    expect(toolUpdate?.kind).toBe('tool.updated')
    expect(toolUpdatePayload?.itemType).toBe('command_execution')
    expect(toolUpdatePayload?.status).toBe('inProgress')

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-runtime-warning',
    )
    const warningPayload =
      warning?.payload && typeof warning.payload === 'object'
        ? (warning.payload as Record<string, unknown>)
        : undefined
    expect(warning?.kind).toBe('runtime.warning')
    expect(warningPayload?.message).toBe('Provider got slow')

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === 'turn-p1',
    )
    expect(checkpoint?.status).toBe('missing')
    expect(checkpoint?.assistantMessageId).toBe('assistant:item-p1-assistant')
    expect(checkpoint?.checkpointRef).toBe('provider-diff:evt-turn-diff-updated')
  })

  it('mirrors a provider title while the thread still has the default title', async () =>
  {
    const harness = await createHarness({ threadTitle: DEFAULT_THREAD_TITLE })
    harness.emit({
      type: 'thread.metadata.updated',
      eventId: asEventId('evt-thread-metadata-default'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      payload: {
        name: 'Renamed by provider',
        metadata: { source: 'provider' },
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.title === 'Renamed by provider',
    )
    expect(thread.title).toBe('Renamed by provider')
  })

  effectIt.effect(
    'settles lagged provider metadata at the revert inbox high-water without self-blocking',
    () =>
      Effect.gen(function* ()
      {
        const dispatchStarted = yield* Deferred.make<void>()
        const releaseDispatch = yield* Deferred.make<void>()
        const harness = yield* Effect.promise(() =>
          createHarness({
            threadTitle: DEFAULT_THREAD_TITLE,
            beforeDispatchInternal: (command, _authority) =>
              command.type === 'thread.meta.update' &&
              command.title === 'Causally prior provider title'
                ? Deferred.succeed(dispatchStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseDispatch)),
                  )
                : Effect.void,
          }),
        )
        const createdAt = '2026-01-01T00:00:01.000Z'

        harness.emit({
          type: 'thread.metadata.updated',
          eventId: asEventId('evt-metadata-before-active-revert'),
          provider: ProviderDriverKind.make('codex'),
          createdAt,
          threadId: asThreadId('thread-1'),
          payload: {
            name: 'Causally prior provider title',
            metadata: { source: 'provider' },
          },
        })
        yield* Deferred.await(dispatchStarted)

        yield* harness.engine.dispatch({
          type: 'thread.checkpoint.revert',
          commandId: CommandId.make('cmd-revert-fences-lagged-provider-metadata'),
          threadId: asThreadId('thread-1'),
          turnCount: 0,
          createdAt: '2026-01-01T00:00:02.000Z',
        })

        const operations = yield* harness.sql<{
          readonly phase: string
          readonly providerInboxHighWater: number
        }>`
        SELECT
          phase,
          provider_inbox_high_water AS "providerInboxHighWater"
        FROM checkpoint_revert_operations
        WHERE thread_id = 'thread-1'
      `
        expect(operations).toEqual([
          {
            phase: 'requested',
            providerInboxHighWater: 1,
          },
        ])

        yield* Deferred.succeed(releaseDispatch, undefined)
        yield* Effect.promise(() => harness.drain())

        const thread = yield* Effect.promise(() =>
          waitForThread(
            harness.readModel,
            (entry) => entry.title === 'Causally prior provider title',
          ),
        )
        const progress = yield* Effect.promise(() => harness.readRuntimeIngestionProgress())
        expect(thread.title).toBe('Causally prior provider title')
        expect(progress._tag).toBe('Some')
        if (progress._tag !== 'Some')
        {
          throw new Error('Expected provider runtime ingestion progress.')
        }
        expect(progress.value.blockedSequence).toBeNull()
        expect(progress.value.cursorSequence).toBe(1)
      }),
  )

  it.each([
    {
      label: 'Codex context window',
      providerName: 'codex',
      providerInstanceId: ProviderInstanceId.make('codex-work'),
      eventId: 'evt-thread-token-usage-updated',
      provider: ProviderDriverKind.make('codex'),
      emitProviderInstanceId: ProviderInstanceId.make('codex-work'),
      usage: {
        usedTokens: 1075,
        totalProcessedTokens: 10_200,
        maxTokens: 128_000,
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 50,
        reasoningOutputTokens: 25,
        lastUsedTokens: 1075,
        lastInputTokens: 1000,
        lastCachedInputTokens: 500,
        lastOutputTokens: 50,
        lastReasoningOutputTokens: 25,
        compactsAutomatically: true,
      },
      raw: undefined as
        { readonly source: string; readonly method: string; readonly payload: object } | undefined,
      expectPayload: {
        usedTokens: 1075,
        totalProcessedTokens: 10_200,
        maxTokens: 128_000,
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 50,
        reasoningOutputTokens: 25,
        lastUsedTokens: 1075,
        compactsAutomatically: true,
        provider: 'codex',
        providerInstanceId: 'codex-work',
      },
      assertLegacyDecode: true,
    },
    {
      label: 'Claude usage snapshot',
      providerName: 'claudeAgent',
      providerInstanceId: ProviderInstanceId.make('claudeAgent'),
      eventId: 'evt-thread-token-usage-updated-claude-window',
      provider: ProviderDriverKind.make('claudeAgent'),
      emitProviderInstanceId: undefined,
      usage: {
        usedTokens: 31_251,
        lastUsedTokens: 31_251,
        maxTokens: 200_000,
        toolUses: 25,
        durationMs: 43_567,
      },
      raw: {
        source: 'claude.sdk.message',
        method: 'claude/result/success',
        payload: {},
      },
      expectPayload: {
        usedTokens: 31_251,
        lastUsedTokens: 31_251,
        maxTokens: 200_000,
        toolUses: 25,
        durationMs: 43_567,
      },
      assertLegacyDecode: false,
    },
  ])(
    'projects $label into normalized thread activities',
    async ({
      providerName,
      providerInstanceId,
      eventId,
      provider,
      emitProviderInstanceId,
      usage,
      raw,
      expectPayload,
      assertLegacyDecode,
    }) =>
    {
      const harness = await createHarness()
      await bindSessionFence(harness, { providerName, providerInstanceId })
      const now = '2026-01-01T00:00:00.000Z'

      harness.emit({
        type: 'thread.token-usage.updated',
        eventId: asEventId(eventId),
        provider,
        ...(emitProviderInstanceId ? { providerInstanceId: emitProviderInstanceId } : {}),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        payload: { usage },
        ...(raw ? { raw } : {}),
      })

      const thread = await waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'context-window.updated',
        ),
      )
      const usageActivity = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.kind === 'context-window.updated',
      )
      expect(usageActivity).toBeDefined()
      expect(usageActivity?.payload).toMatchObject(expectPayload)
      if (assertLegacyDecode)
      {
        // legacy payloads without provider identity must still decode
        expect(
          Schema.decodeUnknownSync(ContextWindowUpdatedActivityPayload)({ usedTokens: 1 }),
        ).toEqual({ usedTokens: 1 })
      }
    },
  )

  it('projects compacted thread state into context compaction activities', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'thread.state.changed',
      eventId: asEventId('evt-thread-compacted'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-1'),
      payload: {
        state: 'compacted',
        detail: { source: 'provider' },
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === 'context-compaction',
      ),
    )

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === 'context-compaction',
    )
    expect(activity?.summary).toBe('Context compacted')
    expect(activity?.tone).toBe('info')
  })

  it('projects Codex task lifecycle chunks into thread activities', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'task.started',
      eventId: asEventId('evt-task-started'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-task-1'),
      payload: {
        taskId: 'turn-task-1',
        taskType: 'plan',
      },
    })

    harness.emit({
      type: 'task.progress',
      eventId: asEventId('evt-task-progress'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-task-1'),
      payload: {
        taskId: 'turn-task-1',
        description: 'Comparing the desktop rollout chunks to the app-server stream.',
        summary: 'Code reviewer is validating the desktop rollout chunks.',
      },
    })

    harness.emit({
      type: 'task.completed',
      eventId: asEventId('evt-task-completed'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-task-1'),
      payload: {
        taskId: 'turn-task-1',
        status: 'completed',
        summary: '<proposed_plan>\n# Plan title\n</proposed_plan>',
      },
    })
    harness.emit({
      type: 'turn.proposed.completed',
      eventId: asEventId('evt-task-proposed-plan-completed'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-task-1'),
      payload: {
        planMarkdown: '# Plan title',
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'task.completed',
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === 'plan:thread-1:turn:turn-task-1',
        ),
    )

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-task-started',
    )
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-task-progress',
    )
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-task-completed',
    )

    const progressPayload =
      progress?.payload && typeof progress.payload === 'object'
        ? (progress.payload as Record<string, unknown>)
        : undefined
    const completedPayload =
      completed?.payload && typeof completed.payload === 'object'
        ? (completed.payload as Record<string, unknown>)
        : undefined

    expect(started?.kind).toBe('task.started')
    expect(started?.summary).toBe('Plan task started')
    expect(progress?.kind).toBe('task.progress')
    expect(progressPayload?.detail).toBe('Code reviewer is validating the desktop rollout chunks.')
    expect(progressPayload?.summary).toBe('Code reviewer is validating the desktop rollout chunks.')
    expect(completed?.kind).toBe('task.completed')
    expect(completedPayload?.detail).toBe('<proposed_plan>\n# Plan title\n</proposed_plan>')
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === 'plan:thread-1:turn:turn-task-1',
      )?.planMarkdown,
    ).toBe('# Plan title')
  })

  it.each([
    {
      label: 'progress present',
      taskId: 'named-task-1',
      turnId: 'turn-named-task',
      description: 'Typecheck mobile app',
      emitProgress: true,
      progressSummary: 'Running tsc across the mobile workspace.',
      completedSummary: 'Typecheck finished without errors.',
      expectProgressTitle: true,
      expectCompletedDetail: true,
    },
    {
      label: 'progress absent',
      taskId: 'fast-task-1',
      turnId: 'turn-fast-task',
      description: 'wait for codex review to finish',
      emitProgress: false,
      progressSummary: undefined,
      completedSummary: undefined,
      expectProgressTitle: false,
      expectCompletedDetail: false,
    },
  ])(
    'titles task activities from the task description when $label',
    async ({
      taskId,
      turnId,
      description,
      emitProgress,
      progressSummary,
      completedSummary,
      expectProgressTitle,
      expectCompletedDetail,
    }) =>
    {
      const harness = await createHarness()
      await bindSessionFence(harness, {
        providerName: 'claudeAgent',
        providerInstanceId: ProviderInstanceId.make('claudeAgent'),
        commandSuffix: 'claude',
      })
      const now = '2026-01-01T00:00:00.000Z'
      const startedEventId = `evt-${taskId}-started`
      const progressEventId = `evt-${taskId}-progress`
      const completedEventId = `evt-${taskId}-completed`

      harness.emit({
        type: 'task.started',
        eventId: asEventId(startedEventId),
        provider: ProviderDriverKind.make('claudeAgent'),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        turnId: asTurnId(turnId),
        payload: {
          taskId,
          description,
          taskType: 'local_bash',
        },
      })

      if (emitProgress)
      {
        harness.emit({
          type: 'task.progress',
          eventId: asEventId(progressEventId),
          provider: ProviderDriverKind.make('claudeAgent'),
          createdAt: now,
          threadId: asThreadId('thread-1'),
          turnId: asTurnId(turnId),
          payload: {
            taskId,
            description,
            summary: progressSummary,
          },
        })
      }

      harness.emit({
        type: 'task.completed',
        eventId: asEventId(completedEventId),
        provider: ProviderDriverKind.make('claudeAgent'),
        createdAt: now,
        threadId: asThreadId('thread-1'),
        turnId: asTurnId(turnId),
        payload: {
          taskId,
          status: 'completed',
          ...(completedSummary === undefined ? {} : { summary: completedSummary }),
        },
      })

      const thread = await waitForThread(harness.readModel, (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === completedEventId,
        ),
      )

      const completed = thread.activities.find(
        (activity: ProviderRuntimeTestActivity) => activity.id === completedEventId,
      )
      const completedPayload =
        completed?.payload && typeof completed.payload === 'object'
          ? (completed.payload as Record<string, unknown>)
          : undefined

      expect(completedPayload?.title).toBe(description)

      if (expectProgressTitle)
      {
        const progress = thread.activities.find(
          (activity: ProviderRuntimeTestActivity) => activity.id === progressEventId,
        )
        const progressPayload =
          progress?.payload && typeof progress.payload === 'object'
            ? (progress.payload as Record<string, unknown>)
            : undefined
        expect(progress?.summary).toBe(description)
        expect(progressPayload?.title).toBe(description)
        expect(completed?.summary).toBe('Task completed')
      }

      if (expectCompletedDetail)
      {
        expect(completedPayload?.summary).toBe(completedSummary)
        expect(completedPayload?.detail).toBe(completedSummary)
      }
    },
  )

  it('titles task completion from persisted activities after the description cache is swept', async () =>
  {
    const harness = await createHarness()
    await bindSessionFence(harness, {
      providerName: 'claudeAgent',
      providerInstanceId: ProviderInstanceId.make('claudeAgent'),
      commandSuffix: 'claude',
    })
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'task.progress',
      eventId: asEventId('evt-swept-task-progress'),
      provider: ProviderDriverKind.make('claudeAgent'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-swept-task'),
      payload: {
        taskId: 'swept-task-1',
        description: 'Watch round-3 CI and bots',
        summary: 'Polling CI checks.',
      },
    })

    await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-swept-task-progress',
      ),
    )

    // session.exited sweeps the in-memory description cache; the completion
    // that follows must recover the name from persisted activities.
    harness.emit({
      type: 'session.exited',
      eventId: asEventId('evt-swept-task-session-exited'),
      provider: ProviderDriverKind.make('claudeAgent'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      payload: {},
    })

    harness.emit({
      type: 'session.started',
      eventId: asEventId('evt-swept-task-session-restarted'),
      provider: ProviderDriverKind.make('claudeAgent'),
      createdAt: '2026-01-01T00:00:01.000Z',
      threadId: asThreadId('thread-1'),
      payload: {},
    })

    harness.emit({
      type: 'task.completed',
      eventId: asEventId('evt-swept-task-completed'),
      provider: ProviderDriverKind.make('claudeAgent'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-swept-task'),
      payload: {
        taskId: 'swept-task-1',
        status: 'completed',
        summary: 'CI is green.',
      },
    })

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-swept-task-completed',
      ),
    )

    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-swept-task-completed',
    )
    const completedPayload =
      completed?.payload && typeof completed.payload === 'object'
        ? (completed.payload as Record<string, unknown>)
        : undefined

    expect(completedPayload?.title).toBe('Watch round-3 CI and bots')
  })

  it('projects structured user input request and resolution as thread activities', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'user-input.requested',
      eventId: asEventId('evt-user-input-requested'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-user-input'),
      requestId: ApprovalRequestId.make('req-user-input-1'),
      payload: {
        questions: [
          {
            id: 'sandbox_mode',
            header: 'Sandbox',
            question: 'Which mode should be used?',
            options: [
              {
                label: 'workspace-write',
                description: 'Allow workspace writes only',
              },
            ],
          },
        ],
      },
    })

    harness.emit({
      type: 'user-input.resolved',
      eventId: asEventId('evt-user-input-resolved'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-user-input'),
      requestId: ApprovalRequestId.make('req-user-input-1'),
      payload: {
        answers: {
          sandbox_mode: 'workspace-write',
        },
      },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'user-input.requested',
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === 'user-input.resolved',
        ),
    )

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-user-input-requested',
    )
    expect(requested?.kind).toBe('user-input.requested')

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === 'evt-user-input-resolved',
    )
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === 'object'
        ? (resolved.payload as Record<string, unknown>)
        : undefined
    expect(resolved?.kind).toBe('user-input.resolved')
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: 'workspace-write',
    })
  })

  it('blocks later runtime events behind an invalid canonical event for operator recovery', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    harness.emit({
      type: 'content.delta',
      eventId: asEventId('evt-invalid-delta'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: now,
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-invalid'),
      itemId: asItemId('item-invalid'),
      payload: {
        streamKind: 'assistant_text',
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent)

    harness.emit({
      type: 'runtime.error',
      eventId: asEventId('evt-runtime-error-after-failure'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: asThreadId('thread-1'),
      turnId: asTurnId('turn-after-failure'),
      payload: {
        message: 'runtime still processed',
      },
    })

    await harness.drain()

    const progress = await harness.readRuntimeIngestionProgress()
    expect(progress._tag).toBe('Some')
    if (progress._tag !== 'Some')
    {
      throw new Error('Expected provider runtime ingestion progress.')
    }
    expect(progress.value.cursorSequence).toBe(0)
    expect(progress.value.blockedSequence).toBe(1)
    expect(progress.value.lastError).toContain('cannot decode admitted provider event 1')

    // the later valid event remains pending until an operator resolves the poison barrier
    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === asThreadId('thread-1'),
    )
    expect(thread?.session?.status).toBe('ready')
    expect(thread?.session?.activeTurnId).toBeNull()
    expect(thread?.session?.lastError).toBeNull()
  })
})
