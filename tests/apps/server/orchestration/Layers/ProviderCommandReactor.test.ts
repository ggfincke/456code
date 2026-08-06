// tests/apps/server/orchestration/Layers/ProviderCommandReactor.test.ts
// verifies provider intent execution, routing, and failure recovery

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeChildProcess from 'node:child_process'

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadOrigin,
} from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as PubSub from 'effect/PubSub'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { it as effectIt } from '@effect/vitest'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { deriveServerPaths, ServerConfig } from '../../../../../apps/server/src/config.ts'
import { TextGenerationError } from '@t3tools/contracts'
import * as CheckpointStore from '../../../../../apps/server/src/checkpointing/CheckpointStore.ts'
import { checkpointRefForThreadTurn } from '../../../../../apps/server/src/checkpointing/Utils.ts'
import { ProviderAdapterRequestError } from '../../../../../apps/server/src/provider/Errors.ts'
import {
  HiddenTurnAwaitError,
  observeHiddenTurnRuntimeEvent,
} from '../../../../../apps/server/src/provider/HiddenTurnRegistry.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import {
  ProviderService,
  type ProviderServiceShape,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import { makeProviderRegistryLayer } from '../../../../../apps/server/src/provider/testUtils/providerRegistryMock.ts'
import {
  TextGeneration,
  type TextGenerationShape,
} from '../../../../../apps/server/src/textGeneration/TextGeneration.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import { OrchestrationEngineLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from '../../../../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts'
import { ProviderRuntimeIngestionLive } from '../../../../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ProviderCommandReactor } from '../../../../../apps/server/src/orchestration/Services/ProviderCommandReactor.ts'
import {
  makeReactorActionId,
  OrchestrationReactorDelivery,
} from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import { ProviderRuntimeIngestionService } from '../../../../../apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts'
import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Clock from 'effect/Clock'
import { ServerSettingsService } from '../../../../../apps/server/src/serverSettings.ts'
import { VcsStatusBroadcaster } from '../../../../../apps/server/src/vcs/VcsStatusBroadcaster.ts'
import * as VcsDriverRegistry from '../../../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../../../../../apps/server/src/vcs/VcsProcess.ts'
import * as GitWorkflowService from '../../../../../apps/server/src/git/GitWorkflowService.ts'

// the harness factory runs before the harness object exists, so its own
// setup routes through this single runner
const runTest = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const asProjectId = (value: string): ProjectId => ProjectId.make(value)
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value)
const asMessageId = (value: string): MessageId => MessageId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)))

