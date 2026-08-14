// tests/apps/server/provider/Layers/ProviderSessionReaper.test.ts
// verifies idle provider session cleanup

import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as ProviderSessionRuntime from '../../../../../apps/server/src/persistence/Services/ProviderSessionRuntime.ts'
import * as ProviderSessionRuntimeLayers from '../../../../../apps/server/src/persistence/Layers/ProviderSessionRuntime.ts'
import { ProviderValidationError } from '../../../../../apps/server/src/provider/Errors.ts'
import { ProviderBackgroundTaskRegistryLive } from '../../../../../apps/server/src/provider/Layers/ProviderBackgroundTaskRegistry.ts'
import { ProviderBackgroundTaskRegistry } from '../../../../../apps/server/src/provider/Services/ProviderBackgroundTaskRegistry.ts'
import { ProviderSessionReaper } from '../../../../../apps/server/src/provider/Services/ProviderSessionReaper.ts'
import {
  ProviderService,
  type ProviderSessionIdentityCapture,
  type ProviderServiceShape,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import { CODEX_PROVIDER_CAPABILITIES } from '../../../../../apps/server/src/provider/providerCapabilities.ts'
import { ProviderSessionDirectoryLive } from '../../../../../apps/server/src/provider/Layers/ProviderSessionDirectory.ts'
import { makeProviderSessionReaperLive } from '../../../../../apps/server/src/provider/Layers/ProviderSessionReaper.ts'
import { makeProjectionSnapshotQueryStub } from '../../projectionSnapshotQueryTestHelpers.ts'

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make('codex'),
  model: 'gpt-5-codex',
} as const

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void>
{
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs
  const poll = async (): Promise<void> =>
  {
    if (await predicate())
    {
      return
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline)
    {
      throw new Error('Timed out waiting for expectation.')
    }
    await Effect.runPromise(Effect.yieldNow)
    return poll()
  }

  return poll()
}

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
})

const unsupported = () => Effect.die(new Error('Unsupported provider call in test')) as never

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId
    readonly session: {
      readonly threadId: ThreadId
      readonly status: 'starting' | 'running' | 'ready' | 'interrupted' | 'stopped' | 'error'
      readonly providerName: 'codex' | 'claudeAgent'
      readonly runtimeMode: 'approval-required' | 'full-access' | 'auto-accept-edits'
      readonly activeTurnId: TurnId | null
      readonly lastError: string | null
      readonly updatedAt: string
    } | null
    readonly orchestratePlans?: ReadonlyArray<{
      readonly runId: string
      readonly revision: number
      readonly status: 'pending' | 'approved' | 'rejected' | 'superseded'
    }>
  }>,
)
{
  const now = '2026-01-01T00:00:00.000Z'
  const projectId = ProjectId.make('project-provider-session-reaper')

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: 'Provider Reaper Project',
        workspaceRoot: '/tmp/provider-reaper-project',
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: 'default' as const,
      runtimeMode: 'full-access' as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      origin: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      latestTurn: null,
      providerSwitch: null,
      messages: [],
      session: thread.session,
      activities: [],
      proposedPlans: [],
      orchestratePlans: (thread.orchestratePlans ?? []).map((plan) => ({
        runId: plan.runId,
        revision: plan.revision,
        turnId: null,
        workflow: 'implementation',
        task: plan.runId,
        stages: [],
        totalWorkers: 0,
        maxWorkers: 1,
        source: 'tool' as const,
        leadModelSelection: null,
        status: plan.status,
        createdAt: now,
        updatedAt: now,
      })),
      checkpoints: [],
      deletedAt: null,
    })),
  }
}

