// tests/apps/server/orchestration/Layers/OrchestrationEngine.test.ts
// verifies orchestration engine command handling and replay

import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  ProviderInstanceId,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Metric from 'effect/Metric'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vite-plus/test'

import { PersistenceSqlError } from '../../../../../apps/server/src/persistence/Errors.ts'
import {
  AttachmentLifecycleRepository,
  type AttachmentLifecycleRepositoryShape,
} from '../../../../../apps/server/src/persistence/Services/AttachmentLifecycle.ts'
import {
  CheckpointRevertOperations,
  type CheckpointRevertOperation,
  type CheckpointRevertOperationsShape,
} from '../../../../../apps/server/src/persistence/Services/CheckpointRevertOperations.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { ProjectionTurnRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/ProjectionTurns.ts'
import { ProviderRuntimeInboxLive } from '../../../../../apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from '../../../../../apps/server/src/persistence/Services/OrchestrationEventStore.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import { OrchestrationEngineLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from '../../../../../apps/server/src/orchestration/Errors.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { dispatchWithAttachmentLifecycle } from '../../../../../apps/server/src/orchestration/dispatchWithAttachmentLifecycle.ts'
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from '../../../../../apps/server/src/orchestration/Services/ProjectionPipeline.ts'
import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { makeProjectionSnapshotQueryStub } from '../../projectionSnapshotQueryTestHelpers.ts'

const asProjectId = (value: string): ProjectId => ProjectId.make(value)
const asMessageId = (value: string): MessageId => MessageId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value)
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError)
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
)

function makeEngineAuxiliaryLayer(
  options: {
    readonly getActiveRevert?: (threadId: string) => Option.Option<CheckpointRevertOperation>
    readonly associateAccepted?: AttachmentLifecycleRepositoryShape['associateAccepted']
  } = {},
)
{
  // real persistence-backed repo by default so row-level tests can stage and
  // read back; only an explicit associateAccepted override swaps in a stub
  const attachmentLayer =
    options.associateAccepted === undefined
      ? AttachmentLifecycleRepositoryLive
      : Layer.succeed(
          AttachmentLifecycleRepository,
          AttachmentLifecycleRepository.of({
            associateAccepted: options.associateAccepted,
          } as AttachmentLifecycleRepositoryShape),
        )
  const checkpointReverts = CheckpointRevertOperations.of({
    getActiveByThread: (threadId: string) =>
      Effect.succeed(options.getActiveRevert?.(threadId) ?? Option.none()),
  } as unknown as CheckpointRevertOperationsShape)
  return Layer.mergeAll(
    attachmentLayer,
    Layer.succeed(CheckpointRevertOperations, checkpointReverts),
    ProjectionTurnRepositoryLive,
    ProviderRuntimeInboxLive,
  )
}

async function createOrchestrationSystem(
  options: {
    readonly getActiveRevert?: (threadId: string) => Option.Option<CheckpointRevertOperation>
    readonly associateAccepted?: AttachmentLifecycleRepositoryShape['associateAccepted']
  } = {},
)
{
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: 't3-orchestration-engine-test-',
  })
  // one layer value reused so both positions memoize to a single instance;
  // it binds closest to the engine because OrchestrationProjectionPipelineLive
  // re-exports AttachmentLifecycleRepositoryLive and would otherwise shadow it
  const auxiliaryLayer = makeEngineAuxiliaryLayer(options)
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(auxiliaryLayer),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(auxiliaryLayer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  )
  const runtime = ManagedRuntime.make(orchestrationLayer)
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery))
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    attachmentLifecycle: () => runtime.runPromise(Effect.service(AttachmentLifecycleRepository)),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  }
}

function now()
{
  return '2026-01-01T00:00:00.000Z'
}

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

