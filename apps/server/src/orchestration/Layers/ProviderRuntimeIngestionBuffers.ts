// apps/server/src/orchestration/Layers/ProviderRuntimeIngestionBuffers.ts
// cache capacities/TTL and task-buffer lookup helpers for runtime ingestion

import { MessageId, ThreadId, TurnId, type OrchestrationThreadActivity } from '@t3tools/contracts'
import * as Duration from 'effect/Duration'

export const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`
export const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`

// fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
export function findTaskTitleInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): string | undefined
{
  if (!activities)
  {
    return undefined
  }
  for (let index = activities.length - 1; index >= 0; index -= 1)
  {
    const activity = activities[index]
    if (!activity || (activity.kind !== 'task.started' && activity.kind !== 'task.progress'))
    {
      continue
    }
    const payload =
      activity.payload && typeof activity.payload === 'object'
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined
    if (payload?.taskId !== taskId)
    {
      continue
    }
    const title =
      typeof payload.title === 'string'
        ? payload.title
        : activity.kind === 'task.started' && typeof payload.detail === 'string'
          ? payload.detail
          : undefined
    if (title && title.trim().length > 0)
    {
      return title
    }
  }
  return undefined
}

// walk newest-first for the task's most recent recorded tool_use id
export function findTaskToolUseIdInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): string | undefined
{
  if (!activities)
  {
    return undefined
  }
  for (let index = activities.length - 1; index >= 0; index -= 1)
  {
    const activity = activities[index]
    if (!activity || !activity.kind.startsWith('task.'))
    {
      continue
    }
    const payload =
      activity.payload && typeof activity.payload === 'object'
        ? (activity.payload as { taskId?: unknown; toolUseId?: unknown })
        : undefined
    if (
      payload?.taskId === taskId &&
      typeof payload.toolUseId === 'string' &&
      payload.toolUseId.length > 0
    )
    {
      return payload.toolUseId
    }
  }
  return undefined
}

export interface AssistantSegmentState
{
  baseKey: string
  nextSegmentIndex: number
  activeMessageId: MessageId | null
}

export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000
export const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120)
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120)
export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000
export const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120)
export const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000
export const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120)
export const TASK_TOOL_USE_ID_BY_TASK_CACHE_CAPACITY = 10_000
export const TASK_TOOL_USE_ID_BY_TASK_TTL = Duration.minutes(120)
export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000
