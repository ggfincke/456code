// apps/web/src/components/chat/composer/ComposerPendingApprovalActions.tsx
// render composer pending approval actions

import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from '@t3tools/contracts'
import { memo } from 'react'
import { Button } from '../../ui/button'

interface ComposerPendingApprovalActionsProps
{
  requestId: ApprovalRequestId
  isResponding: boolean
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>
  options: ReadonlyArray<ProviderApprovalOption> | undefined
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: 'cancel', label: 'Cancel turn' },
  { decision: 'decline', label: 'Decline' },
  { decision: 'acceptForSession', label: 'Always allow this session' },
  { decision: 'accept', label: 'Approve once' },
]

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
  options,
}: ComposerPendingApprovalActionsProps)
{
  const respond = (decision: ProviderApprovalDecision) =>
  {
    if (isResponding)
    {
      return
    }
    void onRespondToApproval(requestId, decision)
  }

  return (
    <>
      {(options?.length ? options : DEFAULT_APPROVAL_OPTIONS).map((option) => (
        <Button
          key={option.decision}
          size="sm"
          variant={
            option.decision === 'decline'
              ? 'destructive-outline'
              : option.decision === 'cancel'
                ? 'ghost'
                : option.decision === 'accept'
                  ? 'default'
                  : 'outline'
          }
          disabled={isResponding}
          onClick={() => respond(option.decision)}
        >
          {option.label}
        </Button>
      ))}
    </>
  )
})
