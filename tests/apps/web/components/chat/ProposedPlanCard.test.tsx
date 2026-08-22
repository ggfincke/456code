// tests/apps/web/components/chat/ProposedPlanCard.test.tsx
// verifies exact proposal identity, generation failures, and explorer availability
import type {
  ArchitectureImpactProjectionResult,
  EnvironmentId,
  OrchestrationProposedPlanId,
  ProposalGeneration,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  findProposalByPlan: vi.fn(),
  latestProposalGeneration: vi.fn(),
  getProposalGeneration: vi.fn(),
  getArchitectureImpactProjection: vi.fn(),
  openArchitectureSurface: vi.fn(),
  query: vi.fn(),
}))

vi.mock('~/state/entities', () => ({
  useServerConfigs: () =>
    new Map([
      [
        'environment-plan-card',
        {
          environment: {
            capabilities: {
              proposalPreview: true,
              architectureImpact: true,
            },
          },
        },
      ],
    ]),
}))

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    findProposalByPlan: (input: unknown) =>
    {
      mocks.findProposalByPlan(input)
      return { kind: 'find-proposal-by-plan', input }
    },
    latestProposalGeneration: (input: unknown) =>
    {
      mocks.latestProposalGeneration(input)
      return { kind: 'latest-proposal-generation', input }
    },
    getProposalGeneration: (input: unknown) =>
    {
      mocks.getProposalGeneration(input)
      return { kind: 'get-proposal-generation', input }
    },
    getArchitectureImpactProjection: (input: unknown) =>
    {
      mocks.getArchitectureImpactProjection(input)
      return { kind: 'architecture-impact-projection', input }
    },
    startProposalGeneration: {},
    writeFile: {},
  },
}))

vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (query: unknown) => mocks.query(query),
}))

vi.mock('~/state/use-atom-command', () => ({
  useAtomCommand: () => vi.fn(),
}))

vi.mock('~/rightPanelStore', () => ({
  useRightPanelStore: {
    getState: () => ({
      openArchitectureSurface: mocks.openArchitectureSurface,
      openExplorer: vi.fn(),
    }),
  },
}))

vi.mock('~/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: vi.fn(),
    isCopied: false,
  }),
}))

vi.mock('../../../../../apps/web/src/components/ChatMarkdown', () => ({
  default: ({ text }: { readonly text: string }) => <div data-chat-markdown>{text}</div>,
}))

import { ProposedPlanCard } from '../../../../../apps/web/src/components/chat/ProposedPlanCard'
import {
  claimManualProposalGenerationStart,
  createProposalGenerationStartTarget,
  failProposalGenerationStart,
  resetProposalGenerationStartStoreForTests,
} from '../../../../../apps/web/src/components/chat/proposedPlanGenerationStart'

const environmentId = 'environment-plan-card' as EnvironmentId
const planId = 'plan-exact' as OrchestrationProposedPlanId
const threadRef = {
  environmentId,
  threadId: 'thread-plan-card',
} as ScopedThreadRef

const planLookup = {
  proposal: {
    proposalId: 'proposal-exact',
    sourceThreadId: threadRef.threadId,
  },
  revision: {
    revision: 4,
    planId,
    baseSnapshot: {
      workingTreeOid: '0123456789abcdef0123456789abcdef01234567',
    },
  },
}

