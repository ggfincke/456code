// tests/apps/server/orchestration/Layers/CheckpointReactor.test.ts
// verifies checkpoint capture, restore, and imported-backfill event handling

/* oxlint-disable 456code/no-manual-effect-runtime-in-tests -- this suite drives reactor lifecycle and virtual time through one manual ManagedRuntime so capture ordering stays deterministic; it.effect would hide the sequencing under test */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeChildProcess from 'node:child_process'

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
  type ThreadOrigin,
  VcsUnsupportedOperationError,
} from '@t3tools/contracts'
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { it } from '@effect/vitest'
import { afterEach, describe, expect, vi } from 'vite-plus/test'

import * as CheckpointStore from '../../../../../apps/server/src/checkpointing/CheckpointStore.ts'
import * as VcsDriverRegistry from '../../../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../../../../../apps/server/src/vcs/VcsProcess.ts'
import { VcsStatusBroadcaster } from '../../../../../apps/server/src/vcs/VcsStatusBroadcaster.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import { CheckpointReactorLive } from '../../../../../apps/server/src/orchestration/Layers/CheckpointReactor.ts'
import { OrchestrationEngineLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { RuntimeReceiptBusLive } from '../../../../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { OrchestrationReactorDelivery } from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import {
  CheckpointRevertOperations,
  type CheckpointRevertOperation,
} from '../../../../../apps/server/src/persistence/Services/CheckpointRevertOperations.ts'
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { CheckpointReactor } from '../../../../../apps/server/src/orchestration/Services/CheckpointReactor.ts'
import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import {
  ProviderService,
  type ProviderServiceShape,
} from '../../../../../apps/server/src/provider/Services/ProviderService.ts'
import type { ProviderAdapterCapabilities } from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'
import { ProviderAdapterRequestError } from '../../../../../apps/server/src/provider/Errors.ts'
import { checkpointRefForThreadTurn } from '../../../../../apps/server/src/checkpointing/Utils.ts'
import {
  ProposalImplementationAttemptService,
  type BeginImplementationAttemptInput,
} from '../../../../../apps/server/src/proposal/ProposalImplementationAttemptService.ts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import * as WorkspaceEntries from '../../../../../apps/server/src/workspace/WorkspaceEntries.ts'
import * as WorkspacePaths from '../../../../../apps/server/src/workspace/WorkspacePaths.ts'

const asProjectId = (value: string): ProjectId => ProjectId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)
const FIXTURE_TIME_MS = Date.parse('2026-01-01T00:00:00.000Z')
const importedOrigin: ThreadOrigin = {
  kind: 'imported',
  source: 'codex-cli',
  sourcePath: '/tmp/imported-session.jsonl',
  contentHash: 'imported-content-hash',
  nativeSessionId: 'native-session-1',
  providerInstanceId: ProviderInstanceId.make('codex'),
  importedAt: '2026-01-01T00:00:00.000Z',
}

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

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession['provider'] = ProviderDriverKind.make('codex'),
  rollbackCapability?: 'exact' | 'unsupported',
  rollbackFailure?: string,
  // defect rather than typed failure: exercises the durable delivery layer's
  // indeterminate classification, which the typed failure path bypasses
  rollbackDefects = false,
)
{
  const now = '2026-01-01T00:00:00.000Z'
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>())
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) =>
      rollbackDefects
        ? Effect.die(new Error('Provider rollback outcome is ambiguous.'))
        : rollbackFailure === undefined
          ? Effect.void
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: providerName,
                method: 'thread/rollback',
                detail: rollbackFailure,
              }),
            ),
  )

  const unsupported = <A>(): Effect.Effect<A> =>
    Effect.die(new Error('Unsupported provider call in test'))
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            providerInstanceId: ProviderInstanceId.make('codex'),
            status: 'ready',
            runtimeMode: 'full-access',
            threadId: ThreadId.make('thread-1'),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>)
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () =>
      Effect.succeed({
        sessionModelSwitch: 'in-session',
        ...(rollbackCapability === undefined ? {} : { conversationRollback: rollbackCapability }),
      } as ProviderAdapterCapabilities),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    get streamEvents()
    {
      return Stream.fromPubSub(runtimeEventPubSub)
    },
  }

  const emit = (event: LegacyProviderRuntimeEvent): void =>
  {
    // mirror ProviderService.streamEvents stamping: the reactor now fences
    // runtime events by provider instance (megacore U-072/U-073) and this
    // harness bypasses the service boundary that stamps providerInstanceId
    const raw = event as unknown as ProviderRuntimeEvent
    const stamped: ProviderRuntimeEvent = {
      ...raw,
      providerInstanceId: raw.providerInstanceId ?? ProviderInstanceId.make(String(raw.provider)),
    }
    Effect.runSync(PubSub.publish(runtimeEventPubSub, stamped))
  }

  return {
    service,
    rollbackConversation,
    emit,
  }
}

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId
      readonly latestTurn: { readonly turnId: string } | null
      readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>
      readonly activities: ReadonlyArray<{ readonly kind: string }>
    }>
  }>,
  predicate: (thread: {
    latestTurn: { turnId: string } | null
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>
    activities: ReadonlyArray<{ kind: string }>
  }) => boolean,
  timeoutMs = 15_000,
)
{
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>
    activities: ReadonlyArray<{ kind: string }>
  }> =>
  {
    const snapshot = await readModel()
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    if (thread && predicate(thread))
    {
      return thread
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline)
    {
      throw new Error('Timed out waiting for thread state.')
    }
    await Effect.runPromise(Effect.sleep('10 millis'))
    return poll()
  }
  return poll()
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
)
{
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs
  const poll = async () =>
  {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    )
    if (events.some(predicate))
    {
      return events
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline)
    {
      throw new Error('Timed out waiting for orchestration event.')
    }
    await Effect.runPromise(Effect.sleep('10 millis'))
    return poll()
  }
  return poll()
}