describe('ProviderSessionReaper', () =>
{
  let runtime: ManagedRuntime.ManagedRuntime<
    | ProviderBackgroundTaskRegistry
    | ProviderSessionReaper
    | ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    unknown
  > | null = null
  let scope: Scope.Closeable | null = null

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
  })

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>
    readonly providerIdentities?: ReadonlyArray<ProviderSessionIdentityCapture>
    readonly stopSessionIfExactImplementation?: (
      identity: Parameters<ProviderServiceShape['stopSessionIfExact']>[0],
    ) => ReturnType<ProviderServiceShape['stopSessionIfExact']>
  })
  {
    const providerIdentities = [...(input.providerIdentities ?? [])]
    const stopSession = vi.fn<ProviderServiceShape['stopSession']>(() => Effect.void)
    const stopSessionIfExact = vi.fn<ProviderServiceShape['stopSessionIfExact']>((identity) =>
      input.stopSessionIfExactImplementation
        ? input.stopSessionIfExactImplementation(identity)
        : Effect.sync(() =>
          {
            const identityIndex = providerIdentities.findIndex(
              (current) =>
                current.provider === identity.provider &&
                current.providerInstanceId === identity.providerInstanceId &&
                current.threadId === identity.threadId &&
                current.sessionGeneration === identity.sessionGeneration,
            )
            if (identityIndex === -1)
              {
              return false
            }
            providerIdentities.splice(identityIndex, 1)
            return true
          }),
    )
    const captureSessionIdentities = vi.fn<ProviderServiceShape['captureSessionIdentities']>(
      (request) =>
        Effect.succeed(
          providerIdentities.filter(
            (identity) => request?.threadId === undefined || identity.threadId === request.threadId,
          ),
        ),
    )

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      captureSessionIdentity: (request) =>
        Effect.succeed(
          Option.fromNullishOr(
            providerIdentities.find(
              (identity) =>
                identity.threadId === request.threadId &&
                (request.expectedProviderInstanceId === undefined ||
                  identity.providerInstanceId === request.expectedProviderInstanceId),
            ),
          ),
        ),
      captureSessionIdentities,
      getSessionIdentityState: () => Effect.succeed(Option.none()),
      matchesSessionIdentity: (identity) =>
        Effect.succeed(
          providerIdentities.some(
            (current) =>
              current.provider === identity.provider &&
              current.providerInstanceId === identity.providerInstanceId &&
              current.threadId === identity.threadId &&
              current.sessionGeneration === identity.sessionGeneration,
          ),
        ),
      stopSessionIfExact,
      getAdmissionHandoffHighWater: Effect.succeed(null),
      resumeAdmissionAfterHandoff: Effect.void,
      shutdown: Effect.succeed(0),
      listSessions: () => Effect.succeed([]),
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
      streamEvents: Stream.empty,
    }

    const runtimeRepositoryLayer = ProviderSessionRuntimeLayers.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    )
    const getThreadShellById = vi.fn((threadId: ThreadId) =>
      Effect.succeed(
        input.readModel.threads.find((thread) => thread.id === threadId)
          ? Option.some(input.readModel.threads.find((thread) => thread.id === threadId)!)
          : Option.none(),
      ),
    )
    const getThreadDetailById = vi.fn((threadId: ThreadId) =>
    {
      const thread = input.readModel.threads.find((entry) => entry.id === threadId)
      return Effect.succeed(thread === undefined ? Option.none() : Option.some(thread as never))
    })
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: 60_000,
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(ProviderBackgroundTaskRegistryLive),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQueryStub({
            getThreadShellById,
            getThreadDetailById,
          }),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    )

    runtime = ManagedRuntime.make(layer)
    return {
      stopSession,
      stopSessionIfExact,
      providerIdentities,
      getThreadShellById,
      getThreadDetailById,
      captureSessionIdentities,
    }
  }

  it('reconciles every durable open generation without a live directory binding', async () =>
  {
    const firstThreadId = ThreadId.make('thread-reaper-orphan-first')
    const secondThreadId = ThreadId.make('thread-reaper-orphan-second')
    const harness = await createHarness({
      readModel: makeReadModel([]),
      providerIdentities: [
        {
          provider: ProviderDriverKind.make('codex'),
          providerInstanceId: ProviderInstanceId.make('codex'),
          threadId: firstThreadId,
          sessionGeneration: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          provider: ProviderDriverKind.make('claudeAgent'),
          providerInstanceId: ProviderInstanceId.make('claude'),
          threadId: secondThreadId,
          sessionGeneration: 5,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    })

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)))

    await waitFor(() => vi.mocked(harness.stopSessionIfExact).mock.calls.length === 2)

    expect(
      vi
        .mocked(harness.stopSessionIfExact)
        .mock.calls.map(
          ([identity]) =>
            `${identity.providerInstanceId}:${identity.threadId}:${identity.sessionGeneration}`,
        ),
    ).toEqual(['codex:thread-reaper-orphan-first:2', 'claude:thread-reaper-orphan-second:5'])
    expect(harness.providerIdentities).toEqual([])
    expect(harness.stopSession).not.toHaveBeenCalled()
  })

  it('keeps a durable orphan alive while its exact generation has background work', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-live-background-orphan')
    const provider = ProviderDriverKind.make('claudeAgent')
    const providerInstanceId = ProviderInstanceId.make('claudeAgent')
    const identity: ProviderSessionIdentityCapture = {
      provider,
      providerInstanceId,
      threadId,
      sessionGeneration: 6,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const harness = await createHarness({
      readModel: makeReadModel([]),
      providerIdentities: [identity],
    })
    const backgroundTasks = await runtime!.runPromise(
      Effect.service(ProviderBackgroundTaskRegistry),
    )
    await runtime!.runPromise(
      backgroundTasks.observeAcceptedRuntimeEvent(identity, {
        type: 'task.started',
        eventId: EventId.make('evt-reaper-live-background-orphan-started'),
        provider,
        providerInstanceId,
        createdAt: identity.createdAt,
        threadId,
        payload: {
          taskId: RuntimeTaskId.make('task-reaper-live-background-orphan'),
        },
      } satisfies ProviderRuntimeEvent),
    )

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await runtime!.runPromise(Scope.make('sequential'))
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)))
    await waitFor(() => harness.captureSessionIdentities.mock.calls.length === 1)
    await runtime!.runPromise(drainFibers)

    expect(harness.stopSessionIfExact).not.toHaveBeenCalled()
    expect(harness.providerIdentities).toEqual([identity])
    expect(await runtime!.runPromise(backgroundTasks.hasLiveTasks(identity))).toBe(true)
  })

  it('skips a stale exact generation while an admitted background task is live', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-live-background-task')
    const provider = ProviderDriverKind.make('claudeAgent')
    const providerInstanceId = ProviderInstanceId.make('claudeAgent')
    const identity: ProviderSessionIdentityCapture = {
      provider,
      providerInstanceId,
      threadId,
      sessionGeneration: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const now = '2026-01-01T00:00:00.000Z'
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: 'ready',
            providerName: 'claudeAgent',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      providerIdentities: [identity],
    })
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    )
    const backgroundTasks = await runtime!.runPromise(
      Effect.service(ProviderBackgroundTaskRegistry),
    )

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: 'claudeAgent',
        providerInstanceId,
        adapterKey: 'claudeAgent',
        runtimeMode: 'full-access',
        status: 'running',
        lastSeenAt: '2026-04-14T00:00:00.000Z',
        resumeCursor: null,
        runtimePayload: null,
      }),
    )
    await runtime!.runPromise(
      backgroundTasks.observeAcceptedRuntimeEvent(identity, {
        type: 'task.started',
        eventId: EventId.make('evt-reaper-live-background-task-started'),
        provider,
        providerInstanceId,
        createdAt: now,
        threadId,
        payload: {
          taskId: RuntimeTaskId.make('task-reaper-live-background'),
        },
      } satisfies ProviderRuntimeEvent),
    )

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await runtime!.runPromise(Scope.make('sequential'))
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)))

    await waitFor(() => harness.getThreadShellById.mock.calls.length === 1)
    await runtime!.runPromise(drainFibers)

    expect(harness.stopSessionIfExact).not.toHaveBeenCalled()
    expect(harness.stopSession).not.toHaveBeenCalled()
    expect(await runtime!.runPromise(backgroundTasks.hasLiveTasks(identity))).toBe(true)
  })

  it('reaps a stale exact generation after its background task completes', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-stale')
    const provider = ProviderDriverKind.make('claudeAgent')
    const providerInstanceId = ProviderInstanceId.make('claudeAgent')
    const identity: ProviderSessionIdentityCapture = {
      provider,
      providerInstanceId,
      threadId,
      sessionGeneration: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const taskId = RuntimeTaskId.make('task-reaper-stale')
    const now = '2026-01-01T00:00:00.000Z'
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: 'ready',
            providerName: 'claudeAgent',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      providerIdentities: [identity],
    })
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    )
    const backgroundTasks = await runtime!.runPromise(
      Effect.service(ProviderBackgroundTaskRegistry),
    )

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: 'claudeAgent',
        providerInstanceId,
        adapterKey: 'claudeAgent',
        runtimeMode: 'full-access',
        status: 'running',
        lastSeenAt: '2026-04-14T00:00:00.000Z',
        resumeCursor: {
          opaque: 'resume-stale',
        },
        runtimePayload: null,
      }),
    )
    await runtime!.runPromise(
      backgroundTasks.observeAcceptedRuntimeEvent(identity, {
        type: 'task.progress',
        eventId: EventId.make('evt-reaper-stale-task-progress'),
        provider,
        providerInstanceId,
        createdAt: now,
        threadId,
        payload: {
          taskId,
          description: 'Background work is still running.',
        },
      } satisfies ProviderRuntimeEvent),
    )

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await runtime!.runPromise(Scope.make('sequential'))
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)))

    await waitFor(() => harness.getThreadShellById.mock.calls.length === 1)
    await runtime!.runPromise(drainFibers)
    expect(harness.stopSessionIfExact).not.toHaveBeenCalled()

    await runtime!.runPromise(Scope.close(scope, Exit.void))
    scope = null
    await runtime!.runPromise(
      backgroundTasks.observeAcceptedRuntimeEvent(identity, {
        type: 'task.completed',
        eventId: EventId.make('evt-reaper-stale-task-completed'),
        provider,
        providerInstanceId,
        createdAt: now,
        threadId,
        payload: {
          taskId,
          status: 'completed',
        },
      } satisfies ProviderRuntimeEvent),
    )
    expect(await runtime!.runPromise(backgroundTasks.hasLiveTasks(identity))).toBe(false)

    scope = await runtime!.runPromise(Scope.make('sequential'))
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)))
    await waitFor(() => harness.stopSessionIfExact.mock.calls.length === 1)

    expect(harness.stopSessionIfExact.mock.calls[0]?.[0]).toEqual(identity)
    expect(harness.stopSession).not.toHaveBeenCalled()
  })

  it('isolates background work and exits by provider session generation', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-generation-isolation')
    const provider = ProviderDriverKind.make('claudeAgent')
    const providerInstanceId = ProviderInstanceId.make('claudeAgent')
    const oldIdentity: ProviderSessionIdentityCapture = {
      provider,
      providerInstanceId,
      threadId,
      sessionGeneration: 7,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const replacementIdentity: ProviderSessionIdentityCapture = {
      ...oldIdentity,
      sessionGeneration: 8,
      createdAt: '2026-01-01T00:00:01.000Z',
    }
    const taskId = RuntimeTaskId.make('task-reaper-generation-isolation')
    await createHarness({ readModel: makeReadModel([]) })
    const backgroundTasks = await runtime!.runPromise(
      Effect.service(ProviderBackgroundTaskRegistry),
    )

    await runtime!.runPromise(
      backgroundTasks.observeAcceptedRuntimeEvent(oldIdentity, {
        type: 'task.started',
        eventId: EventId.make('evt-reaper-old-generation-task-started'),
        provider,
        providerInstanceId,
        createdAt: oldIdentity.createdAt,
        threadId,
        payload: { taskId },
      } satisfies ProviderRuntimeEvent),
    )
    expect(await runtime!.runPromise(backgroundTasks.hasLiveTasks(oldIdentity))).toBe(true)
    expect(await runtime!.runPromise(backgroundTasks.hasLiveTasks(replacementIdentity))).toBe(false)

    await runtime!.runPromise(
      backgroundTasks.observeAcceptedRuntimeEvent(replacementIdentity, {
        type: 'task.progress',
        eventId: EventId.make('evt-reaper-replacement-task-progress'),
        provider,
        providerInstanceId,
        createdAt: replacementIdentity.createdAt,
        threadId,
        payload: {
          taskId,
          description: 'Replacement generation work is still running.',
        },
      } satisfies ProviderRuntimeEvent),
    )
    await runtime!.runPromise(
      backgroundTasks.observeAcceptedRuntimeEvent(oldIdentity, {
        type: 'session.exited',
        eventId: EventId.make('evt-reaper-old-generation-exited'),
        provider,
        providerInstanceId,
        createdAt: '2026-01-01T00:00:02.000Z',
        threadId,
        payload: {
          reason: 'Old generation exited.',
          recoverable: false,
          exitKind: 'graceful',
        },
      } satisfies ProviderRuntimeEvent),
    )

    expect(await runtime!.runPromise(backgroundTasks.hasLiveTasks(oldIdentity))).toBe(false)
    expect(await runtime!.runPromise(backgroundTasks.hasLiveTasks(replacementIdentity))).toBe(true)
  })

  it('skips stale sessions when the thread still has an active turn', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-active-turn')
    const turnId = TurnId.make('turn-reaper-active')
    const now = '2026-01-01T00:00:00.000Z'
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: 'running',
            providerName: 'claudeAgent',
            runtimeMode: 'full-access',
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    })
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    )

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: 'claudeAgent',
        providerInstanceId: null,
        adapterKey: 'claudeAgent',
        runtimeMode: 'full-access',
        status: 'running',
        lastSeenAt: '2026-04-14T00:00:00.000Z',
        resumeCursor: {
          opaque: 'resume-active-turn',
        },
        runtimePayload: null,
      }),
    )

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)))
    await Effect.runPromise(drainFibers)

    expect(harness.stopSession).not.toHaveBeenCalled()
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }))
    expect(Option.isSome(remaining)).toBe(true)
  })

  it('skips stale sessions while the thread has a pending orchestrate plan', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-pending-plan')
    const now = '2026-01-01T00:00:00.000Z'
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: 'ready',
            providerName: 'claudeAgent',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          orchestratePlans: [
            {
              runId: 'run-pending-plan',
              revision: 1,
              status: 'pending',
            },
          ],
        },
      ]),
    })
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    )

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: 'claudeAgent',
        providerInstanceId: null,
        adapterKey: 'claudeAgent',
        runtimeMode: 'full-access',
        status: 'running',
        lastSeenAt: '2026-04-14T00:00:00.000Z',
        resumeCursor: {
          opaque: 'resume-pending-plan',
        },
        runtimePayload: null,
      }),
    )

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)))

    await waitFor(() => harness.getThreadDetailById.mock.calls.length === 1)
    await runtime!.runPromise(drainFibers)

    expect(harness.stopSessionIfExact).not.toHaveBeenCalled()
    expect(harness.stopSession).not.toHaveBeenCalled()
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }))
    expect(Option.isSome(remaining)).toBe(true)
  })

  it('does not reap sessions that are still within the inactivity threshold', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-fresh')
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now))
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: 'ready',
            providerName: 'claudeAgent',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    })
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    )

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: 'claudeAgent',
        providerInstanceId: null,
        adapterKey: 'claudeAgent',
        runtimeMode: 'full-access',
        status: 'running',
        lastSeenAt: now,
        resumeCursor: {
          opaque: 'resume-fresh',
        },
        runtimePayload: null,
      }),
    )

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)))
    await Effect.runPromise(drainFibers)

    expect(harness.stopSession).not.toHaveBeenCalled()
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }))
    expect(Option.isSome(remaining)).toBe(true)
  })

  it('skips persisted sessions that are already marked stopped', async () =>
  {
    const threadId = ThreadId.make('thread-reaper-stopped')
    const now = '2026-01-01T00:00:00.000Z'
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: 'stopped',
            providerName: 'claudeAgent',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    })
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    )

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: 'claudeAgent',
        providerInstanceId: null,
        adapterKey: 'claudeAgent',
        runtimeMode: 'full-access',
        status: 'stopped',
        lastSeenAt: '2026-04-14T00:00:00.000Z',
        resumeCursor: {
          opaque: 'resume-stopped',
        },
        runtimePayload: null,
      }),
    )

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
    scope = await Effect.runPromise(Scope.make('sequential'))
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)))
    await Effect.runPromise(drainFibers)

    expect(harness.stopSession).not.toHaveBeenCalled()
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }))
    expect(Option.isSome(remaining)).toBe(true)
  })

  it.each([
    {
      label: 'fails',
      blockedThreadSuffix: 'failure',
      reapedThreadSuffix: 'success',
      blockedResumeCursor: 'resume-failure',
      reapedResumeCursor: 'resume-success',
      stopSessionIfExactImplementation:
        (blockedThreadId: ThreadId) =>
        (identity: Parameters<ProviderServiceShape['stopSessionIfExact']>[0]) =>
          identity.threadId === blockedThreadId
            ? Effect.fail(
                new ProviderValidationError({
                  operation: 'ProviderSessionReaper.test',
                  issue: 'simulated stop failure',
                }),
              )
            : Effect.succeed(true),
    },
    {
      label: 'defects',
      blockedThreadSuffix: 'defect',
      reapedThreadSuffix: 'after-defect',
      blockedResumeCursor: 'resume-defect',
      reapedResumeCursor: 'resume-after-defect',
      stopSessionIfExactImplementation:
        (blockedThreadId: ThreadId) =>
        (identity: Parameters<ProviderServiceShape['stopSessionIfExact']>[0]) =>
          identity.threadId === blockedThreadId
            ? Effect.die(new Error('simulated stop defect'))
            : Effect.succeed(true),
    },
  ])(
    'continues reaping other sessions when one stop attempt $label',
    async ({
      blockedThreadSuffix,
      reapedThreadSuffix,
      blockedResumeCursor,
      reapedResumeCursor,
      stopSessionIfExactImplementation,
    }) =>
    {
      const blockedThreadId = ThreadId.make(`thread-reaper-stop-${blockedThreadSuffix}`)
      const reapedThreadId = ThreadId.make(`thread-reaper-stop-${reapedThreadSuffix}`)
      const now = '2026-01-01T00:00:00.000Z'
      const harness = await createHarness({
        readModel: makeReadModel([
          {
            id: blockedThreadId,
            session: {
              threadId: blockedThreadId,
              status: 'ready',
              providerName: 'claudeAgent',
              runtimeMode: 'full-access',
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          },
          {
            id: reapedThreadId,
            session: {
              threadId: reapedThreadId,
              status: 'ready',
              providerName: 'codex',
              runtimeMode: 'full-access',
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          },
        ]),
        providerIdentities: [
          {
            provider: ProviderDriverKind.make('claudeAgent'),
            providerInstanceId: ProviderInstanceId.make('claudeAgent'),
            threadId: blockedThreadId,
            sessionGeneration: 11,
            createdAt: now,
          },
          {
            provider: ProviderDriverKind.make('codex'),
            providerInstanceId: ProviderInstanceId.make('codex'),
            threadId: reapedThreadId,
            sessionGeneration: 12,
            createdAt: now,
          },
        ],
        stopSessionIfExactImplementation: stopSessionIfExactImplementation(blockedThreadId),
      })
      const repository = await runtime!.runPromise(
        Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
      )

      await runtime!.runPromise(
        repository.upsert({
          threadId: blockedThreadId,
          providerName: 'claudeAgent',
          providerInstanceId: null,
          adapterKey: 'claudeAgent',
          runtimeMode: 'full-access',
          status: 'running',
          lastSeenAt: '2026-04-14T00:00:00.000Z',
          resumeCursor: {
            opaque: blockedResumeCursor,
          },
          runtimePayload: null,
        }),
      )
      await runtime!.runPromise(
        repository.upsert({
          threadId: reapedThreadId,
          providerName: 'codex',
          providerInstanceId: null,
          adapterKey: 'codex',
          runtimeMode: 'full-access',
          status: 'running',
          lastSeenAt: '2026-04-14T00:01:00.000Z',
          resumeCursor: {
            opaque: reapedResumeCursor,
          },
          runtimePayload: null,
        }),
      )

      const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper))
      scope = await Effect.runPromise(Scope.make('sequential'))
      await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)))

      await waitFor(() => harness.stopSessionIfExact.mock.calls.length === 2)

      expect(harness.stopSessionIfExact.mock.calls.map(([identity]) => identity.threadId)).toEqual([
        blockedThreadId,
        reapedThreadId,
      ])
      expect(harness.stopSession).not.toHaveBeenCalled()
    },
  )
})
