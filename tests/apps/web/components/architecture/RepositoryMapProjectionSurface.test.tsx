// tests/apps/web/components/architecture/RepositoryMapProjectionSurface.test.tsx
// verifies pinned map lenses, hierarchy queries, and honest ambiguous anchoring

// @vitest-environment happy-dom

import type {
  ArchitectureGraphProjection,
  ArchitectureStandingAnchor,
  ArchitectureStandingSource,
  EnvironmentId,
  ThreadId,
} from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const mapMocks = vi.hoisted(() => ({
  architectureAtom: Symbol('repository-map-architecture'),
  structureAtom: Symbol('repository-map-structure'),
  scopeAtom: Symbol('repository-map-scope'),
  statusAtom: Symbol('repository-map-status'),
  getArchitectureScope: vi.fn((_request: unknown): symbol => Symbol('unused-scope')),
  getRepositoryMap: vi.fn((_request: unknown): symbol => Symbol('unused-map')),
  projectAtlasStatus: vi.fn((_request: unknown): symbol => Symbol('unused-status')),
  queryResults: new Map<unknown, unknown>(),
}))

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    getArchitectureScope: mapMocks.getArchitectureScope,
    getRepositoryMap: mapMocks.getRepositoryMap,
    projectAtlasStatus: mapMocks.projectAtlasStatus,
    rebuildProjectAtlas: Symbol('rebuild-repository-map'),
  },
}))
vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (atom: unknown) => mapMocks.queryResults.get(atom),
}))
vi.mock('~/state/use-atom-command', () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: 'Success', value: null })),
}))

