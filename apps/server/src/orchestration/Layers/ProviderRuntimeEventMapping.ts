// apps/server/src/orchestration/Layers/ProviderRuntimeEventMapping.ts
// maps provider runtime events into orchestration activities

import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ContextWindowUpdatedActivityPayload,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from '@t3tools/contracts'

export function matchesProviderInstanceFence(
  expectedProviderInstanceId: ProviderInstanceId,
  actualProviderInstanceId: ProviderInstanceId | undefined,
): boolean
{
  return actualProviderInstanceId === expectedProviderInstanceId
}

export function runtimeEventMatchesThreadProviderInstance(
  event: ProviderRuntimeEvent,
  thread: Pick<OrchestrationThread, 'modelSelection' | 'session'>,
): boolean
{
  const expectedProviderInstanceId =
    thread.session?.providerInstanceId ?? thread.modelSelection.instanceId
  return matchesProviderInstanceFence(expectedProviderInstanceId, event.providerInstanceId)
}

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined
{
  return value === undefined ? undefined : TurnId.make(String(value))
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined
{
  return value === undefined ? undefined : ApprovalRequestId.make(value)
}

function truncateDetail(value: string, limit = 180): string
{
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ContextWindowUpdatedActivityPayload | undefined
{
  if (event.type !== 'thread.token-usage.updated' || event.payload.usage.usedTokens <= 0)
  {
    return undefined
  }
  // tag the snapshot with provider identity so usage displays never attribute
  // one provider's context numbers to another after a mid-thread switch
  return {
    ...event.payload.usage,
    provider: event.provider,
    ...(event.providerInstanceId !== undefined
      ? { providerInstanceId: event.providerInstanceId }
      : {}),
  }
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): 'command' | 'file-read' | 'file-change' | undefined
{
  switch (requestType)
  {
    case 'command_execution_approval':
    case 'exec_command_approval':
      return 'command'
    case 'file_read_approval':
      return 'file-read'
    case 'file_change_approval':
    case 'apply_patch_approval':
      return 'file-change'
    default:
      return undefined
  }
}

// tool.progress frames for subagent-owned tools carry "task:<id>" as summary
export function taskIdFromToolProgressSummary(summary: string | undefined): string | undefined
{
  if (!summary?.startsWith('task:'))
  {
    return undefined
  }
  const taskId = summary.slice('task:'.length).trim()
  return taskId.length > 0 ? taskId : undefined
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
  parentToolUseId?: string,
): ReadonlyArray<OrchestrationThreadActivity>
{
  const maybeSequence = (() =>
  {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number }
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {}
  })()
  switch (event.type)
  {
    case 'request.opened':
    {
      if (event.payload.requestType === 'tool_user_input')
      {
        return []
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType)
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'approval',
          kind: 'approval.requested',
          summary:
            requestKind === 'command'
              ? 'Command approval requested'
              : requestKind === 'file-read'
                ? 'File-read approval requested'
                : requestKind === 'file-change'
                  ? 'File-change approval requested'
                  : 'Approval requested',
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'request.resolved':
    {
      if (event.payload.requestType === 'tool_user_input')
      {
        return []
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType)
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'approval',
          kind: 'approval.resolved',
          summary: 'Approval resolved',
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'runtime.error':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'error',
          kind: 'runtime.error',
          summary: 'Runtime error',
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'tool.denied':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'error',
          kind: 'tool.denied',
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'runtime.warning':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'runtime.warning',
          // use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'turn.plan.updated':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'turn.plan.updated',
          summary: 'Plan updated',
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'user-input.requested':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'user-input.requested',
          summary: 'User input requested',
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'user-input.resolved':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'user-input.resolved',
          summary: 'User input submitted',
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'task.started':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'task.started',
          summary:
            event.payload.taskType === 'plan'
              ? 'Plan task started'
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : 'Task started',
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.workflowName ? { workflowName: event.payload.workflowName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'task.progress':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'task.progress',
          summary:
            event.payload.description.trim().length > 0
              ? truncateDetail(event.payload.description, 120)
              : 'Reasoning update',
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description.trim().length > 0
              ? { title: truncateDetail(event.payload.description, 120) }
              : {}),
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.tokenUsage !== undefined
              ? { tokenUsage: event.payload.tokenUsage }
              : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'task.completed':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === 'failed' ? 'error' : 'info',
          kind: 'task.completed',
          summary:
            event.payload.status === 'failed'
              ? 'Task failed'
              : event.payload.status === 'stopped'
                ? 'Task stopped'
                : 'Task completed',
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.tokenUsage !== undefined
              ? { tokenUsage: event.payload.tokenUsage }
              : {}),
            ...(event.payload.totalToolUseCount !== undefined
              ? { totalToolUseCount: event.payload.totalToolUseCount }
              : {}),
            ...(event.payload.totalDurationMs !== undefined
              ? { totalDurationMs: event.payload.totalDurationMs }
              : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'tool.progress':
    {
      const taskId = taskIdFromToolProgressSummary(event.payload.summary)
      const summary = taskId === undefined ? event.payload.summary : undefined
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'tool',
          kind: 'tool.progress',
          summary:
            summary ??
            (event.payload.toolName ? `${event.payload.toolName} in progress` : 'Tool in progress'),
          payload: {
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(summary ? { summary: truncateDetail(summary) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'tool.summary':
    {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'tool',
          kind: 'tool.summary',
          summary: truncateDetail(event.payload.summary, 120),
          payload: {
            summary: truncateDetail(event.payload.summary),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'thread.state.changed':
    {
      if (event.payload.state !== 'compacted')
      {
        return []
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'context-compaction',
          summary: 'Context compacted',
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'thread.token-usage.updated':
    {
      const payload = buildContextWindowActivityPayload(event)
      if (!payload)
      {
        return []
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'context-window.updated',
          summary: 'Context window updated',
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'item.updated':
    {
      if (!isToolLifecycleItemType(event.payload.itemType))
      {
        return []
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'tool',
          kind: 'tool.updated',
          summary: event.payload.title ?? 'Tool updated',
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'item.completed':
    {
      if (!isToolLifecycleItemType(event.payload.itemType))
      {
        return []
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'tool',
          kind: 'tool.completed',
          summary: event.payload.title ?? 'Tool',
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    case 'item.started':
    {
      if (!isToolLifecycleItemType(event.payload.itemType))
      {
        return []
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'tool',
          kind: 'tool.started',
          summary: `${event.payload.title ?? 'Tool'} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    default:
      break
  }

  return []
}
