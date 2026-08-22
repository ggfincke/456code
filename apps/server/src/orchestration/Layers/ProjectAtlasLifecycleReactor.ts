// apps/server/src/orchestration/Layers/ProjectAtlasLifecycleReactor.ts
// durably invalidates and deletes standing project atlas resources

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'

import { OrchestrationEvent, ProjectId } from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { ProjectArchitectureLifecycleService } from '../../cartographer/ProjectArchitectureLifecycleService.ts'
import { ServerConfig } from '../../config.ts'
import { ReactorDeliveryError } from '../../persistence/Errors.ts'
import { OrchestrationReactorDelivery } from '../../persistence/Services/OrchestrationReactorDelivery.ts'
import {
  DurableReactorRunner,
  type DurableReactorDefinition,
} from '../Services/DurableReactorRunner.ts'
import {
  ProjectAtlasLifecycleReactor,
  type ProjectAtlasLifecycleReactorShape,
} from '../Services/ProjectAtlasLifecycleReactor.ts'
import { ProjectionSnapshotQuery } from '../Services/ProjectionSnapshotQuery.ts'
import { DurableReactorInfrastructureLive } from './OrchestrationReactor.ts'

// orphan-scan fs failures are non-fatal; the tag keeps the reconcile error channel typed
class ProjectAtlasReconcileFsError extends Data.TaggedError('ProjectAtlasReconcileFsError')<{
  readonly cause: unknown
}>
{}

const REACTOR_ID = 'project-atlas-lifecycle' as const
const OPERATION_VERSION = 1
const PROJECT_ID_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,160}$/u
const EventPayload = Schema.fromJsonString(OrchestrationEvent)
const encodeEventPayload = Schema.encodeEffect(EventPayload)
const decodeEventPayload = Schema.decodeUnknownEffect(EventPayload)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

class ProjectAtlasLifecyclePayloadError extends Schema.TaggedErrorClass<ProjectAtlasLifecyclePayloadError>()(
  'ProjectAtlasLifecyclePayloadError',
  { detail: Schema.String },
)
{}
const isProjectAtlasLifecyclePayloadError = Schema.is(ProjectAtlasLifecyclePayloadError)

function isPayloadError(cause: unknown): boolean
{
  return Schema.isSchemaError(cause) || isProjectAtlasLifecyclePayloadError(cause)
}

