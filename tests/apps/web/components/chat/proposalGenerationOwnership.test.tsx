// tests/apps/web/components/chat/proposalGenerationOwnership.test.tsx
// verifies mounted proposal generation ownership across shared surfaces and revision changes

// @vitest-environment happy-dom

import type {
  EnvironmentId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProposalGeneration,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { proposalGenerationStartCommandKey } from '@t3tools/client-runtime/state/projects'
import { act, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

interface PendingStart
{
  readonly input: unknown
  readonly resolve: (result: unknown) => void
}

const mocks = vi.hoisted(() => ({
  pendingStarts: [] as PendingStart[],
  query: vi.fn(),
  refresh: vi.fn(),
  startProposalGeneration: vi.fn(),
  writeFile: vi.fn(async () => ({ _tag: 'Success', value: undefined })),
}))

vi.mock('~/state/entities', () => ({
  useServerConfigs: () =>
    new Map([
      [
        'environment-generation-owner',
        {
          environment: {
            capabilities: { proposalPreview: true, architectureImpact: true },
          },
        },
      ],
    ]),
}))

vi.mock('~/state/projects', () =>
{
  const query = (kind: string) => (input: unknown) => ({ kind, input })
  return {
    projectEnvironment: {
      findProposalByOrchestrateRevision: query('find-proposal-by-orchestrate-revision'),
      findProposalByPlan: query('find-proposal-by-plan'),
      getProposal: query('get-proposal'),
      getProposalDiff: query('get-proposal-diff'),
      getProposalGeneration: query('get-proposal-generation'),
      getArchitectureImpact: query('get-architecture-impact'),
      getProposalNarrative: query('get-proposal-narrative'),
      latestProposalGeneration: query('latest-proposal-generation'),
      latestProposalImplementationAttempt: query('latest-implementation-attempt'),
      listProposals: query('list-proposals'),
      startProposalGeneration: { kind: 'start-generation-command' },
      writeFile: { kind: 'write-file-command' },
    },
  }
})

vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (query: unknown) => mocks.query(query),
}))

vi.mock('~/state/use-atom-command', () => ({
  useAtomCommand: (command: { readonly kind?: string }) =>
  {
    switch (command.kind)
    {
      case 'start-generation-command':
        return mocks.startProposalGeneration
      default:
        return mocks.writeFile
    }
  },
}))

vi.mock('~/state/environments', () => ({
  useEnvironmentConnectionState: () => ({ data: null }),
  useEnvironmentHttpBaseUrl: () => null,
}))

vi.mock('~/state/environmentHttp', () => ({
  useEnvironmentHttpFetch: () => null,
}))

vi.mock('~/hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('~/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}))

vi.mock('~/rightPanelStore', () => ({
  useRightPanelStore: {
    getState: () => ({ openExplorer: vi.fn() }),
  },
}))

vi.mock('../../../../../apps/web/src/components/ChatMarkdown', () => ({
  default: ({ text }: { readonly text: string }) => <div>{text}</div>,
}))

vi.mock('../../../../../apps/web/src/components/explorer/ExplorerPanel', () => ({
  ExplorerPanel: ({ architecture }: { readonly architecture: { readonly kind: string } }) => (
    <div data-explorer-architecture={architecture.kind} />
  ),
}))

import { ProposedPlanCard } from '../../../../../apps/web/src/components/chat/ProposedPlanCard'
import {
  createProposalGenerationStartTarget,
  readProposalGenerationStartState,
  resetProposalGenerationStartStoreForTests,
} from '../../../../../apps/web/src/components/chat/proposedPlanGenerationStart'
import { ConnectedExplorerPanel } from '../../../../../apps/web/src/components/explorer/ConnectedExplorerPanel'

const environmentId = 'environment-generation-owner' as EnvironmentId
const projectId = 'project-generation-owner' as ProjectId
const threadRef = {
  environmentId,
  threadId: 'thread-generation-owner',
} as ScopedThreadRef
const planA = 'plan-generation-A' as OrchestrationProposedPlanId
const planB = 'plan-generation-B' as OrchestrationProposedPlanId
const proposalId = 'proposal-generation-owner' as ProposalGeneration['proposalId']

function proposalLookup(planId: OrchestrationProposedPlanId)
{
  const revision = planId === planA ? 1 : 2
  return {
    proposal: {
      environmentId,
      projectId,
      proposalId,
      sourceThreadId: threadRef.threadId,
      latestRevision: 2,
    },
    revision: {
      revision,
      planId,
      baseSnapshot: {
        workingTreeOid: '0123456789abcdef0123456789abcdef01234567',
      },
      manifest: { operationCount: 1 },
      diffByteLength: 1,
    },
  }
}

function generation(
  generationId: string,
  revision: number,
  state: ProposalGeneration['state'] = 'queued',
): ProposalGeneration
{
  return {
    generationId,
    proposalId,
    revisionId: `${proposalId}:${revision}`,
    revision,
    threadId: threadRef.threadId,
    state,
    authority: 'authoritative',
    freshness: 'fresh',
    workspaceSnapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
    analyzerVersion: 'test-analyzer',
    baseGraphArtifact: null,
    proposedGraphArtifact: null,
    impactArtifact: null,
    errorCode: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    updatedAt: '2026-08-08T12:00:00.000Z',
  } as ProposalGeneration
}

