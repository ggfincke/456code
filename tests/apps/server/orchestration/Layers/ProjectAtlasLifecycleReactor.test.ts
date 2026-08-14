// tests/apps/server/orchestration/Layers/ProjectAtlasLifecycleReactor.test.ts
// verifies durable project atlas invalidation and deletion cleanup

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import { CommandId, ProjectId } from '@t3tools/contracts'
import { it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect } from 'vite-plus/test'

import { ProjectArchitectureLifecycleService } from '../../../../../apps/server/src/cartographer/ProjectArchitectureLifecycleService.ts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { ProjectAtlasLifecycleReactorLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectAtlasLifecycleReactor.ts'
import { OrchestrationEngineLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { OrchestrationProjectionPipelineLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ProjectAtlasLifecycleReactor } from '../../../../../apps/server/src/orchestration/Services/ProjectAtlasLifecycleReactor.ts'
import { AttachmentLifecycleRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/AttachmentLifecycle.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { OrchestrationReactorDelivery } from '../../../../../apps/server/src/persistence/Services/OrchestrationReactorDelivery.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'

const now = '2026-08-07T12:00:00.000Z'
const nowMs = Date.parse(now)
const projectId = ProjectId.make('project-atlas-lifecycle')

function makeLayer(
  calls: Array<string>,
  removeArtifacts: (projectId: ProjectId) => Effect.Effect<void> = () => Effect.void,
)
{
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: 't3-project-atlas-life-' })
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(AttachmentLifecycleRepositoryLive),
    Layer.provideMerge(CheckpointRevertOperationsLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(configLayer),
  )
  return ProjectAtlasLifecycleReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(
      Layer.mock(ProjectArchitectureLifecycleService)({
        invalidateProjectMetadata: (_projectId, workspaceRoot) =>
          Effect.sync(() =>
          {
            calls.push(`invalidate:${workspaceRoot}`)
          }),
        closeProject: () =>
          Effect.sync(() =>
          {
            calls.push('close')
          }),
        deleteProjectArtifacts: (projectId) =>
          Effect.sync(() => calls.push('delete')).pipe(Effect.andThen(removeArtifacts(projectId))),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  )
}

const createProject = (engine: OrchestrationEngineService['Service']) =>
  engine.dispatch({
    type: 'project.create',
    commandId: CommandId.make('command-project-atlas-create'),
    projectId,
    title: 'Project Atlas lifecycle',
    workspaceRoot: '/tmp/project-atlas-lifecycle',
    createdAt: now,
  })

const deleteProject = (engine: OrchestrationEngineService['Service']) =>
  engine.dispatch({
    type: 'project.delete',
    commandId: CommandId.make('command-project-atlas-delete'),
    projectId,
  })

describe('ProjectAtlasLifecycleReactor', () =>
{
  it.effect('invalidates root changes and deletes resources in durable order', () =>
  {
    const calls: Array<string> = []
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(nowMs)
        const engine = yield* OrchestrationEngineService
        yield* createProject(engine)
        const reactor = yield* ProjectAtlasLifecycleReactor
        yield* reactor.start()
        yield* engine.dispatch({
          type: 'project.meta.update',
          commandId: CommandId.make('command-project-atlas-root-update'),
          projectId,
          workspaceRoot: '/tmp/project-atlas-lifecycle-moved',
        })
        yield* deleteProject(engine)
        yield* reactor.drain

        expect(calls).toEqual(['invalidate:/tmp/project-atlas-lifecycle-moved', 'close', 'delete'])
      }).pipe(Effect.provide(makeLayer(calls))),
    )
  })

  it.effect('replays deletion appended while an existing reactor cursor was stopped', () =>
  {
    const calls: Array<string> = []
    return Effect.scoped(
      Effect.gen(function* ()
      {
        yield* TestClock.setTime(nowMs)
        const engine = yield* OrchestrationEngineService
        const delivery = yield* OrchestrationReactorDelivery
        yield* createProject(engine)
        yield* delivery.ensureProgress({
          reactorId: 'project-atlas-lifecycle',
          operationVersion: 1,
          initialSequence: 1,
          mode: 'durable',
          now,
        })
        yield* deleteProject(engine)

        const reactor = yield* ProjectAtlasLifecycleReactor
        yield* reactor.start()
        yield* reactor.drain
        expect(calls).toEqual(['close', 'delete'])
      }).pipe(Effect.provide(makeLayer(calls))),
    )
  })

  it.effect('removes seeded orphan project artifacts before starting at the current cursor', () =>
  {
    const calls: string[] = []
    let orphan = ''
    return Effect.scoped(
      Effect.gen(function* ()
      {
        const config = yield* ServerConfig
        orphan = NodePath.join(config.stateDir, 'cartographer', 'projects', 'project-atlas-orphan')
        yield* Effect.promise(() => NodeFSP.mkdir(orphan, { recursive: true }))
        const reactor = yield* ProjectAtlasLifecycleReactor
        yield* reactor.start()

        expect(calls).toEqual(['close', 'delete'])
        expect(yield* Effect.promise(() => NodeFSP.stat(orphan).catch(() => null))).toBeNull()
      }).pipe(
        Effect.provide(
          makeLayer(calls, () =>
            Effect.promise(() => NodeFSP.rm(orphan, { recursive: true, force: true })),
          ),
        ),
      ),
    )
  })
})