import { RepositoryMapProjectionSurface } from '../../../../../apps/web/src/components/architecture/RepositoryMapProjectionSurface'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(Element.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const environmentId = 'environment-repository-map' as EnvironmentId
const threadId = 'thread-repository-map' as ThreadId
const source = {
  kind: 'standing-project-generation',
  projectId: 'project-repository-map',
  generationId: 'a'.repeat(64),
  side: 'analyzed',
  graphDigest: `sha256:${'b'.repeat(64)}`,
} as ArchitectureStandingSource

function count(total: number)
{
  return { total, returned: total, omitted: 0 }
}

function node(input: {
  readonly id: string
  readonly label: string
  readonly level: 'systems' | 'blocks' | 'dirs' | 'files'
  readonly path?: string | undefined
  readonly x: number
})
{
  return {
    id: input.id,
    label: input.label,
    semanticLevel: input.level,
    ...(input.path === undefined ? {} : { relativePath: input.path }),
    position: { x: input.x, y: 0 },
    tintKey: input.x === 0 ? '111111111111' : '222222222222',
    state: 'context' as const,
    stateLabel: 'Context' as const,
    badge: 'context' as const,
    stroke: 'muted' as const,
    fileCount: 1,
    inbound: 0,
    outbound: 0,
    affectedConsumerCount: 0,
    evidenceRefs: [],
  }
}

function projection(input: {
  readonly id: string
  readonly lens: 'architecture' | 'structure'
  readonly level: 'systems' | 'dirs' | 'files'
  readonly nodes: ReturnType<typeof node>[]
  readonly breadcrumbs?: ArchitectureGraphProjection['breadcrumbs'] | undefined
}): ArchitectureGraphProjection
{
  return {
    projectionVersion: 1,
    projectionId: input.id,
    projectionRevision: 1,
    kind: 'repository-map',
    authority: 'standing',
    resultState: 'graph',
    freshness: 'fresh',
    generatedAt: '2026-08-20T12:00:00.000Z',
    source,
    repository: { name: '456code', scope: '/workspace/456code', gitRef: 'feature/native-map' },
    lens: input.lens,
    semanticLevel: input.level,
    breadcrumbs: input.breadcrumbs ?? [],
    layoutVersion: 'repository-map-v2',
    totals: {
      nodes: count(input.nodes.length),
      edges: count(0),
      evidence: count(0),
      changedFiles: count(0),
    },
    nodes: input.nodes,
    edges: [],
    evidence: [],
    anchors: [],
  } as ArchitectureGraphProjection
}

const architectureProjection = projection({
  id: 'repository-map-architecture-root',
  lens: 'architecture',
  level: 'systems',
  nodes: [node({ id: 'system:web', label: 'Web', level: 'systems', x: 0 })],
})
const structureProjection = projection({
  id: 'repository-map-structure-root',
  lens: 'structure',
  level: 'dirs',
  nodes: [
    node({ id: 'dir:src', label: 'src', level: 'dirs', path: 'src', x: 0 }),
    node({ id: 'dir:apps', label: 'apps', level: 'dirs', path: 'apps', x: 1 }),
  ],
})
const scopedStructureProjection = projection({
  id: 'repository-map-structure-src',
  lens: 'structure',
  level: 'files',
  breadcrumbs: [
    { id: 'dirs:.', label: 'Root', level: 'dirs' },
    { id: 'dir:src', label: 'src', level: 'dirs' },
  ],
  nodes: [
    node({
      id: 'file:src/app.ts',
      label: 'app.ts',
      level: 'files',
      path: 'src/app.ts',
      x: 0,
    }),
  ],
})

function query(data: unknown)
{
  return {
    data,
    error: null,
    failure: null,
    hasSettled: true,
    isPending: false,
    refresh: vi.fn(),
  }
}

function findButton(container: ParentNode, label: string): HTMLButtonElement
{
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (button === undefined) throw new Error(`Missing button: ${label}`)
  return button
}

beforeEach(() =>
{
  mapMocks.queryResults.clear()
  mapMocks.queryResults.set(mapMocks.architectureAtom, query(architectureProjection))
  mapMocks.queryResults.set(mapMocks.structureAtom, query(structureProjection))
  mapMocks.queryResults.set(mapMocks.scopeAtom, query(scopedStructureProjection))
  mapMocks.queryResults.set(
    mapMocks.statusAtom,
    query({
      state: 'ready',
      source,
      freshness: { builtAt: '2026-08-20T12:00:00.000Z', dirty: false },
      lastBuildError: null,
    }),
  )
  mapMocks.getRepositoryMap.mockImplementation((request: unknown) =>
  {
    const lens = (request as { input: { lens: string } }).input.lens
    return lens === 'structure' ? mapMocks.structureAtom : mapMocks.architectureAtom
  })
  mapMocks.getArchitectureScope.mockReturnValue(mapMocks.scopeAtom)
  mapMocks.projectAtlasStatus.mockReturnValue(mapMocks.statusAtom)
})

describe('RepositoryMapProjectionSurface', () =>
{
  it('switches to Structure and drills through an exact id plus level breadcrumb', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
        root.render(
          <RepositoryMapProjectionSurface
            environmentId={environmentId}
            target={source}
            threadId={threadId}
          />,
        ),
      )
      expect(container.querySelector('[data-repository-map-lens="architecture"]')).not.toBeNull()

      await act(async () => findButton(container, 'Structure').click())
      expect(container.querySelector('[data-repository-map-lens="structure"]')).not.toBeNull()
      expect(container.querySelector('[data-architecture-unit-id="dir:src"]')).not.toBeNull()
      expect(mapMocks.getRepositoryMap).toHaveBeenLastCalledWith({
        environmentId,
        input: {
          threadId,
          projectId: source.projectId,
          generationId: source.generationId,
          lens: 'structure',
        },
      })

      const directory = container.querySelector<HTMLButtonElement>(
        '[data-architecture-unit-id="dir:src"]',
      )
      await act(async () => directory?.click())
      await act(async () => findButton(document.body, 'Open directory').click())

      expect(mapMocks.getArchitectureScope).toHaveBeenCalledWith({
        environmentId,
        input: {
          threadId,
          source,
          lens: 'structure',
          scope: { level: 'dirs', id: 'dir:src' },
        },
      })
      expect(container.textContent).toContain('app.ts')
      const breadcrumbs = container.querySelector('[aria-label="Repository Map hierarchy"]')
      expect(
        Array.from(breadcrumbs?.querySelectorAll('button') ?? []).map(
          (button) => button.textContent,
        ),
      ).toEqual(['Root', 'src'])
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps every ambiguous exact candidate highlighted without inventing one focus', async () =>
  {
    const anchor = {
      selectionId: 'planned:selection',
      status: 'ambiguous',
      source,
      lens: 'structure',
      candidateIds: ['dir:src', 'dir:apps'],
      candidateCount: { total: 2, returned: 2, omitted: 0 },
      disclosure: 'Two exact directory candidates share this semantic membership.',
    } as ArchitectureStandingAnchor
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
        root.render(
          <RepositoryMapProjectionSurface
            environmentId={environmentId}
            focusRequest={{ requestId: 1, anchor }}
            target={source}
            threadId={threadId}
          />,
        ),
      )

      expect(container.textContent).toContain('Multiple exact candidates.')
      expect(container.textContent).toContain(anchor.disclosure)
      expect(container.querySelectorAll('[data-anchor-highlighted="true"]')).toHaveLength(2)
      expect(
        container.querySelectorAll('[data-architecture-unit-id][aria-pressed="true"]'),
      ).toHaveLength(0)
      expect(mapMocks.getRepositoryMap).toHaveBeenCalledWith({
        environmentId,
        input: expect.objectContaining({
          lens: 'structure',
          focusIds: ['dir:src', 'dir:apps'],
        }),
      })
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