function impactProjection(
  resultState: 'graph' | 'no-impact' = 'graph',
): ArchitectureImpactProjectionResult
{
  return {
    version: 1,
    descriptor: {
      version: 1,
      descriptorId: 'a'.repeat(64),
      threadId: threadRef.threadId,
      projectId: 'project-plan-card',
      target: { kind: 'plan', plan: { _tag: 'plan', planId }, state: 'active' },
      verifiedCandidate: {
        authority: 'verified',
        source: {
          kind: 'verified-proposal-impact',
          threadId: threadRef.threadId,
          generationId: 'generation-exact',
          proposalId: 'proposal-exact',
          revisionId: 'proposal-exact:4',
          baseTreeOid: '1'.repeat(40),
          headTreeOid: '2'.repeat(40),
          baseGraphDigest: `sha256:${'3'.repeat(64)}`,
          headGraphDigest: `sha256:${'4'.repeat(64)}`,
          projectionDigest: `sha256:${'5'.repeat(64)}`,
        },
        projectionId: 'verified-plan-card',
        projectionRevision: 1,
        projectionDigest: `sha256:${'5'.repeat(64)}`,
        resultState,
        freshness: 'stale',
        generatedAt: '2026-08-20T12:00:00.000Z',
        publishedAt: '2026-08-20T12:00:00.000Z',
      },
      defaultAuthority: 'verified',
      resolvedAt: '2026-08-20T12:00:00.000Z',
    },
    selectedAuthority: 'verified',
    projection: {
      projectionVersion: 1,
      projectionId: 'verified-plan-card',
      projectionRevision: 1,
      kind: 'impact-diff',
      authority: 'verified',
      resultState,
      freshness: 'stale',
      generatedAt: '2026-08-20T12:00:00.000Z',
      publishedAt: '2026-08-20T12:00:00.000Z',
      source: {
        kind: 'verified-proposal-impact',
        threadId: threadRef.threadId,
        generationId: 'generation-exact',
        proposalId: 'proposal-exact',
        revisionId: 'proposal-exact:4',
        baseTreeOid: '1'.repeat(40),
        headTreeOid: '2'.repeat(40),
        baseGraphDigest: `sha256:${'3'.repeat(64)}`,
        headGraphDigest: `sha256:${'4'.repeat(64)}`,
        projectionDigest: `sha256:${'5'.repeat(64)}`,
      },
      lens: 'architecture',
      semanticLevel: 'blocks',
      breadcrumbs: [],
      layoutVersion: 'semantic-impact-v1',
      totals: {
        nodes: {
          total: resultState === 'graph' ? 2 : 0,
          returned: resultState === 'graph' ? 2 : 0,
          omitted: 0,
        },
        edges: {
          total: resultState === 'graph' ? 1 : 0,
          returned: resultState === 'graph' ? 1 : 0,
          omitted: 0,
        },
        evidence: { total: 0, returned: 0, omitted: 0 },
        changedFiles: { total: 3, returned: 0, omitted: 3 },
      },
      nodes: [],
      edges: [],
      evidence: [],
      anchors: [],
    },
  } as unknown as ArchitectureImpactProjectionResult
}

function proposalGeneration(
  state: ProposalGeneration['state'],
  errorCode: string | null = null,
): ProposalGeneration
{
  return {
    generationId: 'generation-exact',
    proposalId: 'proposal-exact',
    revisionId: 'proposal-exact:4',
    revision: 4,
    threadId: threadRef.threadId,
    state,
    authority: 'authoritative',
    freshness: 'fresh',
    workspaceSnapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
    analyzerVersion: 'test-analyzer',
    baseGraphArtifact: null,
    proposedGraphArtifact: null,
    impactArtifact: null,
    errorCode,
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
  } as ProposalGeneration
}

