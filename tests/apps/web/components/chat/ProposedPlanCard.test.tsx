// tests/apps/web/components/chat/ProposedPlanCard.test.tsx
// verifies exact proposal identity, generation failures, and explorer availability
import type {
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
    getState: () => ({ openExplorer: vi.fn() }),
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
  claimAutomaticProposalGenerationStart,
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
    const attempt = claimAutomaticProposalGenerationStart(target, null)
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