describe('OrchestrationEngine', () =>
{
  it('gates provider and target lifecycle mutations until a checkpoint revert finishes cleanup', async () =>
  {
    const phases = new Map<string, CheckpointRevertOperation['phase']>([
      ['thread-gate-requested', 'requested'],
      ['thread-gate-admitted', 'admitted'],
      ['thread-gate-provider', 'provider-pending'],
      ['thread-gate-started', 'restore-started'],
      ['thread-gate-manual', 'manual-required'],
      ['thread-gate-projected', 'projection-finalized'],
      ['thread-gate-cleanup', 'cleanup-pending'],
      ['thread-gate-completed', 'completed'],
    ])
    const associations: string[] = []
    const system = await createOrchestrationSystem({
      getActiveRevert: (threadId) =>
      {
        const phase = phases.get(threadId)
        return phase === undefined || phase === 'completed' || phase === 'aborted'
          ? Option.none()
          : Option.some({
              operationId: `operation-${threadId}`,
              threadId,
              targetRef: `refs/t3/checkpoints/${threadId}/1`,
              targetTurnCount: 1,
              requestSourceSequence: 100,
              providerInboxHighWater: 50,
              targetTree: null,
              cwd: '/tmp/worktree',
              checkpointCaptureRoot: null,
              repositoryCommonDir: null,
              checkpointCommitOid: null,
              stagePath: null,
              phase,
              attemptCount: 0,
              lastError: null,
              provider: null,
              providerInstanceId: null,
              providerSessionId: null,
              providerThreadId: null,
              providerSessionGeneration: null,
              providerOutcome: null,
              providerOutcomeJson: null,
              projectionStatus: null,
              staleRefsJson: null,
              cleanupStatus: null,
              manualResumePhase: phase === 'manual-required' ? 'restore-started' : null,
              createdAt: now(),
              updatedAt: now(),
            })
      },
      associateAccepted: (input) =>
        Effect.sync(() =>
        {
          associations.push(input.commandId)
        }),
    })
    const { engine } = system
    const projectId = asProjectId('project-revert-gate')
    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-revert-gate-project'),
        projectId,
        title: 'Revert Gate Project',
        workspaceRoot: '/tmp/revert-gate',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt: now(),
      }),
    )

    for (const threadId of phases.keys())
    {
      await system.run(
        engine.dispatch({
          type: 'thread.create',
          commandId: CommandId.make(`cmd-create-${threadId}`),
          threadId: ThreadId.make(threadId),
          projectId,
          title: threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      )
    }

    const blockedPhases = [
      ['requested', 'requested'],
      ['admitted', 'admitted'],
      ['provider-pending', 'provider'],
      ['restore-started', 'started'],
      ['manual-required', 'manual'],
      ['projection-finalized', 'projected'],
      ['cleanup-pending', 'cleanup'],
    ] as const

    for (const [phase, phaseSuffix] of blockedPhases)
    {
      const threadId = `thread-gate-${phaseSuffix}`
      const dispatchTurn = () =>
        engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make(`cmd-turn-${phase}`),
          threadId: ThreadId.make(threadId),
          message: {
            messageId: asMessageId(`message-${phase}`),
            role: 'user',
            text: 'blocked',
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: now(),
        })
      const result = await system.run(Effect.result(dispatchTurn()))
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure')
      {
        expect(isOrchestrationCommandInvariantError(result.failure)).toBe(true)
        expect(result.failure).toMatchObject({
          code: 'checkpoint-revert-in-progress',
        })
        expect(result.failure.message).toContain(`phase '${phase}'`)
      }

      const replay = await system.run(Effect.result(dispatchTurn()))
      expect(replay._tag).toBe('Failure')
      if (replay._tag === 'Failure')
      {
        expect(isOrchestrationCommandPreviouslyRejectedError(replay.failure)).toBe(true)
        expect(replay.failure).toMatchObject({
          code: 'checkpoint-revert-in-progress',
        })
      }
    }

    const metadataMutation = await system.run(
      Effect.result(
        engine.dispatch({
          type: 'thread.meta.update',
          commandId: CommandId.make('cmd-meta-while-revert-active'),
          threadId: ThreadId.make('thread-gate-admitted'),
          title: 'Mutation must remain fenced',
        }),
      ),
    )
    expect(metadataMutation._tag).toBe('Failure')
    if (metadataMutation._tag === 'Failure')
    {
      expect(metadataMutation.failure).toMatchObject({
        code: 'checkpoint-revert-in-progress',
      })
    }

    await system.run(
      engine.dispatchInternal(
        {
          type: 'thread.meta.update',
          commandId: CommandId.make('cmd-meta-causal-domain-settlement'),
          threadId: ThreadId.make('thread-gate-admitted'),
          title: 'Causally prior domain settlement',
        },
        { sourceKind: 'domain-event', sourceSequence: 99 },
      ),
    )
    await system.run(
      engine.dispatchInternal(
        {
          type: 'thread.meta.update',
          commandId: CommandId.make('cmd-meta-causal-runtime-settlement'),
          threadId: ThreadId.make('thread-gate-admitted'),
          title: 'Causally prior runtime settlement',
        },
        { sourceKind: 'provider-runtime', sourceSequence: 50 },
      ),
    )
    for (const [commandId, authority] of [
      ['cmd-meta-stale-domain-settlement', { sourceKind: 'domain-event', sourceSequence: 100 }],
      ['cmd-meta-stale-runtime-settlement', { sourceKind: 'provider-runtime', sourceSequence: 51 }],
    ] as const)
    {
      const staleSettlement = await system.run(
        Effect.result(
          engine.dispatchInternal(
            {
              type: 'thread.meta.update',
              commandId: CommandId.make(commandId),
              threadId: ThreadId.make('thread-gate-admitted'),
              title: 'Causally newer mutation stays fenced',
            },
            authority,
          ),
        ),
      )
      expect(staleSettlement._tag).toBe('Failure')
      if (staleSettlement._tag === 'Failure')
      {
        expect(staleSettlement.failure).toMatchObject({
          code: 'checkpoint-revert-in-progress',
        })
      }
    }
    for (const suffix of ['completed'] as const)
    {
      await system.run(
        engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make(`cmd-turn-${suffix}`),
          threadId: ThreadId.make(`thread-gate-${suffix}`),
          message: {
            messageId: asMessageId(`message-${suffix}`),
            role: 'user',
            text: 'allowed',
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: now(),
        }),
      )
    }
    expect(associations).toEqual(['cmd-turn-completed'])
    await system.dispose()
  })

  it('bootstraps command handling from persisted projections without reading the full snapshot', async () =>
  {
    let nextSequence = 8
    const eventStore: OrchestrationEventStoreShape = {
      // batched append delegates to the single-append mock (megacore U-166)
      appendAll: (events) => Effect.forEach(events, (event) => eventStore.append(event)),
      append: (event) =>
        Effect.sync(() =>
        {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent
          nextSequence += 1
          return savedEvent
        }),
      readFromSequence: () => Stream.empty,
      readAggregateRange: () => Stream.die('unused aggregate replay'),
      getAggregateReplayStats: () => Effect.die('unused aggregate replay stats'),
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: 'test.readAll',
            detail: 'historical replay should not be used during bootstrap',
          }),
        ),
    }

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: '2026-03-03T00:00:04.000Z',
      projects: [
        {
          id: asProjectId('project-bootstrap'),
          title: 'Bootstrap Project',
          workspaceRoot: '/tmp/project-bootstrap',
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          scripts: [],
          createdAt: '2026-03-03T00:00:00.000Z',
          updatedAt: '2026-03-03T00:00:01.000Z',
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make('thread-bootstrap'),
          projectId: asProjectId('project-bootstrap'),
          title: 'Bootstrap Thread',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'full-access' as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          providerSwitch: null,
          createdAt: '2026-03-03T00:00:02.000Z',
          updatedAt: '2026-03-03T00:00:03.000Z',
          archivedAt: null,
          origin: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          orchestratePlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    }
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        orchestratePlans: [],
        activities: [],
        checkpoints: [],
      })),
    }
    let fullSnapshotReadCount = 0

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQueryStub({
            getCommandReadModel: () => Effect.succeed(commandReadModel),
            getSnapshot: () =>
              Effect.sync(() =>
              {
                fullSnapshotReadCount += 1
                return projectionSnapshot
              }),
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(makeEngineAuxiliaryLayer()),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    )

    const runtime = ManagedRuntime.make(layer)

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7)
    const result = await runtime.runPromise(
      engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-bootstrap-thread-update'),
        threadId: ThreadId.make('thread-bootstrap'),
        title: 'Updated Bootstrap Thread',
      }),
    )

    expect(result.sequence).toBe(8)
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8)
    expect(fullSnapshotReadCount).toBe(0)

    await runtime.dispose()
  })

  it('persists deterministic read models for repeated snapshot reads', async () =>
  {
    const createdAt = now()
    const system = await createOrchestrationSystem()
    const { engine } = system

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-1-create'),
        projectId: asProjectId('project-1'),
        title: 'Project 1',
        workspaceRoot: '/tmp/project-1',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-1-create'),
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
        worktreePath: null,
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.turn.start',
        commandId: CommandId.make('cmd-turn-start-1'),
        threadId: ThreadId.make('thread-1'),
        message: {
          messageId: asMessageId('msg-1'),
          role: 'user',
          text: 'hello',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt,
      }),
    )

    const readModelA = await system.readModel()
    const readModelB = await system.readModel()
    expect(readModelB).toEqual(readModelA)
    await system.dispose()
  })

  it('owns staged attachments with the appended message event sequence', async () =>
  {
    const createdAt = now()
    const system = await createOrchestrationSystem()
    const { engine } = system
    const commandId = CommandId.make('cmd-turn-attachment')
    const threadId = ThreadId.make('thread-attachment')
    const messageId = asMessageId('message-attachment')

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-attachment-create'),
        projectId: asProjectId('project-attachment'),
        title: 'Attachment Project',
        workspaceRoot: '/tmp/project-attachment',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-attachment-create'),
        threadId,
        projectId: asProjectId('project-attachment'),
        title: 'Attachment Thread',
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

    const attachmentLifecycle = await system.attachmentLifecycle()
    await system.run(
      attachmentLifecycle.stage({
        stagingKey: 'engine-staging-key',
        commandId,
        threadId,
        messageId,
        attachmentIndex: 0,
        attachmentId: 'thread-attachment-00000000-0000-4000-8000-000000000001',
        stagingRelativePath: '.staging/engine-staging-key/attachment.png',
        relativePath: 'attachment.png',
        mimeType: 'image/png',
        byteCount: 4,
        contentDigest: 'abcd',
        now: createdAt,
      }),
    )

    const command = {
      type: 'thread.turn.start' as const,
      commandId,
      threadId,
      message: {
        messageId,
        role: 'user' as const,
        text: 'inspect this image',
        attachments: [
          {
            type: 'image' as const,
            id: 'thread-attachment-00000000-0000-4000-8000-000000000001',
            name: 'attachment.png',
            mimeType: 'image/png',
            sizeBytes: 4,
          },
        ],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: 'approval-required' as const,
      createdAt,
    }
    const result = await system.run(engine.dispatch(command))
    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    )
    const messageEvent = events.find(
      (event) => event.commandId === commandId && event.type === 'thread.message-sent',
    )
    expect(messageEvent).toBeDefined()
    expect(messageEvent?.sequence).not.toBe(result.sequence)

    const row = await system.run(
      attachmentLifecycle.getByStagingKey('engine-staging-key').pipe(Effect.map(Option.getOrThrow)),
    )
    expect(row.state).toBe('owned')
    expect(row.ownerSequence).toBe(messageEvent?.sequence)
    expect(row.ownerEventType).toBe('thread.message-sent')

    const duplicate = await system.run(engine.dispatch(command))
    expect(duplicate.sequence).toBe(result.sequence)
    const duplicateRow = await system.run(
      attachmentLifecycle.getByStagingKey('engine-staging-key').pipe(Effect.map(Option.getOrThrow)),
    )
    expect(duplicateRow.ownerSequence).toBe(messageEvent?.sequence)
    await system.dispose()
  })

  it('archives and unarchives threads through orchestration commands', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-archive-create'),
        projectId: asProjectId('project-archive'),
        title: 'Project Archive',
        workspaceRoot: '/tmp/project-archive',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-archive-create'),
        threadId: ThreadId.make('thread-archive'),
        projectId: asProjectId('project-archive'),
        title: 'Archive me',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'full-access',
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    )

    await system.run(
      engine.dispatch({
        type: 'thread.archive',
        commandId: CommandId.make('cmd-thread-archive'),
        threadId: ThreadId.make('thread-archive'),
      }),
    )
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === 'thread-archive')
        ?.archivedAt,
    ).not.toBeNull()
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === 'thread-archive')
        ?.archiveGeneration,
    ).toBe(1)

    await system.run(
      engine.dispatch({
        type: 'thread.unarchive',
        commandId: CommandId.make('cmd-thread-unarchive'),
        threadId: ThreadId.make('thread-archive'),
      }),
    )
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === 'thread-archive')
        ?.archivedAt,
    ).toBeNull()
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === 'thread-archive')
        ?.archiveGeneration,
    ).toBe(1)

    await system.run(
      engine.dispatch({
        type: 'thread.archive',
        commandId: CommandId.make('cmd-thread-rearchive'),
        threadId: ThreadId.make('thread-archive'),
      }),
    )
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === 'thread-archive')
        ?.archiveGeneration,
    ).toBe(2)
    const archiveEvents = Array.from(
      await system.run(Stream.runCollect(engine.readEvents(0))),
    ).filter((event) => event.type === 'thread.archived')
    expect(archiveEvents.map((event) => event.payload.archiveGeneration)).toEqual([1, 2])

    await system.dispose()
  })

  it('replays append-only events from sequence', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-replay-create'),
        projectId: asProjectId('project-replay'),
        title: 'Replay Project',
        workspaceRoot: '/tmp/project-replay',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-replay-create'),
        threadId: ThreadId.make('thread-replay'),
        projectId: asProjectId('project-replay'),
        title: 'replay',
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
    await system.run(
      engine.dispatch({
        type: 'thread.delete',
        commandId: CommandId.make('cmd-thread-replay-delete'),
        threadId: ThreadId.make('thread-replay'),
      }),
    )

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    )
    expect(events.map((event) => event.type)).toEqual([
      'project.created',
      'thread.created',
      'thread.deleted',
    ])
    await system.dispose()
  })

  it('streams persisted domain events in order', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-stream-create'),
        projectId: asProjectId('project-stream'),
        title: 'Stream Project',
        workspaceRoot: '/tmp/project-stream',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )

    const eventTypes: string[] = []
    await system.run(
      Effect.gen(function* ()
      {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>()
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        )
        yield* Effect.sleep('10 millis')
        yield* engine.dispatch({
          type: 'thread.create',
          commandId: CommandId.make('cmd-stream-thread-create'),
          threadId: ThreadId.make('thread-stream'),
          projectId: asProjectId('project-stream'),
          title: 'domain-stream',
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
        yield* engine.dispatch({
          type: 'thread.meta.update',
          commandId: CommandId.make('cmd-stream-thread-update'),
          threadId: ThreadId.make('thread-stream'),
          title: 'domain-stream-updated',
        })
        eventTypes.push((yield* Queue.take(eventQueue)).type)
        eventTypes.push((yield* Queue.take(eventQueue)).type)
      }).pipe(Effect.scoped),
    )

    expect(eventTypes).toEqual(['thread.created', 'thread.meta-updated'])
    await system.dispose()
  })

  it('detaches failed admission sinks without failing dispatch or other subscribers', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()
    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-admission-project-create'),
        projectId: asProjectId('project-admission'),
        title: 'Admission Project',
        workspaceRoot: '/tmp/project-admission',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )

    let throwingCalls = 0
    let rejectingCalls = 0
    const received: string[] = []
    await system.run(
      Effect.scoped(
        Effect.gen(function* ()
        {
          yield* engine.registerDomainEventAdmission(() =>
          {
            throwingCalls += 1
            throw new Error('client sink failed')
          })
          yield* engine.registerDomainEventAdmission(() =>
          {
            rejectingCalls += 1
            return false
          })
          yield* engine.registerDomainEventAdmission((event) =>
          {
            received.push(event.type)
            return true
          })

          yield* engine.dispatch({
            type: 'thread.create',
            commandId: CommandId.make('cmd-admission-thread-create'),
            threadId: ThreadId.make('thread-admission'),
            projectId: asProjectId('project-admission'),
            title: 'admission',
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
          yield* engine.dispatch({
            type: 'thread.meta.update',
            commandId: CommandId.make('cmd-admission-thread-update'),
            threadId: ThreadId.make('thread-admission'),
            title: 'admission updated',
          })
        }),
      ),
    )

    expect(throwingCalls).toBe(1)
    expect(rejectingCalls).toBe(1)
    expect(received).toEqual(['thread.created', 'thread.meta-updated'])
    await system.dispose()
  })

  it('does not regress a generated branch to a stale temporary worktree branch', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-branch-race-project-create'),
        projectId: asProjectId('project-branch-race'),
        title: 'Branch Race Project',
        workspaceRoot: '/tmp/project-branch-race',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-branch-race-thread-create'),
        threadId: ThreadId.make('thread-branch-race'),
        projectId: asProjectId('project-branch-race'),
        title: 'Branch Race Thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        branch: 't3code/generated-branch-name',
        worktreePath: '/tmp/project-branch-race-worktree',
        createdAt,
      }),
    )

    await system.run(
      engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-stale-temporary-branch-sync'),
        threadId: ThreadId.make('thread-branch-race'),
        branch: 't3code/1234abcd',
        expectedBranch: 't3code/1234abcd',
      }),
    )

    const snapshot = await system.readModel()
    expect(snapshot.threads[0]?.branch).toBe('t3code/generated-branch-name')
    await system.dispose()
  })

  it('allows authoritative worktree bootstrap to assign a temporary branch', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-worktree-bootstrap-project-create'),
        projectId: asProjectId('project-worktree-bootstrap'),
        title: 'Worktree Bootstrap Project',
        workspaceRoot: '/tmp/project-worktree-bootstrap',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-worktree-bootstrap-thread-create'),
        threadId: ThreadId.make('thread-worktree-bootstrap'),
        projectId: asProjectId('project-worktree-bootstrap'),
        title: 'Worktree Bootstrap Thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        branch: 'main',
        worktreePath: null,
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.meta.update',
        commandId: CommandId.make('cmd-authoritative-worktree-bootstrap'),
        threadId: ThreadId.make('thread-worktree-bootstrap'),
        branch: 't3code/1234abcd',
        worktreePath: '/tmp/project-worktree-bootstrap-worktree',
      }),
    )

    const snapshot = await system.readModel()
    expect(snapshot.threads[0]?.branch).toBe('t3code/1234abcd')
    expect(snapshot.threads[0]?.worktreePath).toBe('/tmp/project-worktree-bootstrap-worktree')
    await system.dispose()
  })

  it('records command ack duration using the first committed event type', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-ack-create'),
        projectId: asProjectId('project-ack'),
        title: 'Ack Project',
        workspaceRoot: '/tmp/project-ack',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )

    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-ack-create'),
        threadId: ThreadId.make('thread-ack'),
        projectId: asProjectId('project-ack'),
        title: 'Ack Thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'full-access',
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    )

    const snapshots = await system.run(Metric.snapshot)
    expect(
      hasMetricSnapshot(snapshots, 't3_orchestration_command_ack_duration', {
        commandType: 'thread.create',
        aggregateKind: 'thread',
        ackEventType: 'thread.created',
      }),
    ).toBe(true)

    await system.dispose()
  })

  it('records failed command dispatches as metric failures', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await expect(
      system.run(
        engine.dispatch({
          type: 'thread.create',
          commandId: CommandId.make('cmd-thread-missing-project'),
          threadId: ThreadId.make('thread-missing-project'),
          projectId: asProjectId('project-missing'),
          title: 'Missing Project Thread',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow('does not exist')

    const snapshots = await system.run(Metric.snapshot)
    expect(
      hasMetricSnapshot(snapshots, 't3_orchestration_commands_total', {
        commandType: 'thread.create',
        aggregateKind: 'thread',
        outcome: 'failure',
      }),
    ).toBe(true)

    await system.dispose()
  })

  it('stores completed checkpoint summaries even when no files changed', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-turn-diff-create'),
        projectId: asProjectId('project-turn-diff'),
        title: 'Turn Diff Project',
        workspaceRoot: '/tmp/project-turn-diff',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-turn-diff-create'),
        threadId: ThreadId.make('thread-turn-diff'),
        projectId: asProjectId('project-turn-diff'),
        title: 'Turn diff thread',
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
    await system.run(
      engine.dispatch({
        type: 'thread.turn.diff.complete',
        commandId: CommandId.make('cmd-turn-diff-complete'),
        threadId: ThreadId.make('thread-turn-diff'),
        turnId: asTurnId('turn-1'),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef('refs/t3/checkpoints/thread-turn-diff/turn/1'),
        status: 'ready',
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    )

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === 'thread-turn-diff',
    )
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId('turn-1'),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef('refs/t3/checkpoints/thread-turn-diff/turn/1'),
        status: 'ready',
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ])
    await system.dispose()
  })

  it('keeps processing queued commands after a storage failure', async () =>
  {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape['append']> extends Effect.Effect<infer A, any, any>
        ? A
        : never
    const events: StoredEvent[] = []
    let nextSequence = 1
    let shouldFailFirstAppend = true

    const flakyStore: OrchestrationEventStoreShape = {
      // batched append delegates to the single-append mock (megacore U-166)
      appendAll: (events) => Effect.forEach(events, (event) => flakyStore.append(event)),
      append(event)
      {
        if (shouldFailFirstAppend && event.commandId === CommandId.make('cmd-flaky-1'))
        {
          shouldFailFirstAppend = false
          return Effect.fail(
            new PersistenceSqlError({
              operation: 'test.append',
              detail: 'append failed',
            }),
          )
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent
        nextSequence += 1
        events.push(savedEvent)
        return Effect.succeed(savedEvent)
      },
      readFromSequence(sequenceExclusive)
      {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive))
      },
      readAggregateRange: () => Stream.die('unused aggregate replay'),
      getAggregateReplayStats: () => Effect.die('unused aggregate replay stats'),
      readAll()
      {
        return Stream.fromIterable(events)
      },
    }

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: 't3-orchestration-engine-test-',
    })

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(makeEngineAuxiliaryLayer()),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    )
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
    const createdAt = now()

    await runtime.runPromise(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-flaky-create'),
        projectId: asProjectId('project-flaky'),
        title: 'Flaky Project',
        workspaceRoot: '/tmp/project-flaky',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: 'thread.create',
          commandId: CommandId.make('cmd-flaky-1'),
          threadId: ThreadId.make('thread-flaky-fail'),
          projectId: asProjectId('project-flaky'),
          title: 'flaky-fail',
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
      ),
    ).rejects.toThrow('append failed')

    const result = await runtime.runPromise(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-flaky-2'),
        threadId: ThreadId.make('thread-flaky-ok'),
        projectId: asProjectId('project-flaky'),
        title: 'flaky-ok',
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

    expect(result.sequence).toBe(2)
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    )
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      'project.created',
      'thread.created',
    ])
    await runtime.dispose()
  })

  it('rolls back all events for a multi-event command when projection fails mid-dispatch', async () =>
  {
    let shouldFailRequestedProjection = true
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) =>
      {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make('cmd-turn-start-atomic') &&
          event.type === 'thread.turn-start-requested'
        )
        {
          shouldFailRequestedProjection = false
          return Effect.fail(
            new PersistenceSqlError({
              operation: 'test.projection',
              detail: 'projection failed',
            }),
          )
        }
        return Effect.void
      },
    }

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(makeEngineAuxiliaryLayer()),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    )
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
    const createdAt = now()

    await runtime.runPromise(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-atomic-create'),
        projectId: asProjectId('project-atomic'),
        title: 'Atomic Project',
        workspaceRoot: '/tmp/project-atomic',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await runtime.runPromise(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-atomic-create'),
        threadId: ThreadId.make('thread-atomic'),
        projectId: asProjectId('project-atomic'),
        title: 'atomic',
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

    const turnStartCommand = {
      type: 'thread.turn.start' as const,
      commandId: CommandId.make('cmd-turn-start-atomic'),
      threadId: ThreadId.make('thread-atomic'),
      message: {
        messageId: asMessageId('msg-atomic-1'),
        role: 'user' as const,
        text: 'hello',
        attachments: [
          {
            type: 'image' as const,
            id: 'thread-atomic-00000000-0000-4000-8000-000000000001',
            name: 'attachment.png',
            mimeType: 'image/png',
            sizeBytes: 4,
          },
        ],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: 'approval-required' as const,
      createdAt,
    }

    const attachmentLifecycle = await runtime.runPromise(
      Effect.service(AttachmentLifecycleRepository),
    )
    const stageInput = {
      stagingKey: 'atomic-staging-key',
      commandId: turnStartCommand.commandId,
      threadId: turnStartCommand.threadId,
      messageId: turnStartCommand.message.messageId,
      attachmentIndex: 0,
      attachmentId: turnStartCommand.message.attachments[0]!.id,
      stagingRelativePath: '.staging/atomic-staging-key/attachment.png',
      relativePath: 'atomic-attachment.png',
      mimeType: 'image/png',
      byteCount: 4,
      contentDigest: 'abcd',
      now: createdAt,
    } as const
    await runtime.runPromise(attachmentLifecycle.stage(stageInput))

    await expect(
      runtime.runPromise(
        dispatchWithAttachmentLifecycle(turnStartCommand, engine.dispatch(turnStartCommand)),
      ),
    ).rejects.toThrow('projection failed')

    const failedAttachment = await runtime.runPromise(
      attachmentLifecycle
        .getByStagingKey(stageInput.stagingKey)
        .pipe(Effect.map(Option.getOrThrow)),
    )
    expect(failedAttachment.state).toBe('cleanup_pending')
    expect(failedAttachment.ownerSequence).toBeNull()

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    )
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      'project.created',
      'thread.created',
    ])

    await runtime.runPromise(attachmentLifecycle.stage(stageInput))
    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand))
    expect(retryResult.sequence).toBe(4)

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    )
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      'project.created',
      'thread.created',
      'thread.message-sent',
      'thread.turn-start-requested',
    ])
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2)
    const ownedAttachment = await runtime.runPromise(
      attachmentLifecycle
        .getByStagingKey(stageInput.stagingKey)
        .pipe(Effect.map(Option.getOrThrow)),
    )
    const retryMessageEvent = eventsAfterRetry.find(
      (event) =>
        event.commandId === turnStartCommand.commandId && event.type === 'thread.message-sent',
    )
    expect(ownedAttachment.state).toBe('owned')
    expect(ownedAttachment.ownerSequence).toBe(retryMessageEvent?.sequence)

    await runtime.dispose()
  })

  it('reconciles command state when append persists but projection fails', async () =>
  {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape['append']> extends Effect.Effect<infer A, any, any>
        ? A
        : never
    const events: StoredEvent[] = []
    let nextSequence = 1

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      // batched append delegates to the single-append mock (megacore U-166)
      appendAll: (events) => Effect.forEach(events, (event) => nonTransactionalStore.append(event)),
      append(event)
      {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent
        nextSequence += 1
        events.push(savedEvent)
        return Effect.succeed(savedEvent)
      },
      readFromSequence(sequenceExclusive)
      {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive))
      },
      readAggregateRange: () => Stream.die('unused aggregate replay'),
      getAggregateReplayStats: () => Effect.die('unused aggregate replay stats'),
      readAll()
      {
        return Stream.fromIterable(events)
      },
    }

    let shouldFailProjection = true
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) =>
      {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make('cmd-thread-archive-sync-fail')
        )
        {
          shouldFailProjection = false
          return Effect.fail(
            new PersistenceSqlError({
              operation: 'test.projection',
              detail: 'projection failed',
            }),
          )
        }
        return Effect.void
      },
    }

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(makeEngineAuxiliaryLayer()),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    )
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService))
    const createdAt = now()

    await runtime.runPromise(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-sync-create'),
        projectId: asProjectId('project-sync'),
        title: 'Sync Project',
        workspaceRoot: '/tmp/project-sync',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    await runtime.runPromise(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-sync-create'),
        threadId: ThreadId.make('thread-sync'),
        projectId: asProjectId('project-sync'),
        title: 'sync-before',
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

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: 'thread.archive',
          commandId: CommandId.make('cmd-thread-archive-sync-fail'),
          threadId: ThreadId.make('thread-sync'),
        }),
      ),
    ).rejects.toThrow('projection failed')

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: 'thread.archive',
          commandId: CommandId.make('cmd-thread-archive-sync-retry'),
          threadId: ThreadId.make('thread-sync'),
        }),
      ),
    ).rejects.toThrow('already archived')

    await runtime.dispose()
  })

  it('fails command dispatch when command invariants are violated', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system

    await expect(
      system.run(
        engine.dispatch({
          type: 'thread.turn.start',
          commandId: CommandId.make('cmd-invariant-missing-thread'),
          threadId: ThreadId.make('thread-missing'),
          message: {
            messageId: asMessageId('msg-missing'),
            role: 'user',
            text: 'hello',
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist")

    await system.dispose()
  })

  it('rejects duplicate thread creation', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-project-duplicate-create'),
        projectId: asProjectId('project-duplicate'),
        title: 'Duplicate Project',
        workspaceRoot: '/tmp/project-duplicate',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )

    await system.run(
      engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-thread-duplicate-1'),
        threadId: ThreadId.make('thread-duplicate'),
        projectId: asProjectId('project-duplicate'),
        title: 'duplicate',
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

    await expect(
      system.run(
        engine.dispatch({
          type: 'thread.create',
          commandId: CommandId.make('cmd-thread-duplicate-2'),
          threadId: ThreadId.make('thread-duplicate'),
          projectId: asProjectId('project-duplicate'),
          title: 'duplicate',
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
      ),
    ).rejects.toThrow('already exists')

    await system.dispose()
  })

  it('rejects reusing an accepted command id for a different aggregate', async () =>
  {
    const system = await createOrchestrationSystem()
    const { engine } = system
    const createdAt = now()
    const projectId = asProjectId('project-command-id-conflict')

    await system.run(
      engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-command-id-conflict-project'),
        projectId,
        title: 'Command Id Conflict',
        workspaceRoot: '/tmp/project-command-id-conflict',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      }),
    )
    for (const threadId of ['thread-command-id-conflict-a', 'thread-command-id-conflict-b'])
    {
      await system.run(
        engine.dispatch({
          type: 'thread.create',
          commandId: CommandId.make(`cmd-${threadId}-create`),
          threadId: ThreadId.make(threadId),
          projectId,
          title: threadId,
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
    }

    const commandId = CommandId.make('cmd-command-id-conflict-turn')
    await system.run(
      engine.dispatch({
        type: 'thread.turn.start',
        commandId,
        threadId: ThreadId.make('thread-command-id-conflict-a'),
        message: {
          messageId: asMessageId('message-command-id-conflict-a'),
          role: 'user',
          text: 'first aggregate',
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: 'approval-required',
        createdAt,
      }),
    )

    await expect(
      system.run(
        engine.dispatch({
          type: 'thread.turn.start',
          commandId,
          threadId: ThreadId.make('thread-command-id-conflict-b'),
          message: {
            messageId: asMessageId('message-command-id-conflict-b'),
            role: 'user',
            text: 'different aggregate',
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: 'approval-required',
          createdAt,
        }),
      ),
    ).rejects.toThrow("already used for thread 'thread-command-id-conflict-a'")

    const readModel = await system.readModel()
    const targetThread = readModel.threads.find(
      (candidate) => candidate.id === 'thread-command-id-conflict-b',
    )
    expect(targetThread?.messages.filter((message) => message.role === 'user')).toHaveLength(0)

    await system.dispose()
  })
})
