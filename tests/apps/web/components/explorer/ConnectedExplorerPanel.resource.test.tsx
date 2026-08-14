// tests/apps/web/components/explorer/ConnectedExplorerPanel.resource.test.tsx
// verifies Proposal Review opens adjacent exact Impact and immutable file resources

// @vitest-environment happy-dom

import type {
  ArchitectureImpactResult,
  ArchitectureProposalSource,
  EnvironmentId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProposalGeneration,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const harness = vi.hoisted(() => ({
  query: vi.fn(),
  refresh: vi.fn(),
  startProposalGeneration: vi.fn(),
  startCommand: Symbol('start-proposal-generation'),
}))

vi.mock('~/state/projects', () =>
{
  const query = (kind: string) => (input: unknown) => ({ kind, input })
  return {
    projectEnvironment: {
      findProposalByOrchestrateRevision: query('find-proposal-by-orchestrate-revision'),
      findProposalByPlan: query('find-proposal-by-plan'),
      getArchitectureImpact: query('architecture-impact'),
      getProposal: query('get-proposal'),
      getProposalDiff: query('get-proposal-diff'),
      getProposalGeneration: query('get-proposal-generation'),
      getProposalNarrative: query('get-proposal-narrative'),
      latestProposalGeneration: query('latest-proposal-generation'),
      latestProposalImplementationAttempt: query('latest-implementation-attempt'),
      listProposals: query('list-proposals'),
      startProposalGeneration: harness.startCommand,
    },
  }
})

vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (query: unknown) => harness.query(query),
}))

vi.mock('~/state/use-atom-command', () => ({
  useAtomCommand: (command: symbol) =>
  {
    if (command !== harness.startCommand) throw new Error('Unexpected command.')
    return harness.startProposalGeneration
  },
}))

vi.mock('../../../../../apps/web/src/components/files/SafeDocumentRenderer', () => ({
  SafeDocumentRenderer: () => null,
}))

vi.mock('../../../../../apps/web/src/components/proposals/ProposalDiffPanel', () => ({
  ProposalDiffPanel: (props: {
    readonly fileActions?: {
      readonly beforeSource: ArchitectureProposalSource | null
      readonly proposedSource: ArchitectureProposalSource | null
      readonly onOpenFile: (source: ArchitectureProposalSource, filePath: string) => void
    }
  }) => (
    <div data-proposal-diff-renderer>
      {props.fileActions?.beforeSource ? (
        <button
          type="button"
          onClick={() =>
            props.fileActions?.beforeSource &&
            props.fileActions.onOpenFile(props.fileActions.beforeSource, 'src/before.ts')
          }
        >
          Open exact Before
        </button>
      ) : null}
      {props.fileActions?.proposedSource ? (
        <button
          type="button"
          onClick={() =>
            props.fileActions?.proposedSource &&
            props.fileActions.onOpenFile(props.fileActions.proposedSource, 'src/proposed.ts')
          }
        >
          Open exact Proposed
        </button>
      ) : null}
    </div>
  ),
}))

import { ConnectedExplorerPanel } from '../../../../../apps/web/src/components/explorer/ConnectedExplorerPanel'
import {
  selectThreadRightPanelState,
  useRightPanelStore,
} from '../../../../../apps/web/src/stores/rightPanelStore'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const environmentId = 'environment-impact-resource' as EnvironmentId
const projectId = 'project-impact-resource' as ProjectId
const threadRef = {
  environmentId,
  threadId: 'thread-impact-resource',
} as ScopedThreadRef
const planId = 'plan-impact-resource' as OrchestrationProposedPlanId
const generationId = 'generation-impact-resource'

const generation = {
  generationId,
  proposalId: 'proposal-impact-resource',
  revisionId: 'proposal-impact-resource:1',
  revision: 1,
  threadId: threadRef.threadId,
  state: 'ready',
  authority: 'authoritative',
  freshness: 'fresh',
  workspaceSnapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
  analyzerVersion: 'test-analyzer',
  baseGraphArtifact: null,
  proposedGraphArtifact: null,
  impactArtifact: null,
  errorCode: null,
  createdAt: '2026-08-09T12:00:00.000Z',
  updatedAt: '2026-08-09T12:00:00.000Z',
} as ProposalGeneration

const beforeSource = {
  kind: 'proposal-generation',
  threadId: threadRef.threadId,
  generationId: generation.generationId,
  side: 'base',
  graphDigest: `sha256:${'a'.repeat(64)}`,
} as ArchitectureProposalSource
const proposedSource = {
  ...beforeSource,
  side: 'proposed',
  graphDigest: `sha256:${'b'.repeat(64)}`,
} as ArchitectureProposalSource