async function waitForRevertOperation(
  operations: CheckpointRevertOperations['Service'],
  operationId: string,
  predicate: (operation: CheckpointRevertOperation) => boolean,
  timeoutMs = 15_000,
): Promise<CheckpointRevertOperation>
{
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs
  const poll = async (): Promise<CheckpointRevertOperation> =>
  {
    const operation = await Effect.runPromise(operations.getById(operationId))
    if (Option.isSome(operation) && predicate(operation.value))
    {
      return operation.value
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline)
    {
      throw new Error(`Timed out waiting for checkpoint revert '${operationId}'.`)
    }
    await Effect.runPromise(Effect.sleep('10 millis'))
    return poll()
  }
  return poll()
}

function runGit(cwd: string, args: ReadonlyArray<string>)
{
  return NodeChildProcess.execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
}

function createGitRepository()
{
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 't3-checkpoint-handler-'))
  runGit(cwd, ['init', '--initial-branch=main'])
  runGit(cwd, ['config', 'user.email', 'test@example.com'])
  runGit(cwd, ['config', 'user.name', 'Test User'])
  NodeFS.writeFileSync(NodePath.join(cwd, 'README.md'), 'v1\n', 'utf8')
  runGit(cwd, ['add', '.'])
  runGit(cwd, ['commit', '-m', 'Initial'])
  return cwd
}

