// tests/packages/client-runtime/thread-activity/pendingRequests.test.ts
// verifies client approval decoding recognizes MCP elicitation requests

import { EventId, TurnId, type OrchestrationThreadActivity } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { derivePendingApprovals } from '../../../../packages/client-runtime/src/thread-activity/pendingRequests.ts'

describe('derivePendingApprovals', () =>
{
  it('keeps MCP elicitation approvals pending with their canonical request kind', () =>
  {
    const activity = {
      id: EventId.make('activity-mcp-elicitation'),
      tone: 'approval',
      kind: 'approval.requested',
      summary: 'App access approval requested',
      payload: {
        requestId: 'approval-safari',
        requestType: 'mcp_elicitation_approval',
        appName: 'Safari',
        options: [
          { decision: 'accept', label: 'Allow once' },
          { decision: 'acceptAlways', label: 'Always allow Safari' },
          { decision: 'decline', label: 'Not now' },
        ],
      },
      turnId: TurnId.make('turn-1'),
      createdAt: '2026-08-24T00:00:00.000Z',
    } satisfies OrchestrationThreadActivity

    expect(derivePendingApprovals([activity])).toMatchObject([
      {
        requestId: 'approval-safari',
        requestKind: 'mcp-elicitation',
        appName: 'Safari',
        options: [
          { decision: 'accept', label: 'Allow once' },
          { decision: 'acceptAlways', label: 'Always allow Safari' },
          { decision: 'decline', label: 'Not now' },
        ],
      },
    ])
  })
})
