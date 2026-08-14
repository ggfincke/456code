// apps/server/src/cartographer/ProjectAtlasStatusBroadcaster.ts
// publishes snapshot-first project atlas status streams

// @effect-diagnostics preferSchemaOverJson:off

import { type ProjectAtlasStatus, type ProjectId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'

interface ProjectAtlasStatusChange
{
  readonly projectId: ProjectId
  readonly status: ProjectAtlasStatus
}

interface ProjectAtlasStatusUpdateResult
{
  readonly status: ProjectAtlasStatus
  readonly changed: boolean
}

export interface ProjectAtlasStatusSubscriptionLifecycle
{
  readonly retain: Effect.Effect<void>
  readonly release: Effect.Effect<void>
}

export interface ProjectAtlasStatusBroadcasterShape
{
  readonly getStatus: (projectId: ProjectId) => Effect.Effect<ProjectAtlasStatus>
  readonly update: (
    projectId: ProjectId,
    update: (current: ProjectAtlasStatus) => ProjectAtlasStatus,
  ) => Effect.Effect<ProjectAtlasStatus>
  readonly streamStatus: (
    projectId: ProjectId,
    lifecycle: ProjectAtlasStatusSubscriptionLifecycle,
  ) => Stream.Stream<ProjectAtlasStatus>
}

export class ProjectAtlasStatusBroadcaster extends Context.Service<
  ProjectAtlasStatusBroadcaster,
  ProjectAtlasStatusBroadcasterShape
>()('456code/cartographer/ProjectAtlasStatusBroadcaster')
{}

function initialStatus(): ProjectAtlasStatus
{
  return {
    state: 'idle',
    source: null,
    freshness: {
      builtAt: null,
      dirty: true,
    },
    lastBuildError: null,
  }
}

export const make = Effect.gen(function* ()
{
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ProjectAtlasStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  )
  const statuses = yield* Ref.make(new Map<ProjectId, ProjectAtlasStatus>())

  const getStatus: ProjectAtlasStatusBroadcasterShape['getStatus'] = (projectId) =>
    Ref.get(statuses).pipe(Effect.map((current) => current.get(projectId) ?? initialStatus()))

  const update: ProjectAtlasStatusBroadcasterShape['update'] = (projectId, updateStatus) =>
    Effect.gen(function* ()
    {
      const result = yield* Ref.modify(
        statuses,
        (
          current,
        ): readonly [ProjectAtlasStatusUpdateResult, Map<ProjectId, ProjectAtlasStatus>] =>
        {
          const previous = current.get(projectId) ?? initialStatus()
          const next = updateStatus(previous)
          if (JSON.stringify(previous) === JSON.stringify(next))
          {
            return [{ status: next, changed: false }, current]
          }
          const updated = new Map(current)
          updated.set(projectId, next)
          return [{ status: next, changed: true }, updated]
        },
      )
      if (result.changed)
      {
        yield* PubSub.publish(changes, { projectId, status: result.status })
      }
      return result.status
    })

  const streamStatus: ProjectAtlasStatusBroadcasterShape['streamStatus'] = (projectId, lifecycle) =>
    Stream.unwrap(
      Effect.gen(function* ()
      {
        yield* lifecycle.retain
        const subscription = yield* PubSub.subscribe(changes)
        const snapshot = yield* getStatus(projectId)
        return Stream.concat(
          Stream.make(snapshot),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.projectId === projectId),
            Stream.map((change) => change.status),
          ),
        ).pipe(Stream.ensuring(lifecycle.release.pipe(Effect.ignore, Effect.asVoid)))
      }),
    )

  return ProjectAtlasStatusBroadcaster.of({ getStatus, update, streamStatus })
})

export const layer = Layer.effect(ProjectAtlasStatusBroadcaster, make)