function gitRefExists(cwd: string, ref: string): boolean
{
  try
  {
    runGit(cwd, ['show-ref', '--verify', '--quiet', ref])
    return true
  }
  catch
  {
    return false
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string
{
  return runGit(cwd, ['show', `${ref}:${filePath}`])
}

function unsupportedCheckpointStoreCall<A>(): Effect.Effect<A>
{
  return Effect.die(new Error('Unsupported checkpoint store call in test'))
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000)
{
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs
  const poll = async (): Promise<void> =>
  {
    if (gitRefExists(cwd, ref))
    {
      return
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline)
    {
      throw new Error(`Timed out waiting for git ref '${ref}'.`)
    }
    await Effect.runPromise(Effect.sleep('10 millis'))
    return poll()
  }
  return poll()
}

describe('CheckpointReactor', () =>
{
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore.CheckpointStore
    | CheckpointRevertOperations
    | OrchestrationReactorDelivery
    | ProjectionSnapshotQuery
    | ServerConfig
    | SqlClient.SqlClient
    | TestClock.TestClock,
    unknown
  > | null = null
  let scope: Scope.Closeable | null = null
  const tempDirs: string[] = []

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
    while (tempDirs.length > 0)
    {
      const dir = tempDirs.pop()
      if (dir)
      {
        NodeFS.rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  async function createHarness(options?: {
    readonly hasSession?: boolean
    readonly seedFilesystemCheckpoints?: boolean
    readonly projectWorkspaceRoot?: string
    readonly threadWorktreePath?: string | null
    readonly providerSessionCwd?: string
    readonly providerName?: ProviderDriverKind
    readonly rollbackCapability?: 'exact' | 'unsupported'
    readonly rollbackFailure?: string
    readonly gitStatusRefreshCalls?: Array<string>
    readonly threadOrigin?: ThreadOrigin
    readonly checkpointStoreCalls?: Array<string>
    readonly rollbackFails?: boolean
    readonly implementationAttemptSelection?: {
      readonly revisions: ReadonlyArray<{
        readonly revision: number
        readonly createdAt: string
      }>
      readonly beginInputs: Array<BeginImplementationAttemptInput>
      readonly consumedRevisions: Array<number>
    }
    readonly startReactor?: boolean
  })
  {
    const cwd = createGitRepository()
    tempDirs.push(cwd)
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make('codex'),
      options?.rollbackCapability,
      options?.rollbackFailure,
      options?.rollbackFails ?? false,
    )
    const checkpointRevertOperationsLayer = CheckpointRevertOperationsLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    )
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(AttachmentLifecycleRepositoryLive),
      Layer.provide(checkpointRevertOperationsLayer),
      Layer.provide(SqlitePersistenceMemory),
    )
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(AttachmentLifecycleRepositoryLive),
      Layer.provideMerge(CheckpointRevertOperationsLive),
      Layer.provide(SqlitePersistenceMemory),
    )

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: 't3-checkpoint-reactor-test-',
    })
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die('getStatus should not be called in this test'),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() =>
        {
          options?.gitStatusRefreshCalls?.push(cwd)
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName: 'main',
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die('refreshStatus should not be called in this test'),
      streamStatus: () => Stream.empty,
    })
    const liveCheckpointStoreLayer = CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
    )
    const checkpointStoreCalls = options?.checkpointStoreCalls
    const checkpointRefs = new Set<string>()
    const checkpointStoreLayer =
      checkpointStoreCalls === undefined
        ? liveCheckpointStoreLayer
        : Layer.succeed(
            CheckpointStore.CheckpointStore,
            CheckpointStore.CheckpointStore.of({
              isGitRepository: () =>
                Effect.sync(() =>
                  {
                  checkpointStoreCalls.push('isGitRepository')
                  return true
                }),
              captureCheckpoint: ({ checkpointRef, expected }) =>
                Effect.sync(() =>
                  {
                  checkpointStoreCalls.push('captureCheckpoint')
                  // mirror the driver's compare-and-swap: a capture that
                  // required an absent ref loses to whoever published first
                  if (expected?.kind === 'absent' && checkpointRefs.has(checkpointRef))
                    {
                    return { outcome: 'lost-race', commitOid: `commit:${checkpointRef}` } as const
                  }
                  checkpointRefs.add(checkpointRef)
                  return { outcome: 'published', commitOid: `commit:${checkpointRef}` } as const
                }),
              hasCheckpointRef: ({ checkpointRef }) =>
                Effect.sync(() =>
                  {
                  checkpointStoreCalls.push('hasCheckpointRef')
                  return checkpointRefs.has(checkpointRef)
                }),
              restoreCheckpoint: () =>
                Effect.sync(() =>
                  {
                  checkpointStoreCalls.push('restoreCheckpoint')
                  return false
                }),
              stageCheckpointTree: () => unsupportedCheckpointStoreCall(),
              verifyRestorePreconditions: () => unsupportedCheckpointStoreCall(),
              applyStagedRestore: () => unsupportedCheckpointStoreCall(),
              postVerifyRestore: () => unsupportedCheckpointStoreCall(),
              diffCheckpoints: () =>
                Effect.sync(() =>
                  {
                  checkpointStoreCalls.push('diffCheckpoints')
                  return ''
                }),
              deleteCheckpointRefs: () =>
                Effect.sync(() =>
                  {
                  checkpointStoreCalls.push('deleteCheckpointRefs')
                }),
            }),
          )
    const implementationAttemptSelection = options?.implementationAttemptSelection
    const implementationAttemptLayer =
      implementationAttemptSelection === undefined
        ? Layer.empty
        : Layer.succeed(
            ProposalImplementationAttemptService,
            ProposalImplementationAttemptService.of({
              begin: (input) =>
                Effect.sync(() =>
                  {
                  implementationAttemptSelection.beginInputs.push(input)
                  const revision = implementationAttemptSelection.revisions
                    .filter((entry) => entry.createdAt <= input.createdAt)
                    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
                    .at(-1)
                  if (revision)
                    {
                    implementationAttemptSelection.consumedRevisions.push(revision.revision)
                  }
                  return null
                }),
              complete: () => Effect.succeed(null),
              latestForProposal: () => Effect.succeed(null),
            }),
          )

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(checkpointRevertOperationsLayer),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(VcsDriverRegistry.layer),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(implementationAttemptLayer),
    )

    runtime = ManagedRuntime.make(layer)
    await runtime.runPromise(TestClock.setTime(FIXTURE_TIME_MS))
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery))
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor))
    const checkpointStore = await runtime.runPromise(
      Effect.service(CheckpointStore.CheckpointStore),
    )
    const checkpointRevertOperations = await runtime.runPromise(
      Effect.service(CheckpointRevertOperations),
    )
    const serverConfig = await runtime.runPromise(Effect.service(ServerConfig))
    const delivery = await runtime.runPromise(Effect.service(OrchestrationReactorDelivery))
    scope = await Effect.runPromise(Scope.make('sequential'))
    const reactorScope = scope
    const startReactor = async () =>
    {
      await Effect.runPromise(reactor.start().pipe(Scope.provide(reactorScope)))
      await Effect.runPromise(Effect.sleep('10 millis'))
    }
    if (options?.startReactor ?? true)
    {
      await startReactor()
    }
    const drain = () => Effect.runPromise(reactor.drain)
    const readDurableState = () =>
      runtime!.runPromise(
        Effect.gen(function* ()
        {
          const sql = yield* SqlClient.SqlClient
          const actions = yield* sql<{
            readonly sourceSequence: number
            readonly effectKind: string
            readonly status: string
          }>`
            SELECT
              source_sequence AS "sourceSequence",
              effect_kind AS "effectKind",
              status
            FROM orchestration_reactor_actions
            WHERE reactor_id = 'checkpoint-domain'
            ORDER BY source_sequence ASC, output_index ASC
          `
          const progress = yield* sql<{
            readonly cursorSequence: number
            readonly blockedSequence: number | null
          }>`
            SELECT
              cursor_sequence AS "cursorSequence",
              blocked_sequence AS "blockedSequence"
            FROM orchestration_reactor_progress
            WHERE reactor_id = 'checkpoint-domain'
          `
          return { actions, progress: progress[0] }
        }),
      )

    const createdAt = '2026-01-01T00:00:00.000Z'
    await Effect.runPromise(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-create'),
        projectId: asProjectId('project-1'),
        title: 'Test Project',
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
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
        title: 'Thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        ...(options?.threadOrigin === undefined ? {} : { origin: options.threadOrigin }),
        createdAt,
      }),
    )

    if (options?.seedFilesystemCheckpoints ?? true)
    {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0),
        }),
      )
      NodeFS.writeFileSync(NodePath.join(cwd, 'README.md'), 'v2\n', 'utf8')
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1),
        }),
      )
      NodeFS.writeFileSync(NodePath.join(cwd, 'README.md'), 'v3\n', 'utf8')
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 2),
        }),
      )
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      snapshotQuery,
      provider,
      cwd,
      checkpointStore,
      checkpointRevertOperations,
      serverConfig,
      delivery,
      drain,
      startReactor,
      readDurableState,
    }
  }

  async function persistImplementationTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly requestedAt: string
      readonly providerStartedAt: string
      readonly turnId: TurnId
    },
  )
  {
    const threadId = ThreadId.make('thread-1')
    const planId = 'plan-thread-1'
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.proposed-plan.upsert',
        commandId: CommandId.make('cmd-plan-upsert-implementation'),
        threadId,
        proposedPlan: {
          id: planId,
          turnId: null,
          planMarkdown: '# Implementation plan',
          implementedAt: null,
          implementationThreadId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-implementation'),
        threadId,
        message: {
          messageId: MessageId.make('message-implementation'),
          role: 'user',
          text: 'implement this plan',
          attachments: [],
        },
        sourceProposedPlan: {
          threadId,
          planId,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: input.requestedAt,
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-implementation'),
        threadId,
        session: {
          threadId,
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: input.turnId,
          lastError: null,
          updatedAt: input.providerStartedAt,
        },
        createdAt: input.providerStartedAt,
      }),
    )
    await waitForThread(harness.readModel, (thread) => thread.latestTurn?.turnId === input.turnId)
    return { threadId, planId }
  }

  async function seedRevertTimeline(
    harness: Awaited<ReturnType<typeof createHarness>>,
    commandPrefix: string,
  )
  {
    const createdAt = '2026-01-01T00:00:00.000Z'
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make(`${commandPrefix}-session`),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          providerInstanceId: ProviderInstanceId.make('codex'),
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )
    for (const turnCount of [1, 2])
    {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: 'thread.turn.diff.complete',
          commandId: CommandId.make(`${commandPrefix}-diff-${turnCount}`),
          threadId: ThreadId.make('thread-1'),
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), turnCount),
          status: 'ready',
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      )
    }
  }

  it('captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed', async () =>
  {
    const harness = await createHarness({ seedFilesystemCheckpoints: false })
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-capture'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    harness.provider.emit({
      type: 'turn.started',
      eventId: EventId.make('evt-turn-started-1'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-1'),
    })
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0))

    NodeFS.writeFileSync(NodePath.join(harness.cwd, 'README.md'), 'v2\n', 'utf8')
    harness.provider.emit({
      type: 'turn.completed',
      eventId: EventId.make('evt-turn-completed-1'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-1'),
      payload: { state: 'completed' },
    })

    await waitForEvent(harness.engine, (event) => event.type === 'thread.turn-diff-completed')
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === 'turn-1' && entry.checkpoints.length === 1,
    )
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1)
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0)),
    ).toBe(true)
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1)),
    ).toBe(true)
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0),
        'README.md',
      ),
    ).toBe('v1\n')
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1),
        'README.md',
      ),
    ).toBe('v2\n')
  })

  it('binds implementation revision selection to the user request time', async () =>
  {
    const requestedAt = '2026-01-01T00:01:00.000Z'
    const providerStartedAt = '2026-01-01T00:02:00.000Z'
    const beginInputs: BeginImplementationAttemptInput[] = []
    const consumedRevisions: number[] = []
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      implementationAttemptSelection: {
        revisions: [
          { revision: 1, createdAt: '2026-01-01T00:00:30.000Z' },
          { revision: 2, createdAt: '2026-01-01T00:01:30.000Z' },
        ],
        beginInputs,
        consumedRevisions,
      },
    })
    const threadId = ThreadId.make('thread-1')
    const turnId = asTurnId('turn-implementation')
    const { planId } = await persistImplementationTurn(harness, {
      requestedAt,
      providerStartedAt,
      turnId,
    })
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0))

    harness.provider.emit({
      type: 'turn.started',
      eventId: EventId.make('evt-turn-started-implementation'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: providerStartedAt,
      threadId,
      turnId,
    })
    await harness.drain()

    expect(beginInputs).toHaveLength(1)
    expect(beginInputs[0]).toMatchObject({
      implementationThreadId: threadId,
      implementationTurnId: turnId,
      sourceProposedPlan: {
        threadId,
        planId,
      },
      createdAt: requestedAt,
    })
    expect(consumedRevisions).toEqual([1])
  })

  it('uses the persisted request time when a fresh reactor observes runtime start', async () =>
  {
    const requestedAt = '2026-01-01T00:01:00.000Z'
    const providerStartedAt = '2026-01-01T00:02:00.000Z'
    const beginInputs: BeginImplementationAttemptInput[] = []
    const consumedRevisions: number[] = []
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      startReactor: false,
      implementationAttemptSelection: {
        revisions: [
          { revision: 1, createdAt: '2026-01-01T00:00:30.000Z' },
          { revision: 2, createdAt: '2026-01-01T00:01:30.000Z' },
        ],
        beginInputs,
        consumedRevisions,
      },
    })
    const turnId = asTurnId('turn-implementation')
    const { threadId, planId } = await persistImplementationTurn(harness, {
      requestedAt,
      providerStartedAt,
      turnId,
    })
    await harness.startReactor()

    harness.provider.emit({
      type: 'turn.started',
      eventId: EventId.make('evt-turn-started-implementation-after-restart'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: providerStartedAt,
      threadId,
      turnId,
    })
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0))
    await harness.drain()

    expect(beginInputs).toHaveLength(1)
    expect(beginInputs[0]).toMatchObject({
      implementationThreadId: threadId,
      implementationTurnId: turnId,
      sourceProposedPlan: {
        threadId,
        planId,
      },
      createdAt: requestedAt,
    })
    expect(consumedRevisions).toEqual([1])
  })

  it('refreshes local git status state on turn completion using the session cwd', async () =>
  {
    const gitStatusRefreshCalls: string[] = []
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    })

    harness.provider.emit({
      type: 'turn.completed',
      eventId: EventId.make('evt-turn-completed-refresh-local-status'),
      provider: ProviderDriverKind.make('codex'),
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-refresh-local-status'),
      payload: { state: 'completed' },
    })

    await harness.drain()

    expect(gitStatusRefreshCalls).toEqual([harness.cwd])
  })

  it('ignores auxiliary thread turn completion while primary turn is active', async () =>
  {
    const harness = await createHarness({ seedFilesystemCheckpoints: false })
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-primary-running'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: asTurnId('turn-main'),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    harness.provider.emit({
      type: 'turn.started',
      eventId: EventId.make('evt-turn-started-main'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-main'),
    })
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0))

    NodeFS.writeFileSync(NodePath.join(harness.cwd, 'README.md'), 'v2\n', 'utf8')

    harness.provider.emit({
      type: 'turn.completed',
      eventId: EventId.make('evt-turn-completed-aux'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-aux'),
      payload: { state: 'completed' },
    })

    await harness.drain()
    const midReadModel = await harness.readModel()
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(midThread?.checkpoints).toHaveLength(0)

    harness.provider.emit({
      type: 'turn.completed',
      eventId: EventId.make('evt-turn-completed-main'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-main'),
      payload: { state: 'completed' },
    })

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === 'turn-main' && entry.checkpoints.length === 1,
    )
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1)
  })

  it('appends capture failure activity when turn diff summary cannot be derived', async () =>
  {
    const harness = await createHarness({ seedFilesystemCheckpoints: false })
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-missing-baseline-diff'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    harness.provider.emit({
      type: 'turn.completed',
      eventId: EventId.make('evt-turn-completed-missing-baseline'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-missing-baseline'),
      payload: { state: 'completed' },
    })

    await waitForEvent(harness.engine, (event) => event.type === 'thread.turn-diff-completed')
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === 'checkpoint.capture.failed'),
    )

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1)
    expect(
      thread.activities.some((activity) => activity.kind === 'checkpoint.capture.failed'),
    ).toBe(true)
  })

  it('captures pre-turn baseline from project workspace root when thread worktree is unset', async () =>
  {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    })

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-for-baseline'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: MessageId.make('message-user-1'),
          role: 'user',
          text: 'start turn',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )

    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0))
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0),
        'README.md',
      ),
    ).toBe('v1\n')
  })

  it.effect('skips checkpoint work for imported historical backfill', () =>
    Effect.gen(function* ()
    {
      const checkpointStoreCalls: string[] = []
      const harness = yield* Effect.promise(() =>
        createHarness({
          hasSession: false,
          seedFilesystemCheckpoints: false,
          threadWorktreePath: null,
          threadOrigin: importedOrigin,
          checkpointStoreCalls,
        }),
      )
      const getThreadDetailById = vi.spyOn(harness.snapshotQuery, 'getThreadDetailById')

      yield* harness.engine.dispatch({
        type: 'thread.messages.import',
        commandId: CommandId.make('cmd-import-history'),
        threadId: ThreadId.make('thread-1'),
        messages: [
          {
            messageId: MessageId.make('message-imported-user-1'),
            role: 'user',
            text: 'first historical prompt',
            createdAt: '2025-12-01T00:00:00.000Z',
          },
          {
            messageId: MessageId.make('message-imported-user-2'),
            role: 'user',
            text: 'second historical prompt',
            createdAt: '2025-12-01T00:01:00.000Z',
          },
          {
            messageId: MessageId.make('message-imported-user-3'),
            role: 'user',
            text: 'third historical prompt',
            createdAt: '2025-12-01T00:02:00.000Z',
          },
        ],
        activities: [
          {
            id: EventId.make('activity-imported-history'),
            tone: 'info',
            kind: 'import.note',
            summary: 'Imported history',
            payload: {},
            turnId: null,
            createdAt: '2025-12-01T00:03:00.000Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      yield* Effect.promise(() => harness.drain())

      expect(checkpointStoreCalls).toEqual([])
      expect(getThreadDetailById).not.toHaveBeenCalled()
    }),
  )

  it.effect('retains pre-turn checkpoint capture for native thread messages', () =>
    Effect.gen(function* ()
    {
      const checkpointStoreCalls: string[] = []
      const harness = yield* Effect.promise(() =>
        createHarness({
          hasSession: false,
          seedFilesystemCheckpoints: false,
          threadWorktreePath: null,
          checkpointStoreCalls,
        }),
      )

      yield* harness.engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-native-turn-start'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: MessageId.make('message-native-user-1'),
          role: 'user',
          text: 'native prompt',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      yield* Effect.promise(() => harness.drain())

      expect(checkpointStoreCalls.filter((call) => call === 'captureCheckpoint')).toHaveLength(1)
      expect(checkpointStoreCalls).toContain('hasCheckpointRef')
    }),
  )

  it('captures turn completion checkpoint from project workspace root when provider session cwd is unavailable', async () =>
  {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    })
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-missing-provider-cwd'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'running',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: asTurnId('turn-missing-cwd'),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    NodeFS.writeFileSync(NodePath.join(harness.cwd, 'README.md'), 'v2\n', 'utf8')
    harness.provider.emit({
      type: 'turn.completed',
      eventId: EventId.make('evt-turn-completed-missing-provider-cwd'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-missing-cwd'),
      payload: { state: 'completed' },
    })

    await waitForEvent(harness.engine, (event) => event.type === 'thread.turn-diff-completed')
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1)),
    ).toBe(true)
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1),
        'README.md',
      ),
    ).toBe('v2\n')
  })

  it('ignores non-v2 checkpoint.captured runtime events', async () =>
  {
    const harness = await createHarness()
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-checkpoint-captured'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    harness.provider.emit({
      type: 'checkpoint.captured',
      eventId: EventId.make('evt-checkpoint-captured-3'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-3'),
      turnCount: 3,
      status: 'completed',
    })

    await harness.drain()
    const readModel = await harness.readModel()
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make('thread-1'))
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    )
  })

  it('continues processing runtime events after a single checkpoint runtime failure', async () =>
  {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), 't3-checkpoint-runtime-non-repo-'),
    )
    tempDirs.push(nonRepositorySessionCwd)

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    })
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-non-repo-runtime'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    harness.provider.emit({
      type: 'turn.completed',
      eventId: EventId.make('evt-runtime-capture-failure'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-runtime-failure'),
      payload: { state: 'completed' },
    })

    harness.provider.emit({
      type: 'turn.started',
      eventId: EventId.make('evt-turn-started-after-runtime-failure'),
      provider: ProviderDriverKind.make('codex'),

      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: ThreadId.make('thread-1'),
      turnId: asTurnId('turn-after-runtime-failure'),
    })

    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0))
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0)),
    ).toBe(true)
  })

  it('replays a placeholder capture event appended before start', async () =>
  {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      startReactor: false,
    })
    const checkpointRef = checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1)
    // a reactor that has run before: its cursor is already established, so an
    // event appended while it was stopped is still owed delivery
    await Effect.runPromise(
      harness.delivery.ensureProgress({
        reactorId: 'checkpoint-domain',
        operationVersion: 1,
        initialSequence: 0,
        mode: 'durable',
        now: '2026-01-01T00:00:00.000Z',
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.diff.complete',
        commandId: CommandId.make('cmd-stopped-placeholder-capture'),
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId('turn-stopped-capture'),
        completedAt: '2026-01-01T00:00:00.000Z',
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 0),
        status: 'missing',
        files: [],
        checkpointTurnCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )

    await harness.startReactor()
    await harness.drain()

    expect(gitRefExists(harness.cwd, checkpointRef)).toBe(true)
    const durable = await harness.readDurableState()
    expect(
      durable.actions.some(
        (action) =>
          action.effectKind === 'checkpoint.placeholder.capture' && action.status === 'succeeded',
      ),
    ).toBe(true)
  })

  it('executes provider revert and emits thread.reverted for checkpoint revert requests', async () =>
  {
    const harness = await createHarness()
    const createdAt = '2026-01-01T00:00:00.000Z'
    const phases: string[] = []
    const admit = harness.checkpointRevertOperations.admit
    const casTransition = harness.checkpointRevertOperations.casTransition
    const recordProviderOutcome = harness.checkpointRevertOperations.recordProviderOutcome
    const recordStaleRefs = harness.checkpointRevertOperations.recordStaleRefs
    vi.spyOn(harness.checkpointRevertOperations, 'admit').mockImplementation((input) =>
    {
      phases.push('admitted')
      return admit(input)
    })
    vi.spyOn(harness.checkpointRevertOperations, 'casTransition').mockImplementation((input) =>
    {
      if (input.expectedPhase !== input.nextPhase)
      {
        phases.push(input.nextPhase)
      }
      return casTransition(input)
    })
    vi.spyOn(harness.checkpointRevertOperations, 'recordProviderOutcome').mockImplementation(
      (input) =>
      {
        phases.push('provider-outcome-recorded')
        return recordProviderOutcome(input)
      },
    )
    vi.spyOn(harness.checkpointRevertOperations, 'recordStaleRefs').mockImplementation((input) =>
    {
      phases.push('cleanup-pending')
      return recordStaleRefs(input)
    })

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.diff.complete',
        commandId: CommandId.make('cmd-diff-1'),
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId('turn-1'),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1),
        status: 'ready',
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.diff.complete',
        commandId: CommandId.make('cmd-diff-2'),
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId('turn-2'),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 2),
        status: 'ready',
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    )

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-revert-request'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 1,
        createdAt,
      }),
    )

    await waitForEvent(harness.engine, (event) => event.type === 'thread.reverted')
    const thread = await waitForThread(harness.readModel, (entry) => entry.checkpoints.length === 1)

    expect(thread.latestTurn?.turnId).toBe('turn-1')
    expect(thread.checkpoints).toHaveLength(1)
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1)
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1)
    // rollback is now fenced by the bound provider instance (megacore U-073)
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make('thread-1'),
      numTurns: 1,
      expectedProviderInstanceId: ProviderInstanceId.make('codex'),
    })
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, 'README.md'), 'utf8')).toBe('v2\n')
    const operation = await waitForRevertOperation(
      harness.checkpointRevertOperations,
      'checkpoint-revert:cmd-revert-request',
      (candidate) => candidate.phase === 'completed',
    )
    expect(operation.providerOutcome).toBe('exact')
    expect(operation.cleanupStatus).toBe('completed')
    // stale-ref deletion is the last, post-projection cleanup step, so it is
    // only guaranteed once the operation reaches 'completed'
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 2)),
    ).toBe(false)
    expect(phases).toEqual([
      'admitted',
      'target-staged',
      'restore-ready',
      'restore-started',
      'filesystem-restored',
      'provider-pending',
      'provider-outcome-recorded',
      'projection-finalized',
      'cleanup-pending',
      'completed',
    ])
  })

  it('resumes a restore-started operation and converges the staged filesystem restore', async () =>
  {
    const harness = await createHarness({ startReactor: false })
    const createdAt = '2026-01-01T00:00:00.000Z'
    const threadId = ThreadId.make('thread-1')
    const targetRef = checkpointRefForThreadTurn(threadId, 1)
    const operationId = 'checkpoint-revert:cmd-resume-mid-restore'
    await seedRevertTimeline(harness, 'cmd-resume-mid-restore')

    const stagePath = NodePath.join(
      harness.serverConfig.stateDir,
      'checkpoint-reverts',
      encodeURIComponent(operationId),
    )
    NodeFS.mkdirSync(stagePath, { recursive: true })
    const verification = await Effect.runPromise(
      harness.checkpointStore.stageCheckpointTree({
        cwd: harness.cwd,
        ref: targetRef,
        stagePath,
      }),
    )
    const commonDirOutput = runGit(harness.cwd, ['rev-parse', '--git-common-dir']).trim()
    const repositoryCommonDir = NodePath.isAbsolute(commonDirOutput)
      ? commonDirOutput
      : NodePath.resolve(harness.cwd, commonDirOutput)
    const admitted = await Effect.runPromise(
      harness.checkpointRevertOperations.admit({
        operationId,
        threadId,
        targetRef,
        targetTurnCount: 1,
        cwd: harness.cwd,
        now: createdAt,
      }),
    )
    const staged = await Effect.runPromise(
      harness.checkpointRevertOperations.casTransition({
        operationId,
        expectedPhase: admitted.phase,
        nextPhase: 'target-staged',
        patch: {
          targetTree: verification.treeOid,
          repositoryCommonDir,
          stagePath,
        },
        now: createdAt,
      }),
    )
    const ready = await Effect.runPromise(
      harness.checkpointRevertOperations.casTransition({
        operationId,
        expectedPhase: staged.phase,
        nextPhase: 'restore-ready',
        now: createdAt,
      }),
    )
    await Effect.runPromise(
      harness.checkpointRevertOperations.casTransition({
        operationId,
        expectedPhase: ready.phase,
        nextPhase: 'restore-started',
        now: createdAt,
      }),
    )
    await Effect.runPromise(
      harness.checkpointStore.applyStagedRestore({
        cwd: harness.cwd,
        ref: targetRef,
        stagePath,
      }),
    )
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, 'README.md'), 'utf8')).toBe('v2\n')

    await harness.startReactor()
    const operation = await waitForRevertOperation(
      harness.checkpointRevertOperations,
      operationId,
      (candidate) => candidate.phase === 'completed',
    )

    expect(operation.providerOutcome).toBe('exact')
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, 'README.md'), 'utf8')).toBe('v2\n')
    expect(NodeFS.existsSync(stagePath)).toBe(false)
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1)
  })

  it('completes with a recorded warning when provider rollback is known unsupported', async () =>
  {
    const harness = await createHarness({ rollbackCapability: 'unsupported' })
    const createdAt = '2026-01-01T00:00:00.000Z'
    await seedRevertTimeline(harness, 'cmd-known-unsupported')

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-known-unsupported-revert'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 1,
        createdAt,
      }),
    )

    const operation = await waitForRevertOperation(
      harness.checkpointRevertOperations,
      'checkpoint-revert:cmd-known-unsupported-revert',
      (candidate) => candidate.phase === 'completed',
    )
    const thread = await waitForThread(
      harness.readModel,
      (candidate) =>
        candidate.checkpoints.length === 1 &&
        candidate.activities.some(
          (activity) => activity.kind === 'checkpoint.revert.provider-diverged',
        ),
    )

    expect(operation.providerOutcome).toBe('known-unsupported')
    expect(thread.latestTurn?.turnId).toBe('turn-1')
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled()
  })

  it('marks an indeterminate provider rollback manual and does not finalize projection', async () =>
  {
    const harness = await createHarness({ rollbackFailure: 'rollback response was lost' })
    const createdAt = '2026-01-01T00:00:00.000Z'
    await seedRevertTimeline(harness, 'cmd-manual-unknown')

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-manual-unknown-revert'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 1,
        createdAt,
      }),
    )

    const operation = await waitForRevertOperation(
      harness.checkpointRevertOperations,
      'checkpoint-revert:cmd-manual-unknown-revert',
      (candidate) => candidate.phase === 'manual-required',
    )
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    )
    const readModel = await harness.readModel()
    const thread = readModel.threads.find((candidate) => candidate.id === ThreadId.make('thread-1'))

    expect(operation.providerOutcome).toBe('manual-unknown')
    expect(operation.manualResumePhase).toBe('provider-outcome-recorded')
    expect(events.some((event) => event.type === 'thread.reverted')).toBe(false)
    expect(thread?.checkpoints).toHaveLength(2)
    expect(
      thread?.activities.some((activity) => activity.kind === 'checkpoint.revert.failed'),
    ).toBe(true)
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, 'README.md'), 'utf8')).toBe('v2\n')
  })

  it('keeps cleanup retryable after projection finalization without undoing restore', async () =>
  {
    const harness = await createHarness()
    const createdAt = '2026-01-01T00:00:00.000Z'
    await seedRevertTimeline(harness, 'cmd-cleanup-retry')
    vi.spyOn(harness.checkpointStore, 'deleteCheckpointRefs').mockImplementation(() =>
      Effect.fail(
        new VcsUnsupportedOperationError({
          operation: 'CheckpointReactor.test.cleanup',
          kind: 'git',
          detail: 'simulated cleanup failure',
        }),
      ),
    )

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-cleanup-retry-revert'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 1,
        createdAt,
      }),
    )

    const operation = await waitForRevertOperation(
      harness.checkpointRevertOperations,
      'checkpoint-revert:cmd-cleanup-retry-revert',
      (candidate) =>
        candidate.phase === 'cleanup-pending' && candidate.cleanupStatus === 'retryable',
    )
    const thread = await waitForThread(
      harness.readModel,
      (candidate) => candidate.checkpoints.length === 1,
    )

    expect(operation.projectionStatus).toBe('finalized')
    expect(operation.stagePath && NodeFS.existsSync(operation.stagePath)).toBe(true)
    expect(thread.latestTurn?.turnId).toBe('turn-1')
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, 'README.md'), 'utf8')).toBe('v2\n')
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make('thread-1'), 2)),
    ).toBe(true)
  })

  it('rejects a second revert while the thread has an active journal operation', async () =>
  {
    const harness = await createHarness()
    const createdAt = '2026-01-01T00:00:00.000Z'
    await seedRevertTimeline(harness, 'cmd-concurrent-revert')
    await Effect.runPromise(
      harness.checkpointRevertOperations.admit({
        operationId: 'checkpoint-revert:cmd-active-revert',
        threadId: ThreadId.make('thread-1'),
        targetRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1),
        targetTurnCount: 1,
        cwd: harness.cwd,
        now: createdAt,
      }),
    )

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-conflicting-revert'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 0,
        createdAt,
      }),
    )

    const thread = await waitForThread(harness.readModel, (candidate) =>
      candidate.activities.some((activity) => activity.kind === 'checkpoint.revert.failed'),
    )
    const conflicting = await Effect.runPromise(
      harness.checkpointRevertOperations.getById('checkpoint-revert:cmd-conflicting-revert'),
    )
    const active = await Effect.runPromise(
      harness.checkpointRevertOperations.getActiveByThread(ThreadId.make('thread-1')),
    )

    expect(thread.activities.some((activity) => activity.kind === 'checkpoint.revert.failed')).toBe(
      true,
    )
    expect(Option.isNone(conflicting)).toBe(true)
    expect(Option.isSome(active) && active.value.operationId).toBe(
      'checkpoint-revert:cmd-active-revert',
    )
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled()
  })

  it('routes an ambiguous provider rollback to manual resolution without blocking the lane', async () =>
  {
    const harness = await createHarness({ rollbackFails: true })
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-unknown-revert'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )
    for (const turnCount of [1, 2])
    {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: 'thread.turn.diff.complete',
          commandId: CommandId.make(`cmd-unknown-revert-diff-${turnCount}`),
          threadId: ThreadId.make('thread-1'),
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), turnCount),
          status: 'ready',
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      )
    }
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-unknown-revert'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 1,
        createdAt,
      }),
    )

    await harness.drain()

    // the journal, not the durable lane, now carries an ambiguous rollback: the
    // write-ahead attempt marker turns it into a manual-required operation, so
    // the action itself settles instead of blocking every later checkpoint effect
    const operation = await waitForRevertOperation(
      harness.checkpointRevertOperations,
      'checkpoint-revert:cmd-unknown-revert',
      (candidate) => candidate.phase === 'manual-required',
    )
    expect(operation.providerOutcome).toBe('manual-unknown')
    const durable = await harness.readDurableState()
    const revertAction = durable.actions.find((action) => action.effectKind === 'checkpoint.revert')
    expect(revertAction?.status).toBe('succeeded')
    expect(durable.progress?.blockedSequence).toBeNull()
  })

  it('processes consecutive revert requests with deterministic rollback sequencing', async () =>
  {
    const harness = await createHarness()
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.session.set',
        commandId: CommandId.make('cmd-session-set-inline-revert'),
        threadId: ThreadId.make('thread-1'),
        session: {
          threadId: ThreadId.make('thread-1'),
          status: 'ready',
          providerName: 'codex',
          runtimeMode: 'approval-required',
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    )

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.diff.complete',
        commandId: CommandId.make('cmd-inline-revert-diff-1'),
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId('turn-1'),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 1),
        status: 'ready',
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.turn.diff.complete',
        commandId: CommandId.make('cmd-inline-revert-diff-2'),
        threadId: ThreadId.make('thread-1'),
        turnId: asTurnId('turn-2'),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make('thread-1'), 2),
        status: 'ready',
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    )

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-sequenced-revert-request-1'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 1,
        createdAt,
      }),
    )
    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-sequenced-revert-request-0'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 0,
        createdAt,
      }),
    )

    await harness.drain()

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2)
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make('thread-1'),
      numTurns: 1,
      expectedProviderInstanceId: ProviderInstanceId.make('codex'),
    })
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make('thread-1'),
      numTurns: 1,
      expectedProviderInstanceId: ProviderInstanceId.make('codex'),
    })
  })

  it('appends an error activity when revert is requested without an active session', async () =>
  {
    const harness = await createHarness({ hasSession: false })
    const createdAt = '2026-01-01T00:00:00.000Z'

    await Effect.runPromise(
      harness.engine.dispatch({
        type: 'thread.checkpoint.revert',
        commandId: CommandId.make('cmd-revert-no-session'),
        threadId: ThreadId.make('thread-1'),
        turnCount: 1,
        createdAt,
      }),
    )

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === 'checkpoint.revert.failed'),
    )

    expect(thread.activities.some((activity) => activity.kind === 'checkpoint.revert.failed')).toBe(
      true,
    )
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled()
  })
})
