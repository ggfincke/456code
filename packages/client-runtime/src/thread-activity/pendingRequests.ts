// packages/client-runtime/src/thread-activity/pendingRequests.ts
// derives unresolved approval and user input requests across clients

import {
  type ApprovalOutcome,
  type ApprovalOutcomeStatus,
  ApprovalRequestId,
  type OrchestrationThreadActivity,
  type ProviderApprovalDecision,
  type UserInputQuestion,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'

export interface PendingApproval
{
  readonly requestId: ApprovalRequestId
  readonly requestKind: 'command' | 'file-read' | 'file-change'
  readonly createdAt: string
  readonly status?: ApprovalOutcomeStatus
  readonly requestedDecision?: ProviderApprovalDecision
  readonly detail?: string
  readonly actionId?: string
}

export interface PendingUserInput
{
  readonly requestId: ApprovalRequestId
  readonly createdAt: string
  readonly questions: ReadonlyArray<UserInputQuestion>
}

export function requestKindFromRequestType(
  requestType: unknown,
): PendingApproval['requestKind'] | null
{
  switch (requestType)
  {
    case 'command_execution_approval':
    case 'exec_command_approval':
    case 'dynamic_tool_call':
      return 'command'
    case 'file_read_approval':
      return 'file-read'
    case 'file_change_approval':
    case 'apply_patch_approval':
      return 'file-change'
    default:
      return null
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean
{
  const normalized = detail?.toLowerCase()
  if (!normalized)
  {
    return false
  }
  return (
    normalized.includes('stale pending approval request') ||
    normalized.includes('stale pending user-input request') ||
    normalized.includes('unknown pending approval request') ||
    normalized.includes('unknown pending permission request') ||
    normalized.includes('unknown pending user-input request') ||
    normalized.includes('unknown pending user input request') ||
    normalized.includes('unknown pending codex user input request')
  )
}

function parseRequestId(value: unknown): ApprovalRequestId | null
{
  return typeof value === 'string' && value.length > 0 ? ApprovalRequestId.make(value) : null
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null
{
  const questions = payload?.questions
  if (!Array.isArray(questions))
  {
    return null
  }

  const parsed = questions
    .map<UserInputQuestion | null>((entry) =>
    {
      if (!entry || typeof entry !== 'object') return null
      const question = entry as Record<string, unknown>
      if (
        typeof question.id !== 'string' ||
        typeof question.header !== 'string' ||
        typeof question.question !== 'string' ||
        !Array.isArray(question.options)
      )
      {
        return null
      }
      const options = question.options
        .map<UserInputQuestion['options'][number] | null>((option) =>
        {
          if (!option || typeof option !== 'object') return null
          const optionRecord = option as Record<string, unknown>
          if (
            typeof optionRecord.label !== 'string' ||
            typeof optionRecord.description !== 'string'
          )
          {
            return null
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          }
        })
        .filter((option): option is UserInputQuestion['options'][number] => option !== null)
      if (options.length === 0)
      {
        return null
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      }
    })
    .filter((question): question is UserInputQuestion => question !== null)
  return parsed.length > 0 ? parsed : null
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  approvalOutcomes: ReadonlyArray<ApprovalOutcome> = [],
): PendingApproval[]
{
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>()
  const ordered = [...activities].toSorted(compareOrchestrationThreadActivities)

  for (const activity of ordered)
  {
    const payload =
      activity.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : null
    const requestId = parseRequestId(payload?.requestId)
    const requestKind =
      payload?.requestKind === 'command' ||
      payload?.requestKind === 'file-read' ||
      payload?.requestKind === 'file-change'
        ? payload.requestKind
        : requestKindFromRequestType(payload?.requestType)
    const detail = typeof payload?.detail === 'string' ? payload.detail : undefined

    if (activity.kind === 'approval.requested' && requestId && requestKind)
    {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      })
      continue
    }

    if (activity.kind === 'approval.resolved' && requestId)
    {
      openByRequestId.delete(requestId)
      continue
    }

    if (
      activity.kind === 'provider.approval.respond.failed' &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    )
    {
      openByRequestId.delete(requestId)
    }
  }

  for (const outcome of approvalOutcomes)
  {
    if (outcome.status === 'accepted' || outcome.status === 'stale-terminal')
    {
      openByRequestId.delete(outcome.requestId)
      continue
    }

    const approval = openByRequestId.get(outcome.requestId)
    if (approval === undefined)
    {
      continue
    }
    openByRequestId.set(outcome.requestId, {
      ...approval,
      status: outcome.status,
      ...(outcome.requestedDecision === undefined
        ? {}
        : { requestedDecision: outcome.requestedDecision }),
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      ...(outcome.actionId === undefined ? {} : { actionId: outcome.actionId }),
    })
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[]
{
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>()
  const ordered = [...activities].toSorted(compareOrchestrationThreadActivities)

  for (const activity of ordered)
  {
    const payload =
      activity.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : null
    const requestId = parseRequestId(payload?.requestId)
    const detail = typeof payload?.detail === 'string' ? payload.detail : undefined

    if (activity.kind === 'user-input.requested' && requestId)
    {
      const questions = parseUserInputQuestions(payload)
      if (!questions)
      {
        continue
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      })
      continue
    }

    if (activity.kind === 'user-input.resolved' && requestId)
    {
      openByRequestId.delete(requestId)
      continue
    }

    if (
      activity.kind === 'provider.user-input.respond.failed' &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    )
    {
      openByRequestId.delete(requestId)
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )
}
