// tests/apps/web/components/architecture/ArchitectureImpactProjectionSurface.test.tsx
// verifies exact authority presentation, shared-canvas actions, and semantic no-impact

// @vitest-environment happy-dom

import type {
  ArchitectureGraphProjection,
  ArchitectureImpactProjectionResult,
} from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

import { ArchitectureImpactProjectionSurface } from '../../../../../apps/web/src/components/architecture/ArchitectureImpactProjectionSurface'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(Element.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const threadId = 'thread-impact-projection'
const generatedAt = '2026-08-20T12:00:00.000Z'
const standingSource = {
  kind: 'standing-project-generation' as const,
  projectId: 'project-impact-projection',
  generationId: 'a'.repeat(64),
  side: 'analyzed' as const,
  graphDigest: `sha256:${'b'.repeat(64)}` as const,
}
const verifiedSource = {
  kind: 'verified-proposal-impact' as const,
  threadId,
  generationId: 'generation-impact-projection',
  proposalId: 'proposal-impact-projection',
  revisionId: 'revision-impact-projection',
  baseTreeOid: '1'.repeat(40),
  headTreeOid: '2'.repeat(40),
  baseGraphDigest: `sha256:${'3'.repeat(64)}` as const,
  headGraphDigest: `sha256:${'4'.repeat(64)}` as const,
  projectionDigest: `sha256:${'5'.repeat(64)}` as const,
}
const plannedSource = {
  kind: 'planned-impact' as const,
  environmentId: 'environment-impact-projection',
  projectId: standingSource.projectId,
  threadId,
  plan: { _tag: 'plan' as const, planId: 'plan-impact-projection' },
  publication: {
    publicationId: 'publication-impact-projection',
    publicationRevision: 1,
    contentDigest: '6'.repeat(64),
  },
  projection: {
    projectionId: 'planned-impact-projection',
    projectionRevision: 1,
    materialization: 'provisional' as const,
  },
}

const descriptor = {
  version: 1 as const,
  descriptorId: '7'.repeat(64),
  threadId,
  projectId: standingSource.projectId,
  target: {
    kind: 'plan' as const,
    plan: plannedSource.plan,
    state: 'active' as const,
  },
  plannedCandidate: {
    authority: 'planned' as const,
    source: plannedSource,
    projectionId: plannedSource.projection.projectionId,
    projectionRevision: 1,
    resultState: 'graph' as const,
    freshness: 'fresh' as const,
    generatedAt,
    publishedAt: generatedAt,
  },
  verifiedCandidate: {
    authority: 'verified' as const,
    source: verifiedSource,
    projectionId: 'verified-impact-projection',
    projectionRevision: 1,
    projectionDigest: verifiedSource.projectionDigest,
    resultState: 'graph' as const,
    freshness: 'stale' as const,
    generatedAt,
    publishedAt: generatedAt,
    standingSource,
  },
  defaultAuthority: 'verified' as const,
  resolvedAt: generatedAt,
}

const graphProjection = {
  projectionVersion: 1,
  projectionId: 'verified-impact-projection',
  projectionRevision: 1,
  kind: 'impact-diff',
  authority: 'verified',
  resultState: 'graph',
  freshness: 'stale',
  generatedAt,
  publishedAt: generatedAt,
  source: verifiedSource,
  lens: 'architecture',
  semanticLevel: 'blocks',
  breadcrumbs: [{ id: 'system:web', label: 'Web', level: 'systems' }],
  layoutVersion: 'semantic-impact-v1',
  totals: {
    nodes: { total: 2, returned: 2, omitted: 0 },
    edges: { total: 1, returned: 1, omitted: 0 },
    evidence: { total: 1, returned: 1, omitted: 0 },
    changedFiles: { total: 3, returned: 1, omitted: 2 },
  },
  nodes: [
    {
      id: 'block:api',
      label: 'API',
      semanticLevel: 'blocks',
      position: { x: 0, y: 0 },
      tintKey: '111111111111',
      state: 'affected',
      stateLabel: 'Affected',
      badge: 'affected',
      stroke: 'double',
      fileCount: 3,
      inbound: 2,
      outbound: 1,
      affectedConsumerCount: 2,
      evidenceRefs: ['evidence:api'],
    },
    {
      id: 'block:consumer',
      label: 'Consumer',
      semanticLevel: 'blocks',
      position: { x: 1, y: 0 },
      tintKey: '222222222222',
      state: 'context',
      stateLabel: 'Context',
      badge: 'context',
      stroke: 'muted',
      fileCount: 2,
      inbound: 1,
      outbound: 0,
      affectedConsumerCount: 0,
      evidenceRefs: [],
    },
  ],
  edges: [
    {
      id: 'edge:api-consumer',
      from: 'block:api',
      to: 'block:consumer',
      relationshipKind: 'public API consumer',
      weight: 2,
      state: 'affected',
      stateLabel: 'Affected',
      stroke: 'double',
      evidenceRefs: ['evidence:api'],
    },
  ],
  evidence: [
    {
      id: 'evidence:api',
      kind: 'api',
      state: 'affected',
      label: 'Public API consumers changed.',
      paths: ['src/api.ts'],
      pathRefs: [{ path: 'src/api.ts', side: 'head' }],
    },
  ],
  anchors: [
    {
      selectionId: 'block:api',
      status: 'matched',
      source: standingSource,
      lens: 'architecture',
      candidateIds: ['block:api'],
      candidateCount: { total: 1, returned: 1, omitted: 0 },
      focusId: 'block:api',
      disclosure: 'Matched the exact standing block identity.',
    },
  ],
} as unknown as ArchitectureGraphProjection

function result(projection: ArchitectureGraphProjection): ArchitectureImpactProjectionResult
{
  return {
    version: 1,
    descriptor,
    selectedAuthority: projection.authority === 'planned' ? 'planned' : 'verified',
    projection,
  } as ArchitectureImpactProjectionResult
}

function findButton(container: ParentNode, label: string): HTMLButtonElement
{
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (button === undefined) throw new Error(`Missing button: ${label}`)
  return button
}

describe('ArchitectureImpactProjectionSurface', () =>
{
  it('keeps Verified selected while exposing authority, source, map, and concern actions', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onSelectAuthority = vi.fn()
    const onOpenVerifiedFile = vi.fn()
    const onViewInRepositoryMap = vi.fn()
    const onAddConcern = vi.fn()
    try
    {
      await act(async () =>
        root.render(
          <ArchitectureImpactProjectionSurface
            error={null}
            hasSettled
            isPending={false}
            newerProjectionError={null}
            newerProjectionPending={false}
            requestedAuthority="verified"
            result={result(graphProjection)}
            onAddConcern={onAddConcern}
            onOpenNewerProjection={() => undefined}
            onOpenPlannedPath={() => undefined}
            onOpenVerifiedFile={onOpenVerifiedFile}
            onRetry={() => undefined}
            onRetryNewerProjection={() => undefined}
            onSelectAuthority={onSelectAuthority}
            onViewInRepositoryMap={onViewInRepositoryMap}
          />,
        ),
      )

      expect(container.querySelector('[data-impact-authority="verified"]')).not.toBeNull()
      expect(findButton(container, 'Verified').getAttribute('aria-pressed')).toBe('true')
      expect(container.textContent).toContain('Verified evidence is stale')
      expect(onAddConcern).not.toHaveBeenCalled()

      await act(async () => findButton(container, 'Planned').click())
      expect(onSelectAuthority).toHaveBeenCalledWith('planned')

      const apiNode = container.querySelector<HTMLButtonElement>(
        '[data-architecture-unit-id="block:api"]',
      )
      await act(async () => apiNode?.click())
      expect(document.body.textContent).toContain('Public API consumers changed.')

      await act(async () => findButton(document.body, 'Open exact proposed').click())
      expect(onOpenVerifiedFile).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'proposal-generation', side: 'proposed' }),
        'src/api.ts',
      )
      await act(async () => findButton(document.body, 'View in Repository Map').click())
      expect(onViewInRepositoryMap).toHaveBeenCalledWith(graphProjection.anchors[0])
      await act(async () => findButton(document.body, 'Add concern to composer').click())
      expect(onAddConcern).toHaveBeenCalledWith(
        graphProjection,
        expect.objectContaining({ kind: 'node', node: graphProjection.nodes[0] }),
      )
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('renders a direct verified no-impact result without fabricating a graph action', async () =>
  {
    const noImpact = {
      ...graphProjection,
      resultState: 'no-impact',
      totals: {
        nodes: { total: 0, returned: 0, omitted: 0 },
        edges: { total: 0, returned: 0, omitted: 0 },
        evidence: { total: 0, returned: 0, omitted: 0 },
        changedFiles: { total: 3, returned: 0, omitted: 3 },
      },
      nodes: [],
      edges: [],
      evidence: [],
      anchors: [],
    } as ArchitectureGraphProjection
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
        root.render(
          <ArchitectureImpactProjectionSurface
            error={null}
            hasSettled
            isPending={false}
            newerProjectionError={null}
            newerProjectionPending={false}
            requestedAuthority="verified"
            result={result(noImpact)}
            onAddConcern={() => undefined}
            onOpenNewerProjection={() => undefined}
            onOpenPlannedPath={() => undefined}
            onOpenVerifiedFile={() => undefined}
            onRetry={() => undefined}
            onRetryNewerProjection={() => undefined}
            onSelectAuthority={() => undefined}
            onViewInRepositoryMap={() => undefined}
          />,
        ),
      )

      expect(container.textContent).toContain('Exact analysis found implementation changes')
      expect(container.querySelector('[data-architecture-canvas]')).toBeNull()
      expect(container.textContent).not.toContain('Add concern to composer')
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
