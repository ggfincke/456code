// apps/web/src/components/chat/composer/ComposerPendingApprovalPanel.tsx
// render composer pending approval panel

import { memo } from 'react'
import { type PendingApproval } from '../../../session-logic'

interface ComposerPendingApprovalPanelProps
{
  approval: PendingApproval
  pendingCount: number
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

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps)
{
  const approvalSummary =
    approval.requestKind === 'mcp-elicitation'
      ? `${approval.appName ?? 'App'} approval requested`
      : approval.requestKind === 'command'
        ? 'Command approval requested'
        : approval.requestKind === 'file-read'
          ? 'File-read approval requested'
          : 'File-change approval requested'
  const detailLabel =
    approval.requestKind === 'mcp-elicitation'
      ? (approval.appName ?? 'Request')
      : approval.requestKind === 'command'
        ? 'Command'
        : approval.requestKind === 'file-read'
          ? 'File to read'
          : 'File change'
  const decisionLabel = requestedDecisionLabel(approval)
  const lifecycleLine =
    approval.status === 'responding'
      ? decisionLabel
        ? `${decisionLabel} sent. Waiting for provider confirmation.`
        : 'Response sent. Waiting for provider confirmation.'
      : approval.status === 'unknown'
        ? 'Response status is unknown. Refresh, or restart the turn before responding again.'
        : null

  return (
    <div className="min-w-0 px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {lifecycleLine ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {lifecycleLine}
        </p>
      ) : null}
      {approval.detail ? (
        <div className="mt-3 min-w-0 max-w-full rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          <pre
            aria-label={detailLabel}
            className="mt-2 min-w-0 max-w-full max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  )
})
