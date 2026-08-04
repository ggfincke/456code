// packages/shared/src/approvalOutcomeClassifier.ts
// classify approval failures for consistent blocking accounting

import type { ApprovalOutcomeStatus } from '@t3tools/contracts'

export interface ApprovalFailureClassification
{
  readonly status: ApprovalOutcomeStatus
  readonly clearsBlockingRequest: boolean
}

export function classifyApprovalFailure(payload: unknown): ApprovalFailureClassification
{
  const failurePayload =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null
  const embeddedOutcome =
    typeof failurePayload?.approvalOutcome === 'object' && failurePayload.approvalOutcome !== null
      ? (failurePayload.approvalOutcome as Record<string, unknown>)
      : null
  const embeddedStatus = embeddedOutcome?.status

  switch (embeddedStatus)
  {
    case 'accepted':
    case 'stale-terminal':
      return { status: embeddedStatus, clearsBlockingRequest: true }
    case 'pending':
    case 'responding':
    case 'unknown':
      return { status: embeddedStatus, clearsBlockingRequest: false }
    default:
      break
  }

  const detail =
    typeof failurePayload?.detail === 'string' ? failurePayload.detail.toLowerCase() : null
  const clearsBlockingRequest =
    detail !== null &&
    (detail.includes('stale pending approval request') ||
      detail.includes('unknown pending approval request') ||
      detail.includes('unknown pending permission request') ||
      detail.includes('stale pending user-input request') ||
      detail.includes('unknown pending user-input request') ||
      detail.includes('unknown pending user input request') ||
      detail.includes('unknown pending codex user input request'))

  return {
    status: clearsBlockingRequest ? 'stale-terminal' : 'unknown',
    clearsBlockingRequest,
  }
}
