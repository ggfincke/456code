// tests/apps/web/components/architecture/ConnectedArchitectureImpactSurface.test.tsx
// verifies Impact opens immutable file resources immediately after its parent tab

// @vitest-environment happy-dom

import type {
  ArchitectureProposalSource,
  EnvironmentId,
  ProjectId,
  ProposalId,
  ProposalGenerationId,
  ProposalRevisionId,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const harness = vi.hoisted(() => ({
  refresh: vi.fn(),
}))

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    getArchitectureImpactProjection: (input: unknown) => ({
      kind: 'architecture-impact-projection',
      input,
    }),
  },
}))

vi.mock('~/state/query', () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    hasSettled: true,
    refresh: harness.refresh,
  }),
}))

vi.mock(
  '../../../../../apps/web/src/components/architecture/ArchitectureImpactProjectionSurface',
  () => ({
    ArchitectureImpactProjectionSurface: (props: {
      readonly onOpenVerifiedFile: (
        source: ArchitectureProposalSource,
        relativePath: string,
        line?: number,
      ) => void
    }) => (
      <button type="button" onClick={() => props.onOpenVerifiedFile(source, 'src/impact.ts', 12)}>
        Open exact impact file
      </button>
    ),
  }),
)

import { ConnectedArchitectureImpactSurface } from '../../../../../apps/web/src/components/architecture/ConnectedArchitectureImpactSurface'
import { createArchitectureImpactSurface } from '../../../../../apps/web/src/components/architecture/architectureResourceIdentity'
import {
  selectThreadRightPanelState,
  useRightPanelStore,
} from '../../../../../apps/web/src/stores/rightPanelStore'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const threadRef = {
  environmentId: 'environment-connected-impact' as EnvironmentId,
  threadId: 'thread-connected-impact',
} as ScopedThreadRef
const generationId = 'generation-connected-impact' as ProposalGenerationId
const source = {
  kind: 'proposal-generation',
  threadId: threadRef.threadId,
  generationId,
  side: 'proposed',
  graphDigest: `sha256:${'a'.repeat(64)}`,
} as ArchitectureProposalSource
const surface = createArchitectureImpactSurface({
  kind: 'exact-impact',
  descriptor: {
    version: 1,
    descriptorId: 'b'.repeat(64),
    threadId: threadRef.threadId,
    projectId: 'project-connected-impact' as ProjectId,
    target: {
      kind: 'plan',
      plan: { _tag: 'plan', planId: 'plan:thread-connected-impact:turn:impact' },
      state: 'active',
    },
    verifiedCandidate: {
      authority: 'verified',
      source: {
        kind: 'verified-proposal-impact',
        threadId: threadRef.threadId,
        generationId,
        proposalId: 'proposal-connected-impact' as ProposalId,
        revisionId: 'proposal-connected-impact:1' as ProposalRevisionId,
        baseTreeOid: '1'.repeat(40),
        headTreeOid: '2'.repeat(40),
        baseGraphDigest: `sha256:${'3'.repeat(64)}`,
        headGraphDigest: `sha256:${'4'.repeat(64)}`,
        projectionDigest: `sha256:${'5'.repeat(64)}`,
      },
      projectionId: 'projection-connected-impact',
      projectionRevision: 1,
      projectionDigest: `sha256:${'5'.repeat(64)}`,
      resultState: 'graph',
      freshness: 'fresh',
      generatedAt: '2026-08-20T12:00:00.000Z',
      publishedAt: '2026-08-20T12:00:00.000Z',
    },
    defaultAuthority: 'verified',
    resolvedAt: '2026-08-20T12:00:00.000Z',
  },
})

afterEach(() =>
{
  useRightPanelStore.getState().removeThread(threadRef)
  vi.clearAllMocks()
})

describe('ConnectedArchitectureImpactSurface', () =>
{
  it('opens an immutable source directly after the Impact parent', async () =>
  {
    useRightPanelStore.getState().openArchitectureSurface(threadRef, surface)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(
          <ConnectedArchitectureImpactSurface
            threadRef={threadRef}
            surface={surface}
            onOpenPlannedPath={() => undefined}
            onViewInRepositoryMap={() => undefined}
            onAddConcern={() => undefined}
          />,
        )
      })
      const open = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Open exact impact file',
      )
      await act(async () => open?.click())

      const state = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      )
      expect(state.surfaces.map((entry) => entry.kind)).toEqual(['architecture-impact', 'file'])
      expect(state.surfaces[1]).toMatchObject({
        kind: 'file',
        relativePath: 'src/impact.ts',
        revealLine: 12,
        source,
      })
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