const make = Effect.gen(function* ()
{
  const delivery = yield* OrchestrationReactorDelivery
  const projection = yield* ProjectionSnapshotQuery
  const durableRunner = yield* DurableReactorRunner
  const lifecycle = yield* ProjectArchitectureLifecycleService
  const config = yield* ServerConfig

  const reconcileProjectArtifacts = Effect.gen(function* ()
  {
    const snapshot = yield* projection.getCommandReadModel()
    const liveProjectIds = new Set<string>(
      snapshot.projects
        .filter((project) => project.deletedAt === null)
        .map((project) => project.id),
    )
    const projectsRoot = NodePath.join(config.stateDir, 'cartographer', 'projects')
    const entries = yield* Effect.tryPromise({
      try: async () =>
      {
        await NodeFSP.mkdir(projectsRoot, { recursive: true })
        return NodeFSP.readdir(projectsRoot, { withFileTypes: true })
      },
      catch: (cause) => new ProjectAtlasReconcileFsError({ cause }),
    })
    const orphanIds = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          PROJECT_ID_PATH_SEGMENT.test(entry.name) &&
          !liveProjectIds.has(entry.name),
      )
      .map((entry) => ProjectId.make(entry.name))
    yield* Effect.forEach(
      orphanIds,
      (orphanId) =>
        lifecycle.closeProject(orphanId).pipe(
          Effect.andThen(lifecycle.deleteProjectArtifacts(orphanId)),
          Effect.catch((cause) =>
            Effect.logWarning('orphaned Project Atlas cleanup failed', {
              cause,
              projectId: orphanId,
            }),
          ),
        ),
      { discard: true },
    )
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning('Project Atlas startup reconciliation failed', { cause }),
    ),
  )

  const definition: DurableReactorDefinition = {
    reactorId: REACTOR_ID,
    operationVersion: OPERATION_VERSION,
    plan: (event) =>
    {
      if (event.type !== 'project.meta-updated' && event.type !== 'project.deleted')
      {
        return Effect.succeed([])
      }
      if (event.type === 'project.meta-updated' && event.payload.workspaceRoot === undefined)
      {
        return Effect.succeed([])
      }
      const effectKind =
        event.type === 'project.meta-updated' ? 'project-atlas.invalidate' : 'project-atlas.delete'
      const projectId = event.payload.projectId
      return encodeEventPayload(event).pipe(
        Effect.map((payloadJson) => [
          {
            outputIndex: 0,
            effectKind,
            targetKind: 'project',
            targetId: projectId,
            payloadJson,
          },
        ]),
      )
    },
    execute: Effect.fn('ProjectAtlasLifecycleReactor.execute')(function* (action)
    {
      const event = yield* decodeEventPayload(action.payloadJson)
      if (
        (event.type !== 'project.meta-updated' && event.type !== 'project.deleted') ||
        event.payload.projectId !== action.targetId
      )
      {
        return yield* new ProjectAtlasLifecyclePayloadError({
          detail: `Action ${action.actionId} does not contain its project lifecycle target.`,
        })
      }
      if (action.effectKind === 'project-atlas.invalidate')
      {
        if (event.type !== 'project.meta-updated' || event.payload.workspaceRoot === undefined)
        {
          return yield* new ProjectAtlasLifecyclePayloadError({
            detail: `Action ${action.actionId} is not a workspace-root update.`,
          })
        }
        yield* lifecycle.invalidateProjectMetadata(
          event.payload.projectId,
          event.payload.workspaceRoot,
        )
      }
      else if (action.effectKind === 'project-atlas.delete')
      {
        if (event.type !== 'project.deleted')
        {
          return yield* new ProjectAtlasLifecyclePayloadError({
            detail: `Action ${action.actionId} is not a project deletion.`,
          })
        }
        yield* lifecycle.closeProject(event.payload.projectId)
        yield* lifecycle.deleteProjectArtifacts(event.payload.projectId)
      }
      else
      {
        return yield* new ProjectAtlasLifecyclePayloadError({
          detail: `Unsupported Repository Map lifecycle effect '${action.effectKind}'.`,
        })
      }
      return { status: 'succeeded' as const }
    }),
    classify: (cause) => (isPayloadError(cause) ? 'poison' : 'retryable'),
    onLeaseExpiry: 'retryable',
  }

  const start: ProjectAtlasLifecycleReactorShape['start'] = Effect.fn(
    'ProjectAtlasLifecycleReactor.start',
  )(function* ()
  {
    yield* reconcileProjectArtifacts
    const startedAt = yield* nowIso
    const existingProgress = yield* delivery.getProgress(REACTOR_ID)
    const initialSequence = Option.isSome(existingProgress)
      ? 0
      : (yield* projection.getSnapshotSequence().pipe(
          Effect.mapError(
            (cause) =>
              new ReactorDeliveryError({
                operation: 'ProjectAtlasLifecycleReactor.start:initialSequence',
                cause,
              }),
          ),
        )).snapshotSequence
    const progress = yield* delivery.ensureProgress({
      reactorId: REACTOR_ID,
      operationVersion: OPERATION_VERSION,
      initialSequence,
      mode: 'durable',
      now: startedAt,
    })
    if (progress.mode === 'shadow')
    {
      yield* delivery.setMode({
        reactorId: REACTOR_ID,
        mode: 'durable',
        ownerId: `${REACTOR_ID}:cutover`,
        now: startedAt,
      })
    }
    yield* durableRunner.start(definition)
  })

  return {
    start,
    drain: durableRunner.drain(REACTOR_ID),
  } satisfies ProjectAtlasLifecycleReactorShape
})

export const ProjectAtlasLifecycleReactorLive = Layer.effect(
  ProjectAtlasLifecycleReactor,
  make,
).pipe(Layer.provideMerge(DurableReactorInfrastructureLive))
