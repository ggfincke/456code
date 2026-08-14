// apps/server/src/orchestration/Layers/ProviderRuntimeEventMapping.ts
// maps provider runtime events into orchestration activities

import {
  ApprovalRequestId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ContextWindowUpdatedActivityPayload,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from '@t3tools/contracts'
import { isToolLifecycleItemType } from '@t3tools/shared/toolActivity'

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

// mirrors the compact token convention the web timeline already uses so a server-authored
// summary and a client-formatted one do not read as two different units
function formatCompactTokens(totalTokens: number): string
{
  if (totalTokens < 1_000)
  {
    return `${totalTokens}`
  }
  if (totalTokens < 1_000_000)
  {
    return `${(totalTokens / 1_000).toFixed(totalTokens < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`
  }
  return `${(totalTokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

function formatCompactDuration(durationMs: number): string
{
  return durationMs < 1_000 ? `${durationMs}ms` : `${Math.round(durationMs / 1_000)}s`
}

// absolute instant, trimmed to the minute. never a relative phrase: the limit this row exists
// for was a seven-day window, and 'try again shortly' would have been wrong by six days
function formatResetInstant(resetsAt: string): string
{
  return `${resetsAt.slice(0, 16).replace('T', ' ')} UTC`
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

// * the runtime item id IS the provider's tool call id for a tool item: claude uses the
// tool_use block id, acp uses the acp toolCallId, opencode uses part.callID. projecting it
// into data.toolCallId is what lets a client pair an open frame with its close frame by
// identity rather than by label, so two concurrent calls to the same tool stop closing each
// other's rows. an adapter that already wrote data.toolCallId keeps its own value
function withToolCallId(data: unknown, itemId: string | undefined): unknown
{
  if (itemId === undefined)
  {
    return data
  }
  if (data === undefined)
  {
    return { toolCallId: itemId }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
  {
    return data
  }
  const record = data as Record<string, unknown>
  const existing = record.toolCallId
  if (typeof existing === 'string' && existing.trim().length > 0)
  {
    return data
  }
  return { ...record, toolCallId: itemId }
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

    // a heartbeat's toolUseId is already the provider's tool call id -- the same namespace the
    // item lifecycle cases now project into data.toolCallId -- so it is forwarded as-is. the
    // base event.itemId is deliberately NOT projected here: codex heartbeats carry no tool id
    // and whether their base item id names the same item as their lifecycle frames is unverified
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

    // the session is still working, but it is working on the context rather than the task.
    // without this row a compaction is a multi-minute freeze with nothing on screen at all
    case 'session.state.changed':
    {
      // the guard is load-bearing: every adapter emits this event for ordinary lifecycle
      // transitions, and only a Claude compaction can carry the 'compacting' state
      if (event.payload.state !== 'compacting')
      {
        return []
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'context-compaction.started',
          summary: 'Compacting context',
          payload: {
            state: event.payload.state,
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

      const compaction = event.payload.compaction
      // the bare-string fallback is required: providers other than Claude reach this arm with
      // no compaction metadata at all, and they still deserve the row
      const summary = (() =>
      {
        if (compaction === undefined)
        {
          return 'Context compacted'
        }
        const sizes =
          compaction.preTokens !== undefined && compaction.postTokens !== undefined
            ? ` ${formatCompactTokens(compaction.preTokens)} -> ${formatCompactTokens(compaction.postTokens)} tokens`
            : ''
        const took =
          compaction.durationMs !== undefined
            ? ` in ${formatCompactDuration(compaction.durationMs)}`
            : ''
        return `Context compacted:${sizes}${took} (${compaction.trigger})`
      })()

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'info',
          kind: 'context-compaction',
          summary,
          payload: {
            state: event.payload.state,
            ...(compaction !== undefined ? { compaction } : {}),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ]
    }

    // the pre-failure warning a provider streams before it starts rejecting turns. it used to
    // land in an untyped payload with no case here at all, so the one signal that could have
    // stopped a 29-hour run was received and dropped on the floor
    case 'account.rate-limits.updated':
    {
      const snapshot = event.payload.snapshot
      // 'allowed' is the steady state and would write a row on every window tick
      if (snapshot === undefined || snapshot.status === 'allowed')
      {
        return []
      }

      const scope = snapshot.windowId ? ` (${snapshot.windowId})` : ''
      const used =
        snapshot.utilization !== undefined ? `, ${Math.round(snapshot.utilization)}% used` : ''
      // say what resets and when, or say nothing about timing. a relative phrase here would
      // reintroduce exactly the false reassurance this row exists to prevent
      const resets = snapshot.resetsAt ? `, resets ${formatResetInstant(snapshot.resetsAt)}` : ''

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: 'error',
          kind: 'account.rate-limit.warning',
          summary:
            snapshot.status === 'rejected'
              ? `Plan limit reached${scope}${resets}`
              : `Approaching plan limit${scope}${used}${resets}`,
          payload: {
            status: snapshot.status,
            ...(snapshot.windowId ? { windowId: snapshot.windowId } : {}),
            ...(snapshot.utilization !== undefined ? { utilization: snapshot.utilization } : {}),
            ...(snapshot.resetsAt ? { resetsAt: snapshot.resetsAt } : {}),
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
      const data = withToolCallId(event.payload.data, event.itemId)
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
            ...(data !== undefined ? { data } : {}),
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
      const data = withToolCallId(event.payload.data, event.itemId)
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
            ...(data !== undefined ? { data } : {}),
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