function runGit(cwd: string, args: ReadonlyArray<string>): string
{
  return NodeChildProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function unsupportedCheckpointStoreCall<A>(): Effect.Effect<A>
{
  return Effect.die(new Error('Unsupported checkpoint store call in provider reactor test'))
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
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

describe('ProviderCommandReactor', () =>
{
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | OrchestrationReactorDelivery
    | SqlClient.SqlClient,
    unknown
  > | null = null
  let scope: Scope.Closeable | null = null
  const createdStateDirs = new Set<string>()
  const createdBaseDirs = new Set<string>()

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
    for (const stateDir of createdStateDirs)
    {
      NodeFS.rmSync(stateDir, { recursive: true, force: true })
    }
    createdStateDirs.clear()
    for (const baseDir of createdBaseDirs)
    {
      NodeFS.rmSync(baseDir, { recursive: true, force: true })
    }
    createdBaseDirs.clear()
  })

  describe('provider error attribution', () =>
  {
    it.each([
      {
        name: 'prefers current instance slug',
        input: {
          instanceId: 'codex_personal',
          modelSelectionInstanceId: 'codex',
          sessionProvider: 'codex',
        },
        expected: 'codex_personal',
      },
      {
        name: 'uses desired instance slug',
        input: { instanceId: 'claude_openrouter' },
        expected: 'claude_openrouter',
      },
      {
        name: 'falls back through hint fields',
        input: { modelSelectionInstanceId: 'codex', sessionProvider: 'claude' },
        expected: 'codex',
      },
      {
        name: 'maps empty/whitespace to unknown',
        input: { instanceId: '   ' },
        expected: 'unknown',
      },
      {
        name: 'maps missing hint to unknown',
        input: {},
        expected: 'unknown',
      },
      {
        name: 'passes through bare driver labels',
        input: 'third_party_driver' as const,
        expected: 'third_party_driver',
      },
    ])('$name', ({ input, expected }) =>
    {
      if (typeof input === 'string')
      {
        expect(providerErrorLabel(input)).toBe(expected)
        return
      }
      expect(providerErrorLabelFromInstanceHint(input)).toBe(expected)
    })
  })

  async function createHarness(input?: {
    readonly baseDir?: string
    readonly workspaceRoot?: string
    readonly threadModelSelection?: ModelSelection
    readonly threadOrigin?: ThreadOrigin
    readonly instanceDriverKind?: ProviderDriverKind
    readonly sessionModelSwitch?: 'unsupported' | 'in-session'
    readonly requiresNewThreadForModelChange?: boolean
    readonly withRuntimeIngestion?: boolean
    readonly startReactor?: boolean
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>
    readonly stopSessionEffect?: (
      input: unknown,
      context?: unknown,
    ) => Effect.Effect<void, ProviderAdapterRequestError>
    readonly hasRecoverableSessionEffect?: ProviderServiceShape['hasRecoverableSession']
    readonly beforeCheckpointCapture?: () => Effect.Effect<void>
  })
  {
    const now = '2026-01-01T00:00:00.000Z'
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 't3code-reactor-'))
    createdBaseDirs.add(baseDir)
    const { stateDir } = deriveServerPathsSync(baseDir, undefined)
    createdStateDirs.add(stateDir)
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>())
    let nextSessionIndex = 1
    let nextTurnIndex = 1
    const runtimeSessions: Array<ProviderSession> = []
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5-codex',
    }
    const startSessionEffect = input?.startSessionEffect
    const startSession = vi.fn((_: unknown, input: unknown, _routingAuthority?: unknown) =>
    {
      const sessionIndex = nextSessionIndex++
      const resumeCursor =
        typeof input === 'object' && input !== null && 'resumeCursor' in input
          ? input.resumeCursor
          : undefined
      const threadId =
        typeof input === 'object' &&
        input !== null &&
        'threadId' in input &&
        typeof input.threadId === 'string'
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`)
      const inputModelSelection =
        typeof input === 'object' && input !== null && 'modelSelection' in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined
      const providerInstanceId =
        typeof input === 'object' && input !== null && 'providerInstanceId' in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId
      const provider =
        typeof input === 'object' &&
        input !== null &&
        'provider' in input &&
        typeof input.provider === 'string'
          ? (input.provider as ProviderSession['provider'])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId)
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: 'ready' as const,
        runtimeMode:
          typeof input === 'object' &&
          input !== null &&
          'runtimeMode' in input &&
          (input.runtimeMode === 'approval-required' || input.runtimeMode === 'full-access')
            ? input.runtimeMode
            : 'full-access',
        ...(typeof input === 'object' &&
        input !== null &&
        'cwd' in input &&
        typeof input.cwd === 'string'
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      }
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() =>
          {
            runtimeSessions.push(startedSession)
          }),
        ),
      )
    })
    const sendTurn = vi.fn<ProviderServiceShape['sendTurn']>((_, _routingAuthority) =>
      Effect.succeed({
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId(`turn-${nextTurnIndex++}`),
      }),
    )
    const interruptTurn = vi.fn((_: unknown) => Effect.void)
    const respondToRequest = vi.fn<ProviderServiceShape['respondToRequest']>(() => Effect.void)
    const respondToUserInput = vi.fn<ProviderServiceShape['respondToUserInput']>(() => Effect.void)
    const stopSession = vi.fn((stopInput: unknown, context?: unknown) =>
      (input?.stopSessionEffect?.(stopInput, context) ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
          {
            const threadId =
              typeof stopInput === 'object' && stopInput !== null && 'threadId' in stopInput
                ? (stopInput as { threadId?: ThreadId }).threadId
                : undefined
            if (!threadId)
            {
              return
            }
            const index = runtimeSessions.findIndex((session) => session.threadId === threadId)
            if (index >= 0)
            {
              runtimeSessions.splice(index, 1)
            }
          }),
        ),
      ),
    )
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === 'object' &&
          input !== null &&
          'newBranch' in input &&
          typeof input.newBranch === 'string'
            ? input.newBranch
            : 'renamed-branch',
      }),
    )
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: 'renamed-branch',
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    )
    const generateBranchName = vi.fn<TextGenerationShape['generateBranchName']>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: 'generateBranchName',
          detail: 'disabled in test harness',
        }),
      ),
    )
    const generateThreadTitle = vi.fn<TextGenerationShape['generateThreadTitle']>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: 'generateThreadTitle',
          detail: 'disabled in test harness',
        }),
      ),
    )
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        models: modelSelection.model ? [{ slug: modelSelection.model }] : [],
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ]

    const unsupported = () => Effect.die(new Error('Unsupported provider call in test')) as never
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape['startSession'],
      sendTurn: sendTurn as ProviderServiceShape['sendTurn'],
      interruptTurn: interruptTurn as ProviderServiceShape['interruptTurn'],
      respondToRequest: respondToRequest as ProviderServiceShape['respondToRequest'],
      respondToUserInput: respondToUserInput as ProviderServiceShape['respondToUserInput'],
      stopSession: stopSession as ProviderServiceShape['stopSession'],
      listSessions: () => Effect.succeed(runtimeSessions),
      ...(input?.hasRecoverableSessionEffect === undefined
        ? {}
        : { hasRecoverableSession: input.hasRecoverableSessionEffect }),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? 'in-session',
        }),
      getInstanceInfo: (instanceId) =>
      {
        const raw = String(instanceId)
        const driverKind =
          input?.instanceDriverKind ??
          ProviderDriverKind.make(
            raw.startsWith('claude') ? 'claudeAgent' : raw.startsWith('codex') ? 'codex' : raw,
          )
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make('codex')
                ? 'codex:home:/shared-codex'
                : `${driverKind}:instance:${instanceId}`,
          },
        })
      },
      rollbackConversation: () => unsupported(),
      get streamEvents()
      {
        return Stream.fromPubSub(runtimeEventPubSub)
      },
    }
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.runPromise(
        observeHiddenTurnRuntimeEvent(event).pipe(
          Effect.andThen(PubSub.publish(runtimeEventPubSub, event)),
          Effect.asVoid,
        ),
      )

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(CheckpointRevertOperationsLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    )
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    )
    const checkpointStoreLayer =
      input?.beforeCheckpointCapture === undefined
        ? Layer.succeed(
            CheckpointStore.CheckpointStore,
            CheckpointStore.CheckpointStore.of({
              isGitRepository: () => Effect.succeed(false),
              captureCheckpoint: () => unsupportedCheckpointStoreCall(),
              hasCheckpointRef: () => unsupportedCheckpointStoreCall(),
              restoreCheckpoint: () => unsupportedCheckpointStoreCall(),
              stageCheckpointTree: () => unsupportedCheckpointStoreCall(),
              verifyRestorePreconditions: () => unsupportedCheckpointStoreCall(),
              applyStagedRestore: () => unsupportedCheckpointStoreCall(),
              postVerifyRestore: () => unsupportedCheckpointStoreCall(),
              diffCheckpoints: () => unsupportedCheckpointStoreCall(),
              deleteCheckpointRefs: () => unsupportedCheckpointStoreCall(),
            }),
          )
        : Layer.effect(
            CheckpointStore.CheckpointStore,
            CheckpointStore.make.pipe(
              Effect.map((store) =>
                CheckpointStore.CheckpointStore.of({
                  ...store,
                  captureCheckpoint: (captureInput) =>
                    input.beforeCheckpointCapture!().pipe(
                      Effect.andThen(store.captureCheckpoint(captureInput)),
                    ),
                }),
              ),
            ),
          ).pipe(Layer.provide(VcsDriverRegistry.layer), Layer.provideMerge(VcsProcess.layer))
    const layer = Layer.merge(ProviderCommandReactorLive, ProviderRuntimeIngestionLive).pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService['Service']>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die('getStatus should not be called in this test'),
          refreshLocalStatus: () =>
            Effect.die('refreshLocalStatus should not be called in this test'),
          refreshStatus,
          streamStatus: () => Stream.die('streamStatus should not be called in this test'),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    )
    runtime = ManagedRuntime.make(layer)

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery))
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor))
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService))
    const delivery = await runtime.runPromise(Effect.service(OrchestrationReactorDelivery))
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
    scope = await runTest(Scope.make('sequential'))
    let reactorStarted = false
    const startReactor = async () =>
    {
      if (reactorStarted) return
      await runTest(reactor.start().pipe(Scope.provide(scope!)))
      reactorStarted = true
    }
    if (input?.startReactor !== false)
    {
      await startReactor()
    }
    if (input?.withRuntimeIngestion === true)
    {
      await runTest(ingestion.start().pipe(Scope.provide(scope)))
      await runtime.runPromise(Effect.yieldNow)
    }
    const drain = () => runTest(reactor.drain)
    const drainIngestion = () => runTest(ingestion.drain)

    await runTest(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-create'),
        projectId: asProjectId('project-1'),
        title: 'Provider Project',
        workspaceRoot: input?.workspaceRoot ?? '/tmp/provider-project',
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    )
    await runTest(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-create'),
        threadId: ThreadId.make('thread-1'),
        projectId: asProjectId('project-1'),
        title: 'Thread',
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        branch: null,
        worktreePath: null,
        ...(input?.threadOrigin !== undefined ? { origin: input.threadOrigin } : {}),
        createdAt: now,
      }),
    )

    return {
      engine,
      readModel: () => runTest(snapshotQuery.getSnapshot()),
      // one place that manually runs the test runtime; keeps the per-test
      // call sites free of Effect.runPromise
      run: runTest,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      emitRuntimeEvent,
      stateDir,
      drain,
      drainIngestion,
      startReactor,
      delivery,
      sql,
      nextProviderSwitchFailure: () =>
        runTest(
          engine.streamDomainEvents.pipe(
            Stream.filter((event) => event.type === 'thread.provider-switch-failed'),
            Stream.runHead,
          ),
        ),
    }
  }

  it('reacts to thread.turn.start by ensuring session and sending provider turn', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-1'),
          role: 'user',
          text: 'hello reactor',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make('thread-1'))
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: '/tmp/provider-project',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5-codex',
      },
      runtimeMode: 'approval-required',
    })

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.session?.threadId).toBe('thread-1')
    expect(thread?.session?.status).toBe('starting')
    expect(thread?.session?.runtimeMode).toBe('approval-required')
  })

  it('publishes a delayed pre-turn baseline before any provider side effect starts', async () =>
  {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 't3-provider-baseline-'))
    createdBaseDirs.add(cwd)
    runGit(cwd, ['init', '--initial-branch=main'])
    runGit(cwd, ['config', 'user.email', 'test@example.com'])
    runGit(cwd, ['config', 'user.name', 'Test User'])
    NodeFS.writeFileSync(NodePath.join(cwd, 'README.md'), 'initial\n', 'utf8')
    runGit(cwd, ['add', 'README.md'])
    runGit(cwd, ['commit', '-m', 'Initial'])
    NodeFS.writeFileSync(NodePath.join(cwd, 'README.md'), 'pre-turn\n', 'utf8')

    const captureStarted = Effect.runSync(Deferred.make<void>())
    const releaseCapture = Effect.runSync(Deferred.make<void>())
    const harness = await createHarness({
      workspaceRoot: cwd,
      beforeCheckpointCapture: () =>
        Deferred.succeed(captureStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCapture)),
        ),
    })
    harness.sendTurn.mockImplementation(() =>
      Effect.sync(() =>
      {
        NodeFS.writeFileSync(NodePath.join(cwd, 'README.md'), 'post-start\n', 'utf8')
        return {
          threadId: ThreadId.make('thread-1'),
          turnId: asTurnId('turn-after-baseline'),
        }
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-delayed-baseline'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-delayed-baseline'),
          role: 'user',
          text: 'capture before sending this turn',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )

    await harness.run(Deferred.await(captureStarted))
    expect(harness.startSession).not.toHaveBeenCalled()
    expect(harness.sendTurn).not.toHaveBeenCalled()

    await harness.run(Deferred.succeed(releaseCapture, undefined))
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    await harness.drain()

    const checkpointRef = checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0)
    expect(runGit(cwd, ['show', `${checkpointRef}:README.md`])).toBe('pre-turn')
    expect(NodeFS.readFileSync(NodePath.join(cwd, 'README.md'), 'utf8')).toBe('post-start\n')
  })

  it('materializes a duplicate source command only once', async () =>
  {
    const harness = await createHarness()
    const command = {
      type: 'thread.turn.start' as const,
      commandId: CommandId.make('cmd-turn-start-durable-duplicate'),
      threadId: ThreadId.make('thread-1'),
      message: {
        messageId: asMessageId('user-message-durable-duplicate'),
        role: 'user' as const,
        text: 'deliver this once',
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: 'approval-required' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    }

    await harness.run(harness.engine.dispatch(command))
    await harness.run(harness.engine.dispatch(command))
    await harness.drain()
    await harness.drain()

    expect(harness.sendTurn).toHaveBeenCalledTimes(1)
  })

  it('preserves FIFO ordering across two turn-start provider effects', async () =>
  {
    const harness = await createHarness()
    const releaseFirst = Effect.runSync(Deferred.make<void>())
    harness.sendTurn.mockImplementation((input: unknown) =>
    {
      const result = {
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId(`ordered-turn-${harness.sendTurn.mock.calls.length}`),
      }
      return harness.sendTurn.mock.calls.length === 1
        ? Deferred.await(releaseFirst).pipe(Effect.as(result))
        : Effect.succeed(result)
    })

    const dispatchTurn = (index: number) =>
      harness.run(
        harness.engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make(`cmd-ordered-turn-${index}`),
          threadId: ThreadId.make('thread-1'),
          message: {
            messageId: asMessageId(`ordered-message-${index}`),
            role: 'user',
            text: `ordered message ${index}`,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
        }),
      )

    await dispatchTurn(1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    await dispatchTurn(2)
    await harness.run(Effect.yieldNow)
    expect(harness.sendTurn).toHaveBeenCalledTimes(1)

    await harness.run(Deferred.succeed(releaseFirst, undefined))
    await harness.drain()

    expect(harness.sendTurn.mock.calls.map((call) => call[0])).toMatchObject([
      { input: 'ordered message 1' },
      { input: 'ordered message 2' },
    ])
  })

  it('blocks unknown delivery without retry until an operator resolves it', async () =>
  {
    const harness = await createHarness()
    harness.sendTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: 'codex',
          method: 'thread/turn/start',
          detail: 'Provider transport timed out after invocation.',
        }),
      ),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-unknown'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-unknown'),
          role: 'user',
          text: 'unknown delivery',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    await harness.drain()

    const blocked = await harness.run(harness.delivery.getProgress('provider-command'))
    expect(blocked._tag).toBe('Some')
    if (blocked._tag !== 'Some' || blocked.value.blockedSequence === null)
    {
      throw new Error('Expected provider-command progress to be blocked by unknown delivery.')
    }
    expect(harness.sendTurn).toHaveBeenCalledTimes(1)
    await harness.drain()
    expect(harness.sendTurn).toHaveBeenCalledTimes(1)

    const actionId = makeReactorActionId({
      reactorId: 'provider-command',
      sourceSequence: blocked.value.blockedSequence,
      sourceEventId: 'unused-by-action-identity',
      outputIndex: 0,
      effectKind: 'thread.turn-start-requested',
      targetKind: 'thread',
      targetId: 'thread-1',
      operationVersion: 1,
    })
    harness.sendTurn.mockImplementation(() =>
      Effect.succeed({
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId('turn-after-manual-retry'),
      }),
    )
    expect(
      await harness.run(
        harness.delivery.resolve({
          actionId,
          resolution: 'retry',
          operator: 'provider-reactor-test',
          detail: 'confirmed safe to retry',
          now: '2026-01-01T00:01:00.000Z',
        }),
      ),
    ).toBe(true)
    await harness.drain()

    expect(harness.sendTurn).toHaveBeenCalledTimes(2)
    const recovered = await harness.run(harness.delivery.getProgress('provider-command'))
    expect(recovered._tag === 'Some' ? recovered.value.blockedSequence : null).toBeNull()
  })

  it('switches without compaction when the thread has no provider context', async () =>
  {
    const harness = await createHarness()
    const targetModelSelection = {
      instanceId: ProviderInstanceId.make('claudeAgent'),
      model: 'sonnet',
    }

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-empty'),
        threadId: ThreadId.make('thread-1'),
        targetModelSelection,
        expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      return readModel.threads[0]?.modelSelection.instanceId === targetModelSelection.instanceId
    })
    const readModel = await harness.readModel()
    expect(readModel.threads[0]?.modelSelection).toEqual(targetModelSelection)
    // empty handoff text preserves the initial null handoff state
    expect(readModel.threads[0]?.pendingHandoff ?? null).toBeNull()
    expect(harness.sendTurn).not.toHaveBeenCalled()
    expect(harness.stopSession).not.toHaveBeenCalled()
  })

  it('fails a provider switch when recoverable-session planning fails', async () =>
  {
    const harness = await createHarness({
      hasRecoverableSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: 'codex',
            method: 'thread.hasRecoverableSession',
            detail: 'Recoverable session lookup failed.',
          }),
        ),
    })
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-planning-failure'),
        threadId: ThreadId.make('thread-1'),
        targetModelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'sonnet',
        },
        expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
      }),
    )
    await harness.drain()

    const thread = (await harness.readModel()).threads[0]
    expect(thread?.providerSwitch).toBeNull()
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: 'provider.switch.failed',
        payload: expect.objectContaining({
          reasonCode: 'internal-error',
          detail: 'Recoverable session lookup failed.',
          retryTargetModelSelection: {
            instanceId: 'claudeAgent',
            model: 'sonnet',
          },
        }),
      }),
    )
  })

  it('fails a provider switch when its completion receipt is rejected', async () =>
  {
    const harness = await createHarness()
    const threadId = ThreadId.make('thread-1')
    const sourceSequence = (await harness.readModel()).snapshotSequence + 2
    const actionId = makeReactorActionId({
      reactorId: 'provider-command',
      sourceSequence,
      sourceEventId: 'unused-by-action-identity',
      outputIndex: 0,
      effectKind: 'thread.provider-switch-requested',
      targetKind: 'thread',
      targetId: threadId,
      operationVersion: 1,
    })
    const rejectedCompletionCommandId = CommandId.make(
      `server:provider-switch-complete:0:reactor-action:${actionId}`,
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.meta.update',
        commandId: rejectedCompletionCommandId,
        threadId,
        title: 'Reserve the completion receipt',
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-rejected-completion-receipt'),
        threadId,
        targetModelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'sonnet',
        },
        expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
      }),
    )
    await harness.drain()

    const thread = (await harness.readModel()).threads[0]
    expect(thread?.providerSwitch).toBeNull()
    expect(thread?.modelSelection.instanceId).toBe('codex')
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: 'provider.switch.failed',
        payload: expect.objectContaining({ reasonCode: 'internal-error' }),
      }),
    )
  })

  it.each(['pending', 'compacting', 'finalizing'] as const)(
    'reconciles an interrupted %s provider switch before durable actions resume',
    async (phase) =>
    {
      const harness = await createHarness({ startReactor: false })
      const threadId = ThreadId.make('thread-1')
      const snapshotSequence = (await harness.readModel()).snapshotSequence
      await harness.run(
        harness.delivery.ensureProgress({
          reactorId: 'provider-command',
          operationVersion: 1,
          initialSequence: snapshotSequence,
          mode: 'durable',
          now: '2026-01-01T00:00:00.000Z',
        }),
      )
      await harness.run(
        harness.engine.dispatch({
          type: 'thread.session.set',
          commandId: CommandId.make(`cmd-provider-switch-${phase}-running-session`),
          threadId,
          session: {
            threadId,
            status: 'running',
            providerName: 'codex',
            providerInstanceId: ProviderInstanceId.make('codex'),
            runtimeMode: 'approval-required',
            activeTurnId: null,
            lastError: null,
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
          createdAt: '2026-01-01T00:00:01.000Z',
        }),
      )
      await harness.run(
        harness.engine.dispatch({
          type: 'thread.provider.switch',
          commandId: CommandId.make(`cmd-provider-switch-${phase}-request`),
          threadId,
          targetModelSelection: {
            instanceId: ProviderInstanceId.make('claudeAgent'),
            model: 'sonnet',
          },
          expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
        }),
      )
      if (phase === 'pending')
      {
        const providerSwitch = (await harness.readModel()).threads[0]?.providerSwitch
        if (
          providerSwitch?.requestId === undefined ||
          providerSwitch.requestSequence === undefined
        )
        {
          throw new Error('Expected the provider switch request identity to be projected.')
        }
        await harness.run(
          harness.delivery.materialize({
            reactorId: 'provider-command',
            operationVersion: 1,
            sourceSequence: providerSwitch.requestSequence,
            sourceEventId: providerSwitch.requestId,
            mode: 'durable',
            actions: [
              {
                outputIndex: 0,
                effectKind: 'thread.provider-switch-requested',
                targetKind: 'thread',
                targetId: threadId,
                payloadJson: '{}',
              },
            ],
            now: '2026-01-01T00:00:02.000Z',
          }),
        )
        await harness.run(harness.sql`
          UPDATE projection_threads
          SET provider_switch_json = json_remove(
            provider_switch_json,
            '$.requestId',
            '$.requestSequence',
            '$.sourceModelSelection'
          )
          WHERE thread_id = ${threadId}
        `)
      }
      if (phase !== 'pending')
      {
        const requestId = (await harness.readModel()).threads[0]?.providerSwitch?.requestId
        if (requestId === undefined)
        {
          throw new Error('Expected the provider switch request identity to be projected.')
        }
        await harness.run(
          harness.engine.dispatch({
            type: 'thread.provider.switch.progress',
            commandId: CommandId.make(`cmd-provider-switch-${phase}-progress`),
            threadId,
            requestId,
            phase,
          }),
        )
      }

      await harness.startReactor()
      await harness.drain()

      const thread = (await harness.readModel()).threads[0]
      expect(thread?.providerSwitch).toBeNull()
      expect(thread?.session?.status).toBe('ready')
      const failures = thread?.activities.filter(
        (activity) => activity.kind === 'provider.switch.failed',
      )
      expect(failures).toHaveLength(1)
      expect(failures?.[0]?.payload).toMatchObject({
        reasonCode: 'interrupted-by-restart',
        retryTargetModelSelection: { instanceId: 'claudeAgent', model: 'sonnet' },
      })
      expect(harness.sendTurn).not.toHaveBeenCalled()
      expect(harness.stopSession).not.toHaveBeenCalled()
      if (phase === 'pending')
      {
        const legacyActions = await harness.run(harness.sql<{ readonly status: string }>`
          SELECT status
          FROM orchestration_reactor_actions
          WHERE reactor_id = 'provider-command'
            AND target_id = ${threadId}
            AND effect_kind = 'thread.provider-switch-requested'
        `)
        expect(legacyActions).toEqual([{ status: 'resolved' }])
      }
    },
  )

  it('terminalizes startup recovery before detached cleanup and keeps processing commands', async () =>
  {
    const cleanupGate = await runTest(Deferred.make<void>())
    const harness = await createHarness({
      startReactor: false,
      stopSessionEffect: () => Deferred.await(cleanupGate),
    })
    const threadId = ThreadId.make('thread-1')
    const sourceInstanceId = ProviderInstanceId.make('codex')
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make('codex'),
      providerInstanceId: sourceInstanceId,
      status: 'ready',
      runtimeMode: 'approval-required',
      threadId,
      resumeCursor: { opaque: 'startup-cleanup' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-startup-cleanup-running-session'),
        threadId,
        session: {
          threadId,
          status: 'running',
          providerName: 'codex',
          providerInstanceId: sourceInstanceId,
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-startup-cleanup-switch'),
        threadId,
        targetModelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'sonnet',
        },
        expectedCurrentInstanceId: sourceInstanceId,
      }),
    )
    const requestId = (await harness.readModel()).threads[0]?.providerSwitch?.requestId
    if (requestId === undefined)
    {
      throw new Error('Expected provider switch request identity before startup reconciliation.')
    }

    await harness.startReactor()
    await waitFor(() => harness.stopSession.mock.calls.length === 1)

    const thread = (await harness.readModel()).threads[0]
    expect(thread?.providerSwitch).toBeNull()
    expect(thread?.session?.status).toBe('ready')
    const receipts = await harness.run(harness.sql<{ readonly commandId: string }>`
      SELECT command_id AS "commandId"
      FROM orchestration_command_receipts
      WHERE command_id LIKE 'server:provider-switch-restart-failed:%'
    `)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.commandId).toContain(`"requestId":"${requestId}"`)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.interrupt',
        commandId: CommandId.make('cmd-after-blocked-switch-cleanup'),
        threadId,
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    )
    await harness.drain()
    expect(harness.interruptTurn).toHaveBeenCalledTimes(1)

    await harness.run(Deferred.succeed(cleanupGate, undefined))
  })

  it('isolates startup reconciliation failures by thread', async () =>
  {
    const harness = await createHarness({ startReactor: false })
    const firstThreadId = ThreadId.make('thread-1')
    const secondThreadId = ThreadId.make('thread-2')
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-create-second-reconciliation-thread'),
        threadId: secondThreadId,
        projectId: ProjectId.make('project-1'),
        title: 'Second reconciliation thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: 'default',
        runtimeMode: 'approval-required',
        branch: null,
        worktreePath: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    for (const [index, switchThreadId] of [firstThreadId, secondThreadId].entries())
    {
      await harness.run(
        harness.engine.dispatch({
          type: 'thread.provider.switch',
          commandId: CommandId.make(`cmd-isolated-startup-switch-${index}`),
          threadId: switchThreadId,
          targetModelSelection: {
            instanceId: ProviderInstanceId.make('claudeAgent'),
            model: 'sonnet',
          },
          expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
        }),
      )
    }
    await harness.run(harness.sql`
      UPDATE projection_threads
      SET provider_switch_json = json_set(
        provider_switch_json,
        '$.requestId',
        'stale-startup-request'
      )
      WHERE thread_id = ${firstThreadId}
    `)

    await harness.startReactor()

    const threads = (await harness.readModel()).threads
    expect(threads.find((thread) => thread.id === firstThreadId)?.providerSwitch).not.toBeNull()
    expect(threads.find((thread) => thread.id === secondThreadId)?.providerSwitch).toBeNull()
  })

  it('fails and clears a provider switch when compaction times out', async () =>
  {
    const harness = await createHarness({ withRuntimeIngestion: true })
    const threadId = ThreadId.make('thread-1')
    const provider = ProviderDriverKind.make('codex')
    const providerInstanceId = ProviderInstanceId.make('codex')
    const targetModelSelection = {
      instanceId: ProviderInstanceId.make('claudeAgent'),
      model: 'sonnet',
    }

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-before-switch-timeout'),
        threadId,
        message: {
          messageId: asMessageId('message-before-switch-timeout'),
          role: 'user',
          text: 'establish provider context',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    await harness.emitRuntimeEvent({
      type: 'turn.started',
      eventId: EventId.make('evt-visible-turn-started-before-switch-timeout'),
      provider,
      providerInstanceId,
      threadId,
      turnId: asTurnId('turn-before-switch-timeout'),
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: {},
    })
    await harness.emitRuntimeEvent({
      type: 'turn.completed',
      eventId: EventId.make('evt-visible-turn-completed-before-switch-timeout'),
      provider,
      providerInstanceId,
      threadId,
      turnId: asTurnId('turn-before-switch-timeout'),
      createdAt: '2026-01-01T00:00:02.000Z',
      payload: { state: 'completed' },
    })
    await harness.drainIngestion()
    await waitFor(async () => (await harness.readModel()).threads[0]?.session?.status === 'ready')

    harness.sendTurn.mockImplementation(
      () =>
        Effect.fail(
          new HiddenTurnAwaitError({
            threadId,
            detail: 'Hidden provider turn timed out after 120 seconds.',
          }),
        ) as never,
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-running-null-before-switch-timeout'),
        threadId,
        session: {
          threadId,
          status: 'running',
          providerName: provider,
          providerInstanceId,
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: '2026-01-01T00:00:03.000Z',
        },
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    )
    const failureEvent = harness.nextProviderSwitchFailure()
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-timeout'),
        threadId,
        targetModelSelection,
        expectedCurrentInstanceId: providerInstanceId,
      }),
    )

    const failure = await failureEvent
    expect(failure._tag).toBe('Some')
    if (failure._tag === 'Some' && failure.value.type === 'thread.provider-switch-failed')
    {
      expect(failure.value.payload.reasonCode).toBe('compaction-timeout')
    }
    await harness.drain()
    const thread = (await harness.readModel()).threads[0]
    expect(thread?.providerSwitch).toBeNull()
    expect(thread?.modelSelection.instanceId).toBe(providerInstanceId)
    expect(thread?.activities.some((activity) => activity.kind === 'provider.switch.failed')).toBe(
      true,
    )
    expect(thread?.session?.status).toBe('ready')

    harness.sendTurn.mockImplementation(() =>
      Effect.succeed({
        threadId,
        turnId: asTurnId('turn-switch-timeout-retry'),
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-after-timeout'),
        threadId,
        targetModelSelection,
        expectedCurrentInstanceId: providerInstanceId,
      }),
    )
    await harness.drain()

    expect(harness.sendTurn).toHaveBeenCalledTimes(2)
    expect((await harness.readModel()).threads[0]?.modelSelection).toEqual(targetModelSelection)
  })

  it('executes a provider effect committed while the durable reactor is stopped', async () =>
  {
    const harness = await createHarness({ startReactor: false })
    const threadId = ThreadId.make('thread-1')
    const stoppedAt = (await harness.readModel()).snapshotSequence
    await harness.run(
      harness.delivery.ensureProgress({
        reactorId: 'provider-command',
        operationVersion: 1,
        initialSequence: stoppedAt,
        mode: 'durable',
        now: '2026-01-01T00:00:00.000Z',
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-while-reactor-stopped'),
        threadId,
        message: {
          messageId: asMessageId('message-while-reactor-stopped'),
          role: 'user',
          text: 'deliver after restart',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    expect(harness.sendTurn).not.toHaveBeenCalled()

    await harness.startReactor()
    await harness.drain()

    expect(harness.sendTurn).toHaveBeenCalledTimes(1)
  })

  it('uses the completed switch model when a runtime mode change reopens the session', async () =>
  {
    const harness = await createHarness()
    const threadId = ThreadId.make('thread-1')
    const initialModelSelection = {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5-codex',
    }
    const targetModelSelection = {
      instanceId: ProviderInstanceId.make('claudeAgent'),
      model: 'sonnet',
    }

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-before-provider-switch-cache'),
        threadId,
        message: {
          messageId: asMessageId('user-message-before-provider-switch-cache'),
          role: 'user',
          text: 'seed the current model cache',
          attachments: [],
        },
        modelSelection: initialModelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    await harness.run(harness.stopSession({ threadId }))
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-stop-before-provider-switch-cache'),
        threadId,
        session: {
          threadId,
          status: 'stopped',
          providerName: 'codex',
          providerInstanceId: initialModelSelection.instanceId,
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-cache'),
        threadId,
        targetModelSelection,
        expectedCurrentInstanceId: initialModelSelection.instanceId,
      }),
    )
    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      return readModel.threads[0]?.modelSelection.instanceId === targetModelSelection.instanceId
    })

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-ready-after-provider-switch-cache'),
        threadId,
        session: {
          threadId,
          status: 'ready',
          providerName: 'claudeAgent',
          providerInstanceId: targetModelSelection.instanceId,
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: '2026-01-01T00:00:02.000Z',
        },
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.runtime-mode.set',
        commandId: CommandId.make('cmd-runtime-mode-after-provider-switch-cache'),
        threadId,
        runtimeMode: 'full-access',
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 2)
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      providerInstanceId: targetModelSelection.instanceId,
      modelSelection: targetModelSelection,
    })
  })

  it('closes an aborted hidden turn lifecycle so a provider switch can be retried', async () =>
  {
    const harness = await createHarness({ withRuntimeIngestion: true })
    const threadId = ThreadId.make('thread-1')
    const provider = ProviderDriverKind.make('codex')
    const providerInstanceId = ProviderInstanceId.make('codex')
    const targetModelSelection = {
      instanceId: ProviderInstanceId.make('claudeAgent'),
      model: 'sonnet',
    }

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-visible-turn-before-aborted-switch'),
        threadId,
        message: {
          messageId: asMessageId('user-message-before-aborted-switch'),
          role: 'user',
          text: 'establish provider context',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    await harness.emitRuntimeEvent({
      type: 'turn.started',
      eventId: EventId.make('evt-visible-turn-started-before-aborted-switch'),
      provider,
      providerInstanceId,
      threadId,
      turnId: asTurnId('turn-1'),
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: {},
    })
    await harness.emitRuntimeEvent({
      type: 'turn.completed',
      eventId: EventId.make('evt-visible-turn-completed-before-aborted-switch'),
      provider,
      providerInstanceId,
      threadId,
      turnId: asTurnId('turn-1'),
      createdAt: '2026-01-01T00:00:02.000Z',
      payload: { state: 'completed' },
    })
    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      return readModel.threads[0]?.session?.status === 'ready'
    })

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-before-hidden-abort'),
        threadId,
        targetModelSelection,
        expectedCurrentInstanceId: providerInstanceId,
      }),
    )
    await waitFor(() => harness.sendTurn.mock.calls.length === 2)
    await harness.emitRuntimeEvent({
      type: 'turn.started',
      eventId: EventId.make('evt-hidden-turn-started-before-abort'),
      provider,
      providerInstanceId,
      threadId,
      turnId: asTurnId('turn-2'),
      createdAt: '2026-01-01T00:00:03.000Z',
      payload: {},
    })
    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      const session = readModel.threads[0]?.session
      return session?.status === 'running' && session.activeTurnId === null
    })
    await harness.emitRuntimeEvent({
      type: 'turn.aborted',
      eventId: EventId.make('evt-hidden-turn-aborted'),
      provider,
      providerInstanceId,
      threadId,
      turnId: asTurnId('turn-2'),
      createdAt: '2026-01-01T00:00:04.000Z',
      payload: { reason: 'provider rejected compaction' },
    })
    await harness.drainIngestion()
    await harness.drain()

    const afterAbort = (await harness.readModel()).threads[0]
    expect(afterAbort?.session?.status).toBe('ready')
    expect(afterAbort?.session?.activeTurnId).toBeNull()
    expect(afterAbort?.modelSelection.instanceId).toBe(providerInstanceId)
    await waitFor(() => harness.stopSession.mock.calls.length === 1)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-after-hidden-abort'),
        threadId,
        targetModelSelection,
        expectedCurrentInstanceId: providerInstanceId,
      }),
    )
    await harness.drain()
    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      return readModel.threads[0]?.modelSelection.instanceId === targetModelSelection.instanceId
    })

    expect(harness.sendTurn).toHaveBeenCalledTimes(2)
    expect((await harness.readModel()).threads[0]?.modelSelection).toEqual(targetModelSelection)
  })

  it('injects a pending handoff into provider input without changing the projected message', async () =>
  {
    const harness = await createHarness({ startReactor: false })
    const targetModelSelection = {
      instanceId: ProviderInstanceId.make('claudeAgent'),
      model: 'sonnet',
    }

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-request-seeded'),
        threadId: ThreadId.make('thread-1'),
        targetModelSelection,
        expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
      }),
    )
    const requestId = (await harness.readModel()).threads[0]?.providerSwitch?.requestId
    if (requestId === undefined)
    {
      throw new Error('Expected the seeded provider switch request identity.')
    }
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch.complete',
        commandId: CommandId.make('cmd-provider-switch-complete-seeded'),
        threadId: ThreadId.make('thread-1'),
        requestId,
        sourceModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        modelSelection: targetModelSelection,
        fromInstanceId: ProviderInstanceId.make('codex'),
        fromModel: 'gpt-5-codex',
        handoffText: 'Prior work changed apps/server/src/example.ts.',
      }),
    )
    await harness.startReactor()
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-after-provider-switch'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-after-provider-switch'),
          role: 'user',
          text: 'continue the implementation',
          attachments: [],
        },
        modelSelection: targetModelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      providerInstanceId: targetModelSelection.instanceId,
      modelSelection: targetModelSelection,
    })
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty('resumeCursor')
    const expectedProviderInput = [
      '<prior-conversation-handoff from="gpt-5-codex">',
      'Prior work changed apps/server/src/example.ts.',
      '</prior-conversation-handoff>',
      '',
      'continue the implementation',
    ].join('\n')
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: expectedProviderInput,
    })

    await harness.drain()
    const readModel = await harness.readModel()
    const userMessage = readModel.threads[0]?.messages.find(
      (message) => message.id === asMessageId('user-message-after-provider-switch'),
    )
    expect(userMessage?.text).toBe('continue the implementation')
    const deliveryMarker = readModel.threads[0]?.activities.find(
      (activity) => activity.kind === 'provider.handoff.delivered',
    )
    expect(deliveryMarker?.payload).toMatchObject({
      type: 'provider.handoff.delivered',
      providerSessionIdentity: expect.stringContaining('claudeAgent:'),
    })
  })

  it('marks an accepted handoff unknown when its delivery marker cannot persist', async () =>
  {
    const harness = await createHarness({ startReactor: false })
    const threadId = ThreadId.make('thread-1')
    const targetModelSelection = {
      instanceId: ProviderInstanceId.make('claudeAgent'),
      model: 'sonnet',
    }
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch',
        commandId: CommandId.make('cmd-provider-switch-before-unknown-handoff'),
        threadId,
        targetModelSelection,
        expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
      }),
    )
    const requestId = (await harness.readModel()).threads[0]?.providerSwitch?.requestId
    if (requestId === undefined)
    {
      throw new Error('Expected provider switch request identity before handoff completion.')
    }
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.provider.switch.complete',
        commandId: CommandId.make('cmd-provider-switch-complete-before-unknown-handoff'),
        threadId,
        requestId,
        sourceModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        modelSelection: targetModelSelection,
        fromInstanceId: ProviderInstanceId.make('codex'),
        fromModel: 'gpt-5-codex',
        handoffText: 'Durable context that must not be replayed automatically.',
      }),
    )
    const dispatch = harness.engine.dispatch
    const dispatchSpy = vi
      .spyOn(harness.engine, 'dispatch')
      .mockImplementation((command) =>
        command.type === 'thread.activity.append' &&
        command.activity.kind === 'provider.handoff.delivered'
          ? Effect.die(new Error('Simulated handoff marker persistence failure.'))
          : dispatch(command),
      )
    await harness.startReactor()
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-unknown-handoff-marker'),
        threadId,
        message: {
          messageId: asMessageId('message-unknown-handoff-marker'),
          role: 'user',
          text: 'continue',
          attachments: [],
        },
        modelSelection: targetModelSelection,
        interactionMode: 'default',
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
    )
    await harness.drain()

    const progress = await harness.run(harness.delivery.getProgress('provider-command'))
    if (progress._tag !== 'Some' || progress.value.blockedSequence === null)
    {
      throw new Error('Expected handoff delivery to require manual recovery.')
    }
    const actions = await harness.run(harness.sql<{ readonly status: string }>`
      SELECT status
      FROM orchestration_reactor_actions
      WHERE reactor_id = 'provider-command'
        AND source_sequence = ${progress.value.blockedSequence}
    `)
    expect(actions).toEqual([{ status: 'unknown' }])
    expect(harness.sendTurn).toHaveBeenCalledTimes(1)
    await harness.drain()
    expect(harness.sendTurn).toHaveBeenCalledTimes(1)
    expect(
      (await harness.readModel()).threads[0]?.activities.some(
        (activity) => activity.kind === 'provider.handoff.delivered',
      ),
    ).toBe(false)
    dispatchSpy.mockRestore()
  })

  it('does not start an imported continuation after its instance id moves to another driver', async () =>
  {
    const now = '2026-01-01T00:00:00.000Z'
    const providerInstanceId = ProviderInstanceId.make('shared-provider')
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: providerInstanceId,
        model: 'claude-sonnet-4-5',
      },
      threadOrigin: {
        kind: 'imported',
        source: 'codex-cli',
        sourcePath: '/tmp/imported-session.jsonl',
        contentHash: 'imported-content-hash',
        nativeSessionId: 'native-session',
        providerInstanceId,
        importedAt: now,
      },
      instanceDriverKind: ProviderDriverKind.make('claudeAgent'),
    })
    const continuationActivityId = EventId.make('activity-import-continuation')
    const continuation = {
      state: 'history-only' as const,
      providerInstanceId,
      continuationIdentity: {
        driverKind: ProviderDriverKind.make('codex'),
        continuationKey: `codex:instance:${providerInstanceId}`,
      },
      reason: 'Native continuation could not be verified.',
    }

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.activity.append',
        commandId: CommandId.make('cmd-import-continuation'),
        threadId: ThreadId.make('thread-1'),
        activity: {
          id: continuationActivityId,
          tone: 'info',
          kind: 'task.completed',
          summary: 'Imported continuation state recorded.',
          payload: {
            type: 'import.continuation',
            driverKind: ProviderDriverKind.make('codex'),
            continuation,
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-imported-turn-start'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-imported'),
          role: 'user',
          text: 'continue imported work',
          attachments: [],
        },
        modelSelection: {
          instanceId: providerInstanceId,
          model: 'claude-sonnet-4-5',
        },
        importContinuationConsent: {
          originContentHash: 'imported-content-hash',
          activityId: continuationActivityId,
          driverKind: ProviderDriverKind.make('codex'),
          targetProviderInstanceId: providerInstanceId,
          continuation,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))?.session
          ?.status === 'error'
      )
    })
    expect(harness.startSession).not.toHaveBeenCalled()
    expect(harness.sendTurn).not.toHaveBeenCalled()
    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.session?.lastError).toContain(
      'no longer resolves to its authorized provider continuation source',
    )
  })

  it('passes imported continuation authority through provider start and send', async () =>
  {
    const now = '2026-01-01T00:00:00.000Z'
    const driverKind = ProviderDriverKind.make('codex')
    const providerInstanceId = ProviderInstanceId.make('shared-provider')
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: providerInstanceId,
        model: 'gpt-5-codex',
      },
      threadOrigin: {
        kind: 'imported',
        source: 'codex-cli',
        sourcePath: '/tmp/imported-session.jsonl',
        contentHash: 'imported-content-hash',
        nativeSessionId: 'native-session',
        providerInstanceId,
        importedAt: now,
      },
      instanceDriverKind: driverKind,
    })
    const continuationActivityId = EventId.make('activity-import-continuation-authority')
    const continuation = {
      state: 'history-only' as const,
      providerInstanceId,
      continuationIdentity: {
        driverKind: ProviderDriverKind.make('codex'),
        continuationKey: 'codex:home:/shared-codex',
      },
      reason: 'Native continuation could not be verified.',
    }

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.activity.append',
        commandId: CommandId.make('cmd-import-continuation-authority'),
        threadId: ThreadId.make('thread-1'),
        activity: {
          id: continuationActivityId,
          tone: 'info',
          kind: 'task.completed',
          summary: 'Imported continuation state recorded.',
          payload: {
            type: 'import.continuation',
            driverKind,
            continuation,
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-imported-turn-start-authority'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-imported-authority'),
          role: 'user',
          text: 'continue imported work',
          attachments: [],
        },
        modelSelection: {
          instanceId: providerInstanceId,
          model: 'gpt-5-codex',
        },
        importContinuationConsent: {
          originContentHash: 'imported-content-hash',
          activityId: continuationActivityId,
          driverKind,
          targetProviderInstanceId: providerInstanceId,
          continuation,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    const authority = {
      provider: driverKind,
      providerInstanceId,
      continuationIdentity: continuation.continuationIdentity,
    }
    expect(harness.startSession.mock.calls[0]?.[2]).toEqual(authority)
    expect(harness.sendTurn.mock.calls[0]?.[1]).toEqual(authority)
  })

  effectIt.effect('projects starting before a slow provider session finishes', () =>
    Effect.gen(function* ()
    {
      const releaseStart = yield* Deferred.make<void>()
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      )
      const now = '2026-01-01T00:00:00.000Z'

      yield* harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-slow-provider'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-slow-provider'),
          role: 'user',
          text: 'start slowly',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      })

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1))
      const duringStartup = yield* Effect.promise(() => harness.readModel())
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make('thread-1'))?.session
          ?.status,
      ).toBe('starting')
      expect(harness.sendTurn).not.toHaveBeenCalled()

      yield* Deferred.succeed(releaseStart, undefined)
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1))
    }),
  )

  effectIt.effect('settles a failed provider startup and allows a clean retry', () =>
    Effect.gen(function* ()
    {
      let failStartup = true
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: 'codex',
                    method: 'thread.start',
                    detail: 'deterministic startup failure',
                  }),
                )
              : Effect.succeed(session),
        }),
      )
      const now = '2026-01-01T00:00:00.000Z'

      yield* harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-provider-failure'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-provider-failure'),
          role: 'user',
          text: 'fail once',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      })

      yield* Effect.promise(() =>
        waitFor(async () =>
        {
          const readModel = await harness.readModel()
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))?.session
              ?.status === 'error'
          )
        }),
      )
      let readModel = yield* Effect.promise(() => harness.readModel())
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      expect(thread?.session?.lastError).toContain('deterministic startup failure')
      expect(harness.sendTurn).not.toHaveBeenCalled()

      failStartup = false
      yield* harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-provider-retry'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-provider-retry'),
          role: 'user',
          text: 'retry',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:01.000Z',
      })

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1))
      readModel = yield* Effect.promise(() => harness.readModel())
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      expect(thread?.session?.status).toBe('starting')
      expect(thread?.session?.lastError).toBeNull()
    }),
  )

  it('generates a thread title on the first turn', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'
    const seededTitle = 'Please investigate reconnect failures after restar...'
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: 'Generated title' }))

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-thread-title-seed'),
        threadId: ThreadId.make('thread-1'),
        title: seededTitle,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-title'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-title'),
          role: 'user',
          text: 'Please investigate reconnect failures after restarting the session.',
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1)
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: 'Please investigate reconnect failures after restarting the session.',
    })

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))?.title ===
        'Generated title'
      )
    })
    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.title).toBe('Generated title')
  })

  it('does not overwrite an existing custom thread title on the first turn', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'
    const seededTitle = 'Please investigate reconnect failures after restar...'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-thread-title-custom'),
        threadId: ThreadId.make('thread-1'),
        title: 'Keep this custom title',
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-title-preserve'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-title-preserve'),
          role: 'user',
          text: 'Please investigate reconnect failures after restarting the session.',
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    expect(harness.generateThreadTitle).not.toHaveBeenCalled()

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.title).toBe('Keep this custom title')
  })

  it('matches the client-seeded title even when the outgoing prompt is reformatted', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'
    const seededTitle = 'Fix reconnect spinner on resume'
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: 'Reconnect spinner resume bug',
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-thread-title-formatted-seed'),
        threadId: ThreadId.make('thread-1'),
        title: seededTitle,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-title-formatted'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-title-formatted'),
          role: 'user',
          text: '[effort:high]\\n\\nFix reconnect spinner on resume',
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1)
    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))?.title ===
        'Reconnect spinner resume bug'
      )
    })

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.title).toBe('Reconnect spinner resume bug')
  })

  it('generates a worktree branch name for the first turn', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-thread-branch'),
        threadId: ThreadId.make('thread-1'),
        branch: '456code/1234abcd',
        worktreePath: '/tmp/provider-project-worktree',
      }),
    )

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === 'object' &&
          input !== null &&
          'modelSelection' in input &&
          typeof input.modelSelection === 'object' &&
          input.modelSelection !== null &&
          'model' in input.modelSelection &&
          typeof input.modelSelection.model === 'string'
            ? `feature/${input.modelSelection.model}`
            : 'feature/generated',
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-branch-model'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-branch-model'),
          role: 'user',
          text: 'Add a safer reconnect backoff.',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1)
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1)
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: 'Add a safer reconnect backoff.',
    })
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe('/tmp/provider-project-worktree')
  })

  it.each([
    {
      name: 'codex model options',
      threadModelSelection: undefined as ModelSelection | undefined,
      modelSelection: createModelSelection(ProviderInstanceId.make('codex'), 'gpt-5.3-codex', [
        { id: 'reasoningEffort', value: 'high' },
        { id: 'fastMode', value: true },
      ]),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      setPlanMode: false,
      expectStartSession: true,
    },
    {
      name: 'claude effort options',
      threadModelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-sonnet-4-6',
      } satisfies ModelSelection,
      modelSelection: createModelSelection(
        ProviderInstanceId.make('claudeAgent'),
        'claude-sonnet-4-6',
        [{ id: 'effort', value: 'max' }],
      ),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      setPlanMode: false,
      expectStartSession: true,
    },
    {
      name: 'claude fast mode options',
      threadModelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-opus-4-6',
      } satisfies ModelSelection,
      modelSelection: createModelSelection(
        ProviderInstanceId.make('claudeAgent'),
        'claude-opus-4-6',
        [{ id: 'fastMode', value: true }],
      ),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      setPlanMode: false,
      expectStartSession: true,
    },
    {
      name: 'plan interaction mode',
      threadModelSelection: undefined as ModelSelection | undefined,
      modelSelection: undefined as ModelSelection | undefined,
      interactionMode: 'plan' as const,
      setPlanMode: true,
      expectStartSession: false,
    },
  ])(
    'forwards $name through session start and turn send',
    async ({
      name: caseName,
      threadModelSelection,
      modelSelection,
      interactionMode,
      setPlanMode,
      expectStartSession,
    }) =>
    {
      const harness = await createHarness(
        threadModelSelection ? { threadModelSelection } : undefined,
      )
      const now = '2026-01-01T00:00:00.000Z'
      const suffix = caseName.replace(/\s+/g, '-')

      if (setPlanMode)
      {
        await harness.run(
          harness.engine.dispatch({
            type: 'thread.interaction-mode.set',
            commandId: CommandId.make(`cmd-interaction-mode-set-${suffix}`),
            threadId: ThreadId.make('thread-1'),
            interactionMode: 'plan',
            createdAt: now,
          }),
        )
      }

      await harness.run(
        harness.engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make(`cmd-turn-start-${suffix}`),
          threadId: ThreadId.make('thread-1'),
          message: {
            messageId: asMessageId(`user-message-${suffix}`),
            role: 'user',
            text: `hello ${suffix}`,
            attachments: [],
          },
          ...(modelSelection ? { modelSelection } : {}),
          interactionMode,
          runtimeMode: 'approval-required',
          createdAt: now,
        }),
      )

      await waitFor(() => harness.sendTurn.mock.calls.length === 1)
      if (expectStartSession)
      {
        await waitFor(() => harness.startSession.mock.calls.length === 1)
        expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({ modelSelection })
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          threadId: ThreadId.make('thread-1'),
          modelSelection,
        })
      }
      else
      {
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          threadId: ThreadId.make('thread-1'),
          interactionMode: 'plan',
        })
      }
    },
  )

  it('preserves the active session model when in-session model switching is unsupported', async () =>
  {
    const harness = await createHarness({ sessionModelSwitch: 'unsupported' })
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-unsupported-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-unsupported-1'),
          role: 'user',
          text: 'first',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-unsupported-2'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-unsupported-2'),
          role: 'user',
          text: 'second',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 2)

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make('thread-1'),
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5-codex',
      },
    })
  })

  effectIt.effect(
    'rejects changing models after start when the provider requires a new thread',
    () =>
      Effect.gen(function* ()
      {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        )
        const now = '2026-01-01T00:00:00.000Z'

        yield* harness.engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make('cmd-turn-start-restricted-1'),
          threadId: ThreadId.make('thread-1'),
          message: {
            messageId: asMessageId('user-message-restricted-1'),
            role: 'user',
            text: 'first',
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: now,
        })

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1))

        yield* harness.engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make('cmd-turn-start-restricted-2'),
          threadId: ThreadId.make('thread-1'),
          message: {
            messageId: asMessageId('user-message-restricted-2'),
            role: 'user',
            text: 'second',
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5.1-codex',
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: now,
        })

        yield* Effect.promise(() =>
          waitFor(async () =>
          {
            const readModel = await harness.readModel()
            const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
            return (
              thread?.activities.some(
                (activity) => activity.kind === 'provider.turn.start.failed',
              ) ?? false
            )
          }),
        )

        expect(harness.sendTurn).toHaveBeenCalledTimes(1)
        const readModel = yield* Effect.promise(() => harness.readModel())
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
        expect(
          thread?.activities.find((activity) => activity.kind === 'provider.turn.start.failed'),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              'cannot switch models after the conversation has started',
            ),
          },
        })
      }),
  )

  it('starts a first turn on the requested provider instance even when it differs from the thread model', async () =>
  {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5-codex' },
    })
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-provider-first'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-provider-first'),
          role: 'user',
          text: 'hello claude',
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'claude-opus-4-6',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    expect(harness.startSession).toHaveBeenCalledTimes(1)
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make('claudeAgent'),
      providerInstanceId: ProviderInstanceId.make('claudeAgent'),
      modelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-opus-4-6',
      },
    })

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.session?.providerName).toBe('claudeAgent')
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make('claudeAgent'))
    expect(
      thread?.activities.find((activity) => activity.kind === 'provider.turn.start.failed'),
    ).toBeUndefined()
  })

  it('reuses the same provider session when runtime mode is unchanged', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-unchanged-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-unchanged-1'),
          role: 'user',
          text: 'first',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-unchanged-2'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-unchanged-2'),
          role: 'user',
          text: 'second',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 2)
    expect(harness.startSession.mock.calls.length).toBe(1)
    expect(harness.stopSession.mock.calls.length).toBe(0)
  })

  it('restarts an existing Codex thread on a compatible requested instance', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-compatible-codex-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-compatible-codex-1'),
          role: 'user',
          text: 'first',
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-compatible-codex-2'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-compatible-codex-2'),
          role: 'user',
          text: 'second',
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex_work'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 2)

    expect(harness.startSession).toHaveBeenCalledTimes(2)
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make('codex'),
      providerInstanceId: ProviderInstanceId.make('codex_work'),
      resumeCursor: { opaque: 'resume-1' },
    })

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make('codex_work'))
  })

  it('restarts the provider session when the thread workspace changes', async () =>
  {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-sonnet-4-6',
      },
    })
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-workspace-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-workspace-1'),
          role: 'user',
          text: 'first in project root',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: '/tmp/provider-project',
    })

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-thread-worktree-change'),
        threadId: ThreadId.make('thread-1'),
        worktreePath: '/tmp/provider-project-worktree',
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-workspace-2'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-workspace-2'),
          role: 'user',
          text: 'second in worktree',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 2)
    await waitFor(() => harness.sendTurn.mock.calls.length === 2)
    expect(harness.stopSession.mock.calls.length).toBe(0)
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make('thread-1'),
      cwd: '/tmp/provider-project-worktree',
      resumeCursor: { opaque: 'resume-1' },
      modelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-sonnet-4-6',
      },
      runtimeMode: 'approval-required',
    })
  })

  it('restarts claude sessions when claude effort changes', async () =>
  {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-sonnet-4-6',
      },
    })
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-claude-effort-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-claude-effort-1'),
          role: 'user',
          text: 'first claude turn',
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make('claudeAgent'),
          'claude-sonnet-4-6',
          [{ id: 'effort', value: 'medium' }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-claude-effort-2'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-claude-effort-2'),
          role: 'user',
          text: 'second claude turn',
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make('claudeAgent'),
          'claude-sonnet-4-6',
          [{ id: 'effort', value: 'max' }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 2)
    await waitFor(() => harness.sendTurn.mock.calls.length === 2)
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: 'resume-1' },
      modelSelection: createModelSelection(
        ProviderInstanceId.make('claudeAgent'),
        'claude-sonnet-4-6',
        [{ id: 'effort', value: 'max' }],
      ),
    })
  })

  it('restarts the provider session when runtime mode is updated on the thread', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.runtime-mode.set',
        commandId: CommandId.make('cmd-runtime-mode-set-initial-full-access'),
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'full-access',
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-runtime-mode-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-runtime-mode-1'),
          role: 'user',
          text: 'first',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'full-access',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.runtime-mode.set',
        commandId: CommandId.make('cmd-runtime-mode-set-1'),
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      return thread?.runtimeMode === 'approval-required'
    })
    await waitFor(() => harness.startSession.mock.calls.length === 2)
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-runtime-mode-2'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-runtime-mode-2'),
          role: 'user',
          text: 'second',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'full-access',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.sendTurn.mock.calls.length === 2)

    expect(harness.stopSession.mock.calls.length).toBe(0)
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make('thread-1'),
      resumeCursor: { opaque: 'resume-1' },
      runtimeMode: 'approval-required',
    })
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make('thread-1'),
    })

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.session?.threadId).toBe('thread-1')
    expect(thread?.session?.runtimeMode).toBe('approval-required')
  })

  it('does not inject derived model options when restarting claude on runtime mode changes', async () =>
  {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-opus-4-6',
      },
    })
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-runtime-mode-claude'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'claudeAgent',
          runtimeMode: 'full-access',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.runtime-mode.set',
        commandId: CommandId.make('cmd-runtime-mode-set-claude-no-options'),
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-opus-4-6',
      },
      runtimeMode: 'approval-required',
    })
  })

  it('does not stop the active session when restart fails before rebind', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.runtime-mode.set',
        commandId: CommandId.make('cmd-runtime-mode-set-initial-full-access-2'),
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'full-access',
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-restart-failure-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-restart-failure-1'),
          role: 'user',
          text: 'first',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'full-access',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail('simulated restart failure') as never,
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.runtime-mode.set',
        commandId: CommandId.make('cmd-runtime-mode-set-restart-failure'),
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      return thread?.runtimeMode === 'approval-required'
    })
    await waitFor(() => harness.startSession.mock.calls.length === 2)
    await harness.drain()

    expect(harness.stopSession.mock.calls.length).toBe(0)
    expect(harness.sendTurn.mock.calls.length).toBe(1)

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.session?.threadId).toBe('thread-1')
    expect(thread?.session?.runtimeMode).toBe('full-access')
  })

  it('rejects provider changes after a thread is already bound to a session provider', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-provider-switch-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-provider-switch-1'),
          role: 'user',
          text: 'first',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-provider-switch-2'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-provider-switch-2'),
          role: 'user',
          text: 'second',
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'claude-opus-4-6',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      return (
        thread?.activities.some((activity) => activity.kind === 'provider.turn.start.failed') ??
        false
      )
    })

    expect(harness.startSession.mock.calls.length).toBe(1)
    expect(harness.sendTurn.mock.calls.length).toBe(1)
    expect(harness.stopSession.mock.calls.length).toBe(0)

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.session?.threadId).toBe('thread-1')
    expect(thread?.session?.providerName).toBe('codex')
    expect(thread?.session?.runtimeMode).toBe('approval-required')
    expect(
      thread?.activities.find((activity) => activity.kind === 'provider.turn.start.failed'),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    })
  })

  it('rejects cross-driver provider changes after the existing thread session has stopped', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-stopped-provider-switch'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'stopped',
          providerName: 'codex',
          providerInstanceId: ProviderInstanceId.make('codex'),
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-stopped-provider-switch'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-stopped-provider-switch'),
          role: 'user',
          text: 'continue with claude',
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'claude-opus-4-6',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      return (
        thread?.activities.some((activity) => activity.kind === 'provider.turn.start.failed') ??
        false
      )
    })

    expect(harness.startSession.mock.calls.length).toBe(0)
    expect(harness.sendTurn.mock.calls.length).toBe(0)
    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(
      thread?.activities.find((activity) => activity.kind === 'provider.turn.start.failed'),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    })
  })

  it('reacts to thread.turn.interrupt-requested by calling provider interrupt', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: asTurnId('turn-1'),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.interrupt',
        commandId: CommandId.make('cmd-turn-interrupt'),
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId('turn-1'),
        createdAt: now,
      }),
    )

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1)
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: 'thread-1',
    })
  })

  it('starts a fresh session when only projected session state exists', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-stale'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-stale'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-stale'),
          role: 'user',
          text: 'resume codex',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.startSession.mock.calls.length === 1)
    await waitFor(() => harness.sendTurn.mock.calls.length === 1)

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make('thread-1'),
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5-codex',
      },
      runtimeMode: 'approval-required',
    })
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make('thread-1'),
    })
  })

  it('rejects active runtime sessions that are missing provider instance ids', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-missing-instance'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make('codex'),
      status: 'ready',
      runtimeMode: 'approval-required',
      threadId: ThreadId.make('thread-1'),
      cwd: '/tmp/provider-project',
      resumeCursor: { opaque: 'resume-without-instance' },
      createdAt: now,
      updatedAt: now,
    })

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-missing-instance'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('user-message-missing-instance'),
          role: 'user',
          text: 'resume codex',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: now,
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      return (
        thread?.activities.some((activity) => activity.kind === 'provider.turn.start.failed') ??
        false
      )
    })

    expect(harness.startSession.mock.calls.length).toBe(0)
    expect(harness.sendTurn.mock.calls.length).toBe(0)
    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(
      thread?.activities.find((activity) => activity.kind === 'provider.turn.start.failed'),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining('without a provider instance id'),
      },
    })
  })

  it('reacts to thread.approval.respond by forwarding provider approval response', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-for-approval'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.approval.respond',
        commandId: CommandId.make('cmd-approval-respond'),
        threadId: ThreadId.make('thread-1'),
        requestId: asApprovalRequestId('approval-request-1'),
        decision: 'accept',
        createdAt: now,
      }),
    )

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1)
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: 'thread-1',
      requestId: 'approval-request-1',
      decision: 'accept',
    })
    await harness.drain()
    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.approvalOutcomes).toEqual([
      expect.objectContaining({
        requestId: 'approval-request-1',
        status: 'accepted',
        requestedDecision: 'accept',
        decision: 'accept',
        actionId: expect.any(String),
        acceptanceEvidence: expect.objectContaining({
          providerRequestId: 'approval-request-1',
        }),
      }),
    ])
  })

  it('reacts to thread.user-input.respond by forwarding structured user input answers', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-for-user-input'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.user-input.respond',
        commandId: CommandId.make('cmd-user-input-respond'),
        threadId: ThreadId.make('thread-1'),
        requestId: asApprovalRequestId('user-input-request-1'),
        answers: {
          sandbox_mode: 'workspace-write',
        },
        createdAt: now,
      }),
    )

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1)
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: 'thread-1',
      requestId: 'user-input-request-1',
      answers: {
        sandbox_mode: 'workspace-write',
      },
    })
  })

  it('surfaces stale provider approval request failures without faking approval resolution', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make('codex'),
          method: 'session/request_permission',
          detail: 'Unknown pending permission request: approval-request-1',
        }),
      ),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-for-approval-error'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.activity.append',
        commandId: CommandId.make('cmd-approval-requested'),
        threadId: ThreadId.make('thread-1'),
        activity: {
          id: EventId.make('activity-approval-requested'),
          tone: 'approval',
          kind: 'approval.requested',
          summary: 'Command approval requested',
          payload: {
            requestId: 'approval-request-1',
            requestKind: 'command',
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.approval.respond',
        commandId: CommandId.make('cmd-approval-respond-stale'),
        threadId: ThreadId.make('thread-1'),
        requestId: asApprovalRequestId('approval-request-1'),
        decision: 'acceptForSession',
        createdAt: now,
      }),
    )

    await waitFor(async () =>
    {
      const readModel = await harness.readModel()
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      if (!thread) return false
      return thread.activities.some(
        (activity) => activity.kind === 'provider.approval.respond.failed',
      )
    })

    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread).toBeDefined()

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === 'provider.approval.respond.failed',
    )
    expect(failureActivity).toBeDefined()
    expect(failureActivity?.payload).toMatchObject({
      requestId: 'approval-request-1',
      detail: expect.stringContaining('Stale pending approval request: approval-request-1'),
      approvalOutcome: {
        status: 'stale-terminal',
        requestedDecision: 'acceptForSession',
        actionId: expect.any(String),
      },
    })

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === 'approval.resolved' &&
        typeof activity.payload === 'object' &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === 'approval-request-1',
    )
    expect(resolvedActivity).toBeUndefined()
    expect(thread?.approvalOutcomes).toEqual([
      expect.objectContaining({
        requestId: 'approval-request-1',
        status: 'stale-terminal',
        requestedDecision: 'acceptForSession',
      }),
    ])
    await harness.drain()
    const progress = await harness.run(harness.delivery.getProgress('provider-command'))
    expect(progress._tag === 'Some' ? progress.value.blockedSequence : null).toBeNull()
  })

  it('records indeterminate approval delivery as unknown and replays follow-ups idempotently', async () =>
  {
    const harness = await createHarness()
    const now = '2026-01-01T00:00:00.000Z'
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make('codex'),
          method: 'session/request_permission',
          detail: 'Provider transport timed out after invocation.',
        }),
      ),
    )

    await harness.run(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-for-approval-unknown'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.activity.append',
        commandId: CommandId.make('cmd-approval-requested-unknown'),
        threadId: ThreadId.make('thread-1'),
        activity: {
          id: EventId.make('activity-approval-requested-unknown'),
          tone: 'approval',
          kind: 'approval.requested',
          summary: 'Command approval requested',
          payload: { requestId: 'approval-request-unknown', requestKind: 'command' },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    )
    await harness.run(
      harness.engine.dispatch({
        type: 'thread.approval.respond',
        commandId: CommandId.make('cmd-approval-respond-unknown'),
        threadId: ThreadId.make('thread-1'),
        requestId: asApprovalRequestId('approval-request-unknown'),
        decision: 'decline',
        createdAt: now,
      }),
    )
    await harness.drain()

    const blocked = await harness.run(harness.delivery.getProgress('provider-command'))
    expect(blocked._tag).toBe('Some')
    if (blocked._tag !== 'Some' || blocked.value.blockedSequence === null)
    {
      throw new Error('Expected approval delivery to be blocked as unknown.')
    }
    const unknownModel = await harness.readModel()
    const unknownThread = unknownModel.threads.find(
      (entry) => entry.id === ThreadId.make('thread-1'),
    )
    expect(unknownThread?.approvalOutcomes).toEqual([
      expect.objectContaining({
        requestId: 'approval-request-unknown',
        status: 'unknown',
        requestedDecision: 'decline',
      }),
    ])

    const actionId = makeReactorActionId({
      reactorId: 'provider-command',
      sourceSequence: blocked.value.blockedSequence,
      sourceEventId: 'unused-by-action-identity',
      outputIndex: 0,
      effectKind: 'thread.approval-response-requested',
      targetKind: 'thread',
      targetId: 'thread-1',
      operationVersion: 1,
    })
    expect(
      await harness.run(
        harness.delivery.resolve({
          actionId,
          resolution: 'retry',
          operator: 'provider-reactor-test',
          detail: 'confirmed safe to retry',
          now: '2026-01-01T00:01:00.000Z',
        }),
      ),
    ).toBe(true)
    await harness.drain()

    const replayedUnknownModel = await harness.readModel()
    const replayedUnknownThread = replayedUnknownModel.threads.find(
      (entry) => entry.id === ThreadId.make('thread-1'),
    )
    expect(
      replayedUnknownThread?.activities.filter(
        (activity) => activity.kind === 'provider.approval.respond.failed',
      ),
    ).toHaveLength(1)
    expect(harness.respondToRequest).toHaveBeenCalledTimes(2)

    const replayBlocked = await harness.run(harness.delivery.getProgress('provider-command'))
    expect(
      replayBlocked._tag === 'Some' ? replayBlocked.value.blockedSequence : null,
    ).not.toBeNull()
    harness.respondToRequest.mockImplementation(() => Effect.void)
    expect(
      await harness.run(
        harness.delivery.resolve({
          actionId,
          resolution: 'retry',
          operator: 'provider-reactor-test',
          detail: 'provider confirmed the first attempts were not accepted',
          now: '2026-01-01T00:02:00.000Z',
        }),
      ),
    ).toBe(true)
    await harness.drain()

    const recoveredModel = await harness.readModel()
    const recoveredThread = recoveredModel.threads.find(
      (entry) => entry.id === ThreadId.make('thread-1'),
    )
    expect(
      recoveredThread?.activities.filter(
        (activity) => activity.kind === 'provider.approval.respond.failed',
      ),
    ).toHaveLength(1)
    expect(recoveredThread?.approvalOutcomes).toEqual([
      expect.objectContaining({
        requestId: 'approval-request-unknown',
        status: 'accepted',
        requestedDecision: 'decline',
        decision: 'decline',
      }),
    ])
    expect(harness.respondToRequest).toHaveBeenCalledTimes(3)
  })

  effectIt.effect('surfaces non-resumable provider user-input callbacks as stale failures', () =>
    Effect.gen(function* ()
    {
      const harness = yield* Effect.promise(() => createHarness())
      const now = '2026-01-01T00:00:00.000Z'
      harness.respondToUserInput.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make('claudeAgent'),
            method: 'item/tool/respondToUserInput',
            detail: 'Unknown pending Codex user input request: user-input-request-1',
          }),
        ),
      )

      yield* harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-for-user-input-error'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'claudeAgent',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      })

      yield* harness.engine.dispatch({
        type: 'thread.activity.append',
        commandId: CommandId.make('cmd-user-input-requested'),
        threadId: ThreadId.make('thread-1'),
        activity: {
          id: EventId.make('activity-user-input-requested'),
          tone: 'info',
          kind: 'user-input.requested',
          summary: 'User input requested',
          payload: {
            requestId: 'user-input-request-1',
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
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      })

      yield* harness.engine.dispatch({
        type: 'thread.user-input.respond',
        commandId: CommandId.make('cmd-user-input-respond-stale'),
        threadId: ThreadId.make('thread-1'),
        requestId: asApprovalRequestId('user-input-request-1'),
        answers: {
          sandbox_mode: 'workspace-write',
        },
        createdAt: now,
      })

      yield* Effect.promise(() =>
        waitFor(async () =>
        {
          const readModel = await harness.readModel()
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
          if (!thread) return false
          return thread.activities.some(
            (activity) => activity.kind === 'provider.user-input.respond.failed',
          )
        }),
      )

      const readModel = yield* Effect.promise(() => harness.readModel())
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
      expect(thread).toBeDefined()

      const failureActivity = thread?.activities.find(
        (activity) => activity.kind === 'provider.user-input.respond.failed',
      )
      expect(failureActivity).toBeDefined()
      expect(failureActivity?.payload).toMatchObject({
        requestId: 'user-input-request-1',
        detail: expect.stringContaining('Stale pending user-input request: user-input-request-1'),
      })

      const resolvedActivity = thread?.activities.find(
        (activity) =>
          activity.kind === 'user-input.resolved' &&
          typeof activity.payload === 'object' &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === 'user-input-request-1',
      )
      expect(resolvedActivity).toBeUndefined()
    }),
  )

  effectIt.effect(
    'reacts to thread.session.stop by stopping provider session and clearing thread session state',
    () =>
      Effect.gen(function* ()
      {
        const harness = yield* Effect.promise(() => createHarness())
        const now = '2026-01-01T00:00:00.000Z'

        yield* harness.engine.dispatch({
          type: 'thread.session.set',
          commandId: CommandId.make('cmd-session-set-for-stop'),
          threadId: ThreadId.make('thread-1'),
          session: {
            threadId: ThreadId.make('thread-1'),
            status: 'ready',
            providerName: 'codex',
            providerInstanceId: ProviderInstanceId.make('codex_work'),
            runtimeMode: 'approval-required',
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        })

        yield* harness.engine.dispatch({
          type: 'thread.session.stop',
          commandId: CommandId.make('cmd-session-stop'),
          threadId: ThreadId.make('thread-1'),
          createdAt: now,
        })

        yield* Effect.promise(() => waitFor(() => harness.stopSession.mock.calls.length === 1))
        const readModel = yield* Effect.promise(() => harness.readModel())
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
        expect(thread?.session).not.toBeNull()
        expect(thread?.session?.status).toBe('stopped')
        expect(thread?.session?.threadId).toBe('thread-1')
        expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make('codex_work'))
        expect(thread?.session?.activeTurnId).toBeNull()
      }),
  )
})
