// apps/mobile/src/lib/thread-activity/pending.ts
// derives mobile approval and user input request state
import type { OrchestrationThreadActivity, UserInputQuestion } from '@t3tools/contracts'
import { ApprovalRequestId } from '@t3tools/contracts'

import * as Arr from 'effect/Array'
import * as Order from 'effect/Order'
export interface PendingApproval
{
  readonly requestId: ApprovalRequestId
  readonly requestKind: 'command' | 'file-read' | 'file-change'
  readonly createdAt: string
  readonly detail?: string
}

export interface PendingUserInput
{
  readonly requestId: ApprovalRequestId
  readonly createdAt: string
  readonly questions: ReadonlyArray<UserInputQuestion>
}

export interface PendingUserInputDraftAnswer
{
  readonly selectedOptionLabel?: string
  readonly customAnswer?: string
}

export function requestKindFromRequestType(
  requestType: unknown,
): PendingApproval['requestKind'] | null
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
    normalized.includes('unknown pending user-input request')
  )
}

function parseApprovalRequestId(value: unknown): ApprovalRequestId | null
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
          const record = option as Record<string, unknown>
          if (typeof record.label !== 'string' || typeof record.description !== 'string')
          {
            return null
          }
          return {
            label: record.label,
            description: record.description,
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

function normalizeDraftAnswer(value: string | undefined): string | null
{
  if (typeof value !== 'string')
  {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): string | null
{
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer)
  if (customAnswer)
  {
    return customAnswer
  }
  return normalizeDraftAnswer(draft?.selectedOptionLabel)
}

export function derivePendingApprovals(
  sortedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[]
{
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>()

  for (const activity of sortedActivities)
  {
    const payload =
      activity.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : null
    const requestId = parseApprovalRequestId(payload?.requestId)
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

  return Arr.sortWith([...openByRequestId.values()], (s) => new Date(s.createdAt), Order.Date)
}

export function derivePendingUserInputs(
  sortedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[]
{
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>()

  for (const activity of sortedActivities)
  {
    const payload =
      activity.payload && typeof activity.payload === 'object'
        ? (activity.payload as Record<string, unknown>)
        : null
    const requestId = parseApprovalRequestId(payload?.requestId)
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

  return Arr.sortWith(openByRequestId.values(), (s) => new Date(s.createdAt), Order.Date)
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer
{
  const selectedOptionLabel =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabel
  return {
    customAnswer,
    ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
  }
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string> | null
{
  const answers: Record<string, string> = {}

  for (const question of questions)
  {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id])
    if (!answer)
    {
      return null
    }
    answers[question.id] = answer
  }

  return answers
}
