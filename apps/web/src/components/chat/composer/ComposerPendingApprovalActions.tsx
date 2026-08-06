// apps/web/src/components/chat/composer/ComposerPendingApprovalActions.tsx
// render composer pending approval actions

import { type ApprovalRequestId, type ProviderApprovalDecision } from '@t3tools/contracts'
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
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
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
      <Button size="sm" variant="ghost" disabled={isResponding} onClick={() => respond('cancel')}>
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => respond('decline')}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() => respond('acceptForSession')}
      >
        Always allow this session
      </Button>
      <Button size="sm" variant="default" disabled={isResponding} onClick={() => respond('accept')}>
        Approve once
      </Button>
    </>
  )
})
