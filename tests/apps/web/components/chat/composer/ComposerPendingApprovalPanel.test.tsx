// tests/apps/web/components/chat/composer/ComposerPendingApprovalPanel.test.tsx
// verify composer pending approval panel behavior

import { ApprovalRequestId } from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import { ComposerPendingApprovalPanel } from '../../../../../../apps/web/src/components/chat/composer/ComposerPendingApprovalPanel'
import { ComposerPendingApprovalActions } from '../../../../../../apps/web/src/components/chat/composer/ComposerPendingApprovalActions'

describe('ComposerPendingApprovalPanel', () =>
{
  it('renders complete multiline command details without hover or truncation', () =>
  {
    const detail = `bun run release -- ${'x'.repeat(500)}\nsecond line`
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make('approval-1'),
          requestKind: 'command',
          createdAt: '2026-07-18T00:00:00.000Z',
          detail,
        }}
        pendingCount={1}
      />,
    )

    expect(markup).toContain('data-approval-detail="complete"')
    expect(markup).toContain('aria-label="Command"')
    expect(markup).toContain(detail)
    expect(markup).not.toContain('truncate')
    expect(markup).not.toContain('line-clamp')
    expect(markup).toContain('min-w-0')
    expect(markup).toContain('max-w-full')
    expect(markup).toContain('[overflow-wrap:anywhere]')
  })

  it('renders server-provided MCP app and approval option labels', () =>
  {
    const options = [
      { decision: 'accept' as const, label: 'Allow Safari once' },
      { decision: 'acceptAlways' as const, label: 'Always allow Safari' },
      { decision: 'decline' as const, label: 'Not now' },
    ]
    const approval = {
      requestId: ApprovalRequestId.make('approval-mcp'),
      requestKind: 'mcp-elicitation' as const,
      createdAt: '2026-08-26T00:00:00.000Z',
      appName: 'Safari',
      options,
    }
    const markup = renderToStaticMarkup(
      <>
        <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          isResponding={false}
          onRespondToApproval={async () => undefined}
          options={options}
        />
      </>,
    )

    expect(markup).toContain('Safari approval requested')
    expect(markup).toContain('Allow Safari once')
    expect(markup).toContain('Always allow Safari')
    expect(markup).toContain('Not now')
    expect(markup).not.toContain('Cancel turn')
  })
})