function queryResult(query: unknown)
{
  const request = query as {
    readonly kind?: string
    readonly input?: {
      readonly input?: {
        readonly planId?: OrchestrationProposedPlanId
        readonly revision?: number
      }
    }
  } | null
  const planId = request?.input?.input?.planId
  const revision = request?.input?.input?.revision
  const data = (() =>
  {
    switch (request?.kind)
    {
      case 'find-proposal-by-plan':
        return planId === undefined ? null : proposalLookup(planId)
      case 'get-proposal':
        return revision === 1 ? proposalLookup(planA) : proposalLookup(planB)
      case 'get-proposal-diff':
        return { diff: '' }
      default:
        return null
    }
  })()
  return { data, error: null, isPending: false, refresh: mocks.refresh }
}

function startSuccess(value: ProposalGeneration)
{
  return { _tag: 'Success' as const, value }
}

function card(planId: OrchestrationProposedPlanId): ReactNode
{
  return (
    <ProposedPlanCard
      key={`card:${planId}`}
      planId={planId}
      planMarkdown={`# ${planId}`}
      environmentId={environmentId}
      threadRef={threadRef}
      cwd="/workspace"
      workspaceRoot="/workspace"
    />
  )
}

function explorer(planId: OrchestrationProposedPlanId): ReactNode
{
  return (
    <ConnectedExplorerPanel
      key="explorer"
      threadRef={threadRef}
      projectId={projectId}
      target={{ kind: 'plan', planId }}
      proposalPreviewAvailable
      architectureImpactAvailable
      onOpenFile={() => undefined}
    />
  )
}

describe('proposal generation mounted ownership', () =>
{
  let container: HTMLDivElement
  let root: Root

  beforeEach(() =>
  {
    resetProposalGenerationStartStoreForTests()
    vi.clearAllMocks()
    mocks.pendingStarts.length = 0
    mocks.query.mockImplementation(queryResult)
    mocks.startProposalGeneration.mockImplementation(
      (input: unknown) =>
        new Promise((resolve) =>
        {
          mocks.pendingStarts.push({ input, resolve })
        }),
    )
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () =>
  {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render(children: ReactNode): Promise<void>
  {
    await act(async () =>
    {
      root.render(<StrictMode>{children}</StrictMode>)
      await Promise.resolve()
    })
  }

  it('admits one start when the card and Explorer mount together and either remounts', async () =>
  {
    await render(
      <>
        {card(planA)}
        {explorer(planA)}
      </>,
    )
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(1)
    expect(mocks.pendingStarts).toHaveLength(1)

    await render(null)
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(1)
    await render(
      <>
        {card(planA)}
        {explorer(planA)}
      </>,
    )
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(1)

    await act(async () =>
    {
      mocks.pendingStarts[0]!.resolve(startSuccess(generation('generation-shared', 1)))
      await Promise.resolve()
    })
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(1)
  })

  it('fences delayed A1 and B after a mounted A to B to A transition', async () =>
  {
    expect(
      proposalGenerationStartCommandKey({
        environmentId,
        input: { threadId: threadRef.threadId, proposalId, revision: 1 },
      }),
    ).not.toBe(
      proposalGenerationStartCommandKey({
        environmentId,
        input: { threadId: threadRef.threadId, proposalId, revision: 2 },
      }),
    )
    await render(
      <>
        {card(planA)}
        {explorer(planA)}
      </>,
    )
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(1)

    await render(
      <>
        {card(planA)}
        {explorer(planB)}
      </>,
    )
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('superseded by a newer revision')
    await act(async () => Promise.resolve())
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(2)

    await render(
      <>
        {card(planA)}
        {explorer(planA)}
      </>,
    )
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(3)

    const refreshCountBeforeA2 = mocks.refresh.mock.calls.length
    await act(async () =>
    {
      mocks.pendingStarts[2]!.resolve(startSuccess(generation('generation-A2', 1)))
      await Promise.resolve()
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCountBeforeA2 + 1)
    const targetA = createProposalGenerationStartTarget({
      environmentId,
      threadId: threadRef.threadId,
      proposalId,
      revision: 1,
    })
    const targetB = createProposalGenerationStartTarget({
      environmentId,
      threadId: threadRef.threadId,
      proposalId,
      revision: 2,
    })
    expect(readProposalGenerationStartState(targetA)).toMatchObject({
      status: 'started',
      attemptId: 3,
      generation: { generationId: 'generation-A2' },
    })
    expect(readProposalGenerationStartState(targetB)).toMatchObject({
      status: 'superseded',
      attemptId: 2,
    })

    const refreshCountAfterA2 = mocks.refresh.mock.calls.length
    await act(async () =>
    {
      mocks.pendingStarts[1]!.resolve(startSuccess(generation('generation-B', 2)))
      mocks.pendingStarts[0]!.resolve(startSuccess(generation('generation-A1', 1)))
      await Promise.resolve()
    })
    expect(readProposalGenerationStartState(targetA)).toMatchObject({
      status: 'started',
      attemptId: 3,
      generation: { generationId: 'generation-A2' },
    })
    expect(readProposalGenerationStartState(targetB)).toMatchObject({
      status: 'superseded',
      attemptId: 2,
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCountAfterA2)
    expect(mocks.startProposalGeneration).toHaveBeenCalledTimes(3)
  })
})
