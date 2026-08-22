// tests/apps/web/components/explorer/ExplorerPanel.test.tsx
// verifies compact architecture summary and two-view Proposal Review navigation

// @vitest-environment happy-dom

import type {
  ArchitectureImpactProjectionResult,
  ProjectId,
  ProposalGenerationId,
  ProposalId,
  ProposalRevisionId,
  ScopedThreadRef,
} from '@t3tools/contracts'
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
  descriptor: {
    version: 1,
    descriptorId: '1'.repeat(64),
    threadId: threadRef.threadId,
    projectId: 'project-explorer-test' as ProjectId,
    target: {
      kind: 'plan',
      plan: { _tag: 'plan', planId: 'plan:thread-explorer-test:turn:impact' },
      state: 'active',
    },
    verifiedCandidate: {
      authority: 'verified',
      source: {
        kind: 'verified-proposal-impact',
        threadId: threadRef.threadId,
        generationId: 'generation-explorer-test' as ProposalGenerationId,
        proposalId: proposal.proposalId as ProposalId,
        revisionId: `${proposal.proposalId}:3` as ProposalRevisionId,
        baseTreeOid: '2'.repeat(40),
        headTreeOid: '3'.repeat(40),
        baseGraphDigest: `sha256:${'4'.repeat(64)}`,
        headGraphDigest: `sha256:${'5'.repeat(64)}`,
        projectionDigest: `sha256:${'6'.repeat(64)}`,
      },
      projectionId: 'projection-explorer-test',
      projectionRevision: 1,
      projectionDigest: `sha256:${'6'.repeat(64)}`,
      resultState: 'graph',
      freshness: 'fresh',
      generatedAt: '2026-08-20T12:00:00.000Z',
      publishedAt: '2026-08-20T12:00:00.000Z',
    },
    defaultAuthority: 'verified',
    resolvedAt: '2026-08-20T12:00:00.000Z',
  },
  selectedAuthority: 'verified',
  projection: {
    projectionVersion: 1,
    projectionId: 'projection-explorer-test',
    projectionRevision: 1,
    kind: 'impact-diff',
    authority: 'verified',
    resultState: 'graph',
    freshness: 'fresh',
    generatedAt: '2026-08-20T12:00:00.000Z',
    publishedAt: '2026-08-20T12:00:00.000Z',
    source: {
      kind: 'verified-proposal-impact',
      threadId: threadRef.threadId,
      generationId: 'generation-explorer-test' as ProposalGenerationId,
      proposalId: proposal.proposalId as ProposalId,
      revisionId: `${proposal.proposalId}:3` as ProposalRevisionId,
      baseTreeOid: '2'.repeat(40),
      headTreeOid: '3'.repeat(40),
      baseGraphDigest: `sha256:${'4'.repeat(64)}`,
      headGraphDigest: `sha256:${'5'.repeat(64)}`,
      projectionDigest: `sha256:${'6'.repeat(64)}`,
    },
    lens: 'architecture',
    semanticLevel: 'blocks',
    breadcrumbs: [],
    layoutVersion: 'semantic-impact-v1',
    totals: {
      nodes: { total: 12, returned: 1, omitted: 11 },
      edges: { total: 4, returned: 0, omitted: 4 },
      evidence: { total: 0, returned: 0, omitted: 0 },
      changedFiles: { total: 14, returned: 0, omitted: 14 },
    },
    nodes: [],
    edges: [],
    evidence: [],
    anchors: [],
  },
} satisfies ArchitectureImpactProjectionResult

function architecture(onOpen = () => undefined): ExplorerArchitecturePresentation
{
  return {
    kind: 'impact-diff',
    result: impactResult,
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
    expect(markup).toContain('Verified Impact')
    expect(markup).toContain('12 objects · 4 relationships')
    expect(markup).toContain('Exact analyzer evidence for this proposal revision.')
    expect(markup).toContain('Open Impact Diff')
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
        candidate.textContent?.includes('Open Impact Diff'),
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
