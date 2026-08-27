// tests/apps/mobile/features/threads/activity/pendingApprovalPresentation.test.ts
// verifies mobile approval cards preserve dynamic server labels and app context

import { ApprovalRequestId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { derivePendingApprovalPresentation } from '../../../../../../apps/mobile/src/features/threads/activity/pendingApprovalPresentation'

describe('derivePendingApprovalPresentation', () =>
{
  it('renders MCP app context and every server-provided approval choice', () =>
  {
    expect(
      derivePendingApprovalPresentation({
        requestId: ApprovalRequestId.make('approval-1'),
        requestKind: 'mcp-elicitation',
        createdAt: '2026-08-26T12:00:00.000Z',
        appName: 'Calendar',
        options: [
          { decision: 'accept', label: 'Allow this event' },
          { decision: 'acceptAlways', label: 'Always allow Calendar' },
          { decision: 'decline', label: 'Not now' },
        ],
      }),
    ).toEqual({
      title: 'Calendar',
      contextLabel: 'MCP elicitation',
      options: [
        { decision: 'accept', label: 'Allow this event' },
        { decision: 'acceptAlways', label: 'Always allow Calendar' },
        { decision: 'decline', label: 'Not now' },
      ],
    })
  })

  it('uses the supervised defaults when the server supplies no choices', () =>
  {
    expect(
      derivePendingApprovalPresentation({
        requestId: ApprovalRequestId.make('approval-2'),
        requestKind: 'file-change',
        createdAt: '2026-08-26T12:00:00.000Z',
      }),
    ).toEqual({
      title: 'File change',
      contextLabel: null,
      options: [
        { decision: 'accept', label: 'Allow once' },
        { decision: 'acceptForSession', label: 'Allow session' },
        { decision: 'decline', label: 'Decline' },
      ],
    })
  })
})
