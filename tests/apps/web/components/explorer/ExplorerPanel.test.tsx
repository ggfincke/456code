// tests/apps/web/components/explorer/ExplorerPanel.test.tsx
// verifies compact architecture summary and two-view Proposal Review navigation

// @vitest-environment happy-dom

import type { ArchitectureImpactResult, ScopedThreadRef } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('~/lib/utils', () => ({
  cn: (...values: ReadonlyArray<string | false | null | undefined>) =>
    values.filter(Boolean).join(' '),
}))

vi.mock('../../../../../apps/web/src/components/files/SafeDocumentRenderer', () => ({
  SafeDocumentRenderer: () => <div data-safe-document-renderer />,
}))

vi.mock('../../../../../apps/web/src/components/proposals/ProposalDiffPanel', () => ({
  ProposalDiffPanel: (props: {
    readonly proposal: { readonly revisionNumber: number; readonly exactDiff: string }
    readonly fileActions?: unknown
  }) => (
    <div
      data-proposal-diff-renderer
      data-revision={props.proposal.revisionNumber}
      data-diff={props.proposal.exactDiff}
      data-file-actions={props.fileActions ? 'exact' : 'none'}
    />
  ),
}))

import {
  ExplorerPanel,
  type ExplorerArchitecturePresentation,
} from '../../../../../apps/web/src/components/explorer/ExplorerPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const threadRef = {
  environmentId: 'environment-explorer-test',
  threadId: 'thread-explorer-test',
} as ScopedThreadRef

const proposal = {
  proposalId: 'proposal-explorer-test',
  revisionNumber: 3,
  snapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
  exactDiff: 'diff --git a/src/a.ts b/src/a.ts',
}

const impactResult = {
  version: 1,
  summary: 'Exact retained generations were compared.',
  base: { generatedAt: '2026-08-09T12:00:00.000Z', gitRef: 'base-ref' },
  head: { generatedAt: '2026-08-09T12:01:00.000Z', gitRef: 'head-ref' },
  changed: true,
  addedNodes: { items: ['src/added.ts'], total: 12, omitted: 11 },
  removedNodes: { items: [], total: 2, omitted: 2 },
  addedEdges: { items: [], total: 4, omitted: 4 },
  removedEdges: { items: [], total: 1, omitted: 1 },
  movedNodes: { items: [], total: 0, omitted: 0 },
  moveFlows: { items: [], total: 0, omitted: 0 },
  movedEdges: 0,
  apiChanges: { items: [], total: 0, omitted: 0 },
  apiTotals: { files: 0, addedExports: 0, removedExports: 0, brokenConsumers: 0 },
  newViolations: { items: [], total: 0, omitted: 0 },
  resolvedViolations: { items: [], total: 0, omitted: 0 },
} satisfies ArchitectureImpactResult

function architecture(onOpen = () => undefined): ExplorerArchitecturePresentation
{
  return {
    kind: 'impact',
    result: impactResult,
    error: null,
    isPending: false,
    hasSettled: true,
    notices: ['Analysis freshness: worktree changed.'],
    onRetry: () => undefined,
    onOpen,
  }
}

describe('ExplorerPanel', () =>
{
  it('keeps architecture compact and outside the two proposal views', () =>
  {
    const markup = renderToStaticMarkup(
      <ExplorerPanel
        threadRef={threadRef}
        narrative={{ kind: 'empty', message: 'No narrative supplied.' }}
        proposal={proposal}
        architecture={architecture()}
        attempt={{ outcome: 'partial', matchedOperationCount: 1, intendedOperationCount: 2 }}
        defaultTab="code-changes"
        onOpenFile={() => undefined}
      />,
    )

    expect(markup).toContain('data-proposal-architecture-summary')
    expect(markup).toContain('Architecture changed')
    expect(markup).toContain('+12/-2 files · +4/-1 imports')
    expect(markup).toContain('Analysis freshness: worktree changed.')
    expect(markup).toContain('Open graph diff')
    expect(markup).toContain('>Narrative</button>')
    expect(markup).toContain('>Changes</button>')
    expect(markup).not.toContain('>Impact</button>')
    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('Advanced Atlas')
    expect(markup).toContain('data-proposal-diff-renderer')
    expect(markup).toContain('data-file-actions="none"')
    expect(markup).toContain('data-implementation-outcome="partial"')
  })

  it('opens the separately keyed graph diff from the compact row', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onOpen = vi.fn()
    try
    {
      await act(async () =>
      {
        root.render(
          <ExplorerPanel
            threadRef={threadRef}
            narrative={{ kind: 'empty', message: 'No narrative supplied.' }}
            proposal={proposal}
            architecture={architecture(onOpen)}
            onOpenFile={() => undefined}
          />,
        )
      })
      const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes('Open graph diff'),
      )
      await act(async () => button?.click())
      expect(onOpen).toHaveBeenCalledTimes(1)
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('uses roving keyboard focus across only Narrative and Changes', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(
          <ExplorerPanel
            threadRef={threadRef}
            narrative={{ kind: 'empty', message: 'No narrative supplied.' }}
            proposal={proposal}
            architecture={{ kind: 'loading', message: 'Analyzing proposal.' }}
            onOpenFile={() => undefined}
          />,
        )
      })
      const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      expect(tabs).toHaveLength(2)
      tabs[0]?.focus()
      await act(async () =>
      {
        tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })
      expect(document.activeElement).toBe(tabs[1])
      expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
