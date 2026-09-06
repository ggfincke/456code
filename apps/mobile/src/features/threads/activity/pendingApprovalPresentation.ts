// apps/mobile/src/features/threads/activity/pendingApprovalPresentation.ts
// derives mobile approval labels and choices from the server-provided request

import type { ApprovalRequestId, ProviderApprovalOption } from '@t3tools/contracts'

import type { PendingApproval } from '../../../lib/threadActivity'

const defaultApprovalOptions: ReadonlyArray<ProviderApprovalOption> = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow session' },
  { decision: 'decline', label: 'Decline' },
]

function requestKindLabel(requestKind: PendingApproval['requestKind']): string
{
  switch (requestKind)
  {
    case 'command':
      return 'Command'
    case 'file-read':
      return 'File read'
    case 'file-change':
      return 'File change'
    case 'mcp-elicitation':
      return 'MCP elicitation'
  }
}

export interface PendingApprovalPresentation
{
  readonly title: string
  readonly contextLabel: string | null
  readonly lifecycleLabel: string | null
  readonly options: ReadonlyArray<ProviderApprovalOption>
}

function requestedDecisionLabel(approval: PendingApproval): string | null
{
  const optionLabel = approval.options?.find(
    (option) => option.decision === approval.requestedDecision,
  )?.label
  if (optionLabel)
  {
    return optionLabel
  }
  switch (approval.requestedDecision)
  {
    case 'accept':
      return 'Approve once'
    case 'acceptForSession':
      return 'Always allow this session'
    case 'acceptAlways':
      return 'Always allow'
    case 'decline':
      return 'Decline'
    case 'cancel':
      return 'Cancel turn'
    default:
      return null
  }
}

export function isApprovalResponseLocked(
  approval: PendingApproval,
  respondingApprovalId: ApprovalRequestId | null,
): boolean
{
  return (
    respondingApprovalId === approval.requestId ||
    approval.status === 'responding' ||
    approval.status === 'unknown'
  )
}

export function derivePendingApprovalPresentation(
  approval: PendingApproval,
): PendingApprovalPresentation
{
  const kindLabel = requestKindLabel(approval.requestKind)
  const decisionLabel = requestedDecisionLabel(approval)
  return {
    title: approval.appName ?? kindLabel,
    contextLabel: approval.appName ? kindLabel : null,
    lifecycleLabel:
      approval.status === 'responding'
        ? decisionLabel
          ? `${decisionLabel} sent. Waiting for provider confirmation.`
          : 'Response sent. Waiting for provider confirmation.'
        : approval.status === 'unknown'
          ? 'Response status is unknown. Refresh, or restart the turn before responding again.'
          : null,
    options: approval.options?.length ? approval.options : defaultApprovalOptions,
  }
}