const impact = {
  version: 2,
  summary: 'Exact retained generations were compared.',
  base: { generatedAt: '2026-08-09T12:00:00.000Z' },
  head: { generatedAt: '2026-08-09T12:01:00.000Z' },
  changed: false,
  addedNodes: { items: [], total: 0, omitted: 0 },
  removedNodes: { items: [], total: 0, omitted: 0 },
  addedEdges: { items: [], total: 0, omitted: 0 },
  removedEdges: { items: [], total: 0, omitted: 0 },
  movedNodes: { items: [], total: 0, omitted: 0 },
  moveFlows: { items: [], total: 0, omitted: 0 },
  movedEdges: 0,
  apiChanges: { items: [], total: 0, omitted: 0 },
  apiTotals: { files: 0, addedExports: 0, removedExports: 0, brokenConsumers: 0 },
  newViolations: { items: [], total: 0, omitted: 0 },
  resolvedViolations: { items: [], total: 0, omitted: 0 },
  comparison: { kind: 'proposal-generation', generationId: generation.generationId },
  impactDigest: `sha256:${'c'.repeat(64)}`,
  baseSource: beforeSource,
  headSource: proposedSource,
} satisfies ArchitectureImpactResult

function proposalLookup()
{
  return {
    proposal: {
      environmentId,
      projectId,
      proposalId: generation.proposalId,
      sourceThreadId: threadRef.threadId,
      latestRevision: 1,
    },
    revision: {
      revision: 1,
      planId,
      baseSnapshot: { workingTreeOid: '0123456789abcdef0123456789abcdef01234567' },
      manifest: { operationCount: 1 },
      diffByteLength: 1,
    },
  }
}

function queryResult(query: unknown)
{
  const request = query as { readonly kind?: string } | null
  const data = (() =>
  {
    switch (request?.kind)
    {
      case 'find-proposal-by-plan':
      case 'get-proposal':
        return proposalLookup()
      case 'get-proposal-diff':
        return { diff: '' }
      case 'latest-proposal-generation':
      case 'get-proposal-generation':
        return generation
      case 'architecture-impact':
        return impact
      default:
        return null
    }
  })()
  return {
    data,
    error: null,
    isPending: false,
    hasSettled: query !== null,
    refresh: harness.refresh,
  }
}

afterEach(() =>
{
  useRightPanelStore.getState().removeThread(threadRef)
  vi.clearAllMocks()
})

describe('ConnectedExplorerPanel Impact Diff resource', () =>
{
  it('opens and deduplicates the exact generation comparison beside Proposal Review', async () =>
  {
    harness.query.mockImplementation(queryResult)
    useRightPanelStore.getState().openExplorer(threadRef, { kind: 'plan', planId })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(
          <ConnectedExplorerPanel
            threadRef={threadRef}
            projectId={projectId}
            target={{ kind: 'plan', planId }}
            proposalPreviewAvailable
            architectureImpactAvailable
            onOpenFile={() => undefined}
          />,
        )
      })
      const open = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.includes('Open graph diff'),
      )
      await act(async () => open?.click())
      await act(async () => open?.click())

      const state = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      )
      expect(state.surfaces).toHaveLength(2)
      expect(state.surfaces[0]).toMatchObject({ kind: 'explorer' })
      expect(state.surfaces[1]).toMatchObject({
        kind: 'architecture-impact',
        target: {
          threadId: threadRef.threadId,
          comparison: { kind: 'proposal-generation', generationId },
        },
      })
      expect(container.querySelector('iframe')).toBeNull()
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('opens exact Before and Proposed files immediately after Proposal Review', async () =>
  {
    harness.query.mockImplementation(queryResult)
    useRightPanelStore.getState().openExplorer(threadRef, { kind: 'plan', planId })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(
          <ConnectedExplorerPanel
            threadRef={threadRef}
            projectId={projectId}
            target={{ kind: 'plan', planId }}
            proposalPreviewAvailable
            architectureImpactAvailable
            onOpenFile={() => undefined}
          />,
        )
      })
      const before = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Open exact Before',
      )
      const proposed = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Open exact Proposed',
      )
      expect(before).toBeDefined()
      expect(proposed).toBeDefined()

      await act(async () => before?.click())
      await act(async () => proposed?.click())

      const state = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      )
      expect(state.surfaces.map((surface) => surface.kind)).toEqual(['explorer', 'file', 'file'])
      expect(state.surfaces[1]).toMatchObject({
        kind: 'file',
        relativePath: 'src/proposed.ts',
        source: proposedSource,
      })
      expect(state.surfaces[2]).toMatchObject({
        kind: 'file',
        relativePath: 'src/before.ts',
        source: beforeSource,
      })
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
