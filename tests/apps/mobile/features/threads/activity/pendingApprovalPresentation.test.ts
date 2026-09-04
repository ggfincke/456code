// tests/apps/mobile/features/threads/activity/pendingApprovalPresentation.test.ts
// verifies mobile approval cards preserve dynamic server labels and app context

import { ApprovalRequestId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  derivePendingApprovalPresentation,
  isApprovalResponseLocked,
} from '../../../../../../apps/mobile/src/features/threads/activity/pendingApprovalPresentation'

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
      lifecycleLabel: null,
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
      lifecycleLabel: null,
      options: [
        { decision: 'accept', label: 'Allow once' },
        { decision: 'acceptForSession', label: 'Allow session' },
        { decision: 'decline', label: 'Decline' },
      ],
    })
  })

  it('locks durable response states and explains their lifecycle', () =>
  {
    const responding = {
      requestId: ApprovalRequestId.make('approval-3'),
      requestKind: 'command' as const,
      createdAt: '2026-08-26T12:00:00.000Z',
      status: 'responding' as const,
      requestedDecision: 'accept' as const,
      options: [{ decision: 'accept' as const, label: 'Run once' }],
    }
    const unknown = {
      ...responding,
      requestId: ApprovalRequestId.make('approval-4'),
      status: 'unknown' as const,
    }

    expect(derivePendingApprovalPresentation(responding).lifecycleLabel).toBe(
      'Run once sent. Waiting for provider confirmation.',
    )
    expect(derivePendingApprovalPresentation(unknown).lifecycleLabel).toBe(
      'Response status is unknown. Refresh, or restart the turn before responding again.',
    )
    expect(isApprovalResponseLocked(responding, null)).toBe(true)
    expect(isApprovalResponseLocked(unknown, null)).toBe(true)
    expect(
      isApprovalResponseLocked(
        { ...responding, status: 'pending' },
        ApprovalRequestId.make('approval-3'),
      ),
    ).toBe(true)
    expect(isApprovalResponseLocked({ ...responding, status: 'pending' }, null)).toBe(false)
  })
})
