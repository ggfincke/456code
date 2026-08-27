// apps/mobile/src/features/threads/activity/pendingApprovalPresentation.ts
// derives mobile approval labels and choices from the server-provided request

import type { ProviderApprovalOption } from '@t3tools/contracts'

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
  readonly options: ReadonlyArray<ProviderApprovalOption>
}

export function derivePendingApprovalPresentation(
  approval: PendingApproval,
): PendingApprovalPresentation
{
  const kindLabel = requestKindLabel(approval.requestKind)
  return {
    title: approval.appName ?? kindLabel,
    contextLabel: approval.appName ? kindLabel : null,
    options: approval.options?.length ? approval.options : defaultApprovalOptions,
  }
}