describe('ProposedPlanCard', () =>
{
  beforeEach(() =>
  {
    vi.clearAllMocks()
    resetProposalGenerationStartStoreForTests()
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data: query?.kind === 'find-proposal-by-plan' ? planLookup : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    }))
  })

  it('shows the exact Verified summary and suppresses the graph action for no-impact', () =>
  {
    const graph = impactProjection('graph')
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data:
        query?.kind === 'find-proposal-by-plan'
          ? planLookup
          : query?.kind === 'architecture-impact-projection'
            ? graph
            : null,
      error: null,
      failure: null,
      hasSettled: true,
      isPending: false,
      refresh: vi.fn(),
    }))

    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan"
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    )

    expect(markup).toContain('Verified Impact')
    expect(markup).toContain('2 objects · 1 relationships')
    expect(markup).toContain('Open Impact Diff')
    expect(mocks.getArchitectureImpactProjection).toHaveBeenCalledWith({
      environmentId,
      input: {
        version: 1,
        kind: 'resolve-plan',
        threadId: threadRef.threadId,
        plan: { _tag: 'plan', planId },
      },
    })

    const noImpact = impactProjection('no-impact')
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data:
        query?.kind === 'find-proposal-by-plan'
          ? planLookup
          : query?.kind === 'architecture-impact-projection'
            ? noImpact
            : null,
      error: null,
      failure: null,
      hasSettled: true,
      isPending: false,
      refresh: vi.fn(),
    }))
    const noImpactMarkup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan"
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    )
    expect(noImpactMarkup).toContain('No architectural relationship changes · 3 changed files')
    expect(noImpactMarkup).not.toContain('Open Impact Diff')
  })

  it('queries its exact plan linkage and labels the immutable revision and snapshot', () =>
  {
    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan\n\nImplement the linked revision."
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    )

    expect(mocks.findProposalByPlan).toHaveBeenCalledWith({
      environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        planId,
      },
    })
    expect(markup).toContain(
      'Preview of proposal revision 4 against workspace snapshot 0123456789abcdef0123456789abcdef01234567.',
    )
    expect(markup).toContain('Open review')
  })

  it('shows the exact analyzing identity while that revision generation is active', () =>
  {
    const generation = proposalGeneration('analyzing')
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data:
        query?.kind === 'find-proposal-by-plan'
          ? planLookup
          : query?.kind === 'latest-proposal-generation' ||
              query?.kind === 'get-proposal-generation'
            ? generation
            : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    }))

    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan"
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    )

    expect(mocks.latestProposalGeneration).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        proposalId: 'proposal-exact',
        revision: 4,
      },
    })
    expect(markup).toContain(
      'Analyzing revision 4 against workspace snapshot 0123456789abcdef0123456789abcdef01234567.',
    )
  })

  it('renders a durable start failure as one retry alert in the preview identity area', () =>
  {
    const target = createProposalGenerationStartTarget({
      environmentId,
      threadId: threadRef.threadId,
      proposalId: planLookup.proposal.proposalId as ProposalGeneration['proposalId'],
      revision: planLookup.revision.revision,
    })
    const attempt = claimManualProposalGenerationStart(target, null)
    expect(attempt).not.toBeNull()
    failProposalGenerationStart(attempt!, 'Architecture analysis could not be scheduled.')

    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan"
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    )

    expect(markup.match(/role="alert"/g)).toHaveLength(1)
    expect(markup).toContain('Architecture analysis could not be scheduled.')
    expect(markup).toContain('Retry analysis')
    expect(markup.indexOf('data-proposal-preview-identity')).toBeLessThan(
      markup.indexOf('role="alert"'),
    )
  })

  it('explains an abandoned server generation and offers a manual retry', () =>
  {
    const generation = proposalGeneration('abandoned', 'server-restarted')
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data:
        query?.kind === 'find-proposal-by-plan'
          ? planLookup
          : query?.kind === 'latest-proposal-generation' ||
              query?.kind === 'get-proposal-generation'
            ? generation
            : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    }))

    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan"
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    )

    expect(markup.match(/role="alert"/g)).toHaveLength(1)
    expect(markup).toContain(
      'The server restarted before architecture analysis finished. Retry to start a new analysis.',
    )
    expect(markup).toContain('Retry analysis')
  })

  it('humanizes terminal generation error codes', () =>
  {
    const generation = proposalGeneration('failed', 'materialization-failed')
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data:
        query?.kind === 'find-proposal-by-plan'
          ? planLookup
          : query?.kind === 'latest-proposal-generation' ||
              query?.kind === 'get-proposal-generation'
            ? generation
            : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    }))

    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan"
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    )

    expect(markup).toContain('Exact architecture analysis failed: materialization failed.')
  })
})
