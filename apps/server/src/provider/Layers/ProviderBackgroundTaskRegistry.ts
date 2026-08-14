// apps/server/src/provider/Layers/ProviderBackgroundTaskRegistry.ts
// maintains in-memory background-task liveness for exact provider sessions

import type { ProviderRuntimeEvent, RuntimeTaskId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'

import type { ProviderAdapterRuntimeSessionBinding } from '../Services/ProviderAdapter.ts'
import {
  ProviderBackgroundTaskRegistry,
  type ProviderBackgroundTaskRegistryShape,
} from '../Services/ProviderBackgroundTaskRegistry.ts'

type LiveTasksBySession = ReadonlyMap<string, ReadonlySet<RuntimeTaskId>>

const sessionKey = (identity: ProviderAdapterRuntimeSessionBinding): string =>
  JSON.stringify([identity.providerInstanceId, identity.threadId, identity.sessionGeneration])

const makeProviderBackgroundTaskRegistry = Effect.gen(function* ()
{
  const liveTasksBySession = yield* Ref.make<LiveTasksBySession>(new Map())

  const addTask = (identity: ProviderAdapterRuntimeSessionBinding, taskId: RuntimeTaskId) =>
    Ref.update(liveTasksBySession, (current) =>
    {
      const key = sessionKey(identity)
      const currentTasks = current.get(key)
      if (currentTasks?.has(taskId) === true)
      {
        return current
      }
      const nextTasks = new Set(currentTasks ?? [])
      nextTasks.add(taskId)
      const next = new Map(current)
      next.set(key, nextTasks)
      return next
    })

  const removeTask = (identity: ProviderAdapterRuntimeSessionBinding, taskId: RuntimeTaskId) =>
    Ref.update(liveTasksBySession, (current) =>
    {
      const key = sessionKey(identity)
      const currentTasks = current.get(key)
      if (currentTasks?.has(taskId) !== true)
      {
        return current
      }
      const nextTasks = new Set(currentTasks)
      nextTasks.delete(taskId)
      const next = new Map(current)
      if (nextTasks.size === 0)
      {
        next.delete(key)
      }
      else
      {
        next.set(key, nextTasks)
      }
      return next
    })

  const clearSession = (identity: ProviderAdapterRuntimeSessionBinding) =>
    Ref.update(liveTasksBySession, (current) =>
    {
      const key = sessionKey(identity)
      if (!current.has(key))
      {
        return current
      }
      const next = new Map(current)
      next.delete(key)
      return next
    })

  const observeAcceptedRuntimeEvent: ProviderBackgroundTaskRegistryShape['observeAcceptedRuntimeEvent'] =
    Effect.fn('ProviderBackgroundTaskRegistry.observeAcceptedRuntimeEvent')(function* (
      binding,
      event: ProviderRuntimeEvent,
    )
    {
      switch (event.type)
      {
        case 'task.started':
        case 'task.progress':
          yield* addTask(binding, event.payload.taskId)
          return
        case 'task.completed':
          yield* removeTask(binding, event.payload.taskId)
          return
        case 'session.exited':
          yield* clearSession(binding)
          return
        default:
          return
      }
    })

  const hasLiveTasks: ProviderBackgroundTaskRegistryShape['hasLiveTasks'] = (identity) =>
    Ref.get(liveTasksBySession).pipe(
      Effect.map((current) => (current.get(sessionKey(identity))?.size ?? 0) > 0),
    )

  return ProviderBackgroundTaskRegistry.of({
    observeAcceptedRuntimeEvent,
    hasLiveTasks,
  })
})

export const ProviderBackgroundTaskRegistryLive = Layer.effect(
  ProviderBackgroundTaskRegistry,
  makeProviderBackgroundTaskRegistry,
)
