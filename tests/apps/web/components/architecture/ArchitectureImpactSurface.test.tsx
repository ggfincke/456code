// tests/apps/web/components/architecture/ArchitectureImpactSurface.test.tsx
// verifies impact graph bounds, identity resets, accessibility, and exact sources

// @vitest-environment happy-dom

import type { ArchitectureImpactResult } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  architectureImpactEdgeVisible,
  architectureImpactNodeSource,
  architectureImpactNodeVisible,
  createArchitectureImpactModel,
} from '../../../../../apps/web/src/components/architecture/architectureImpactModel'
import { ArchitectureDetailsDrawer } from '../../../../../apps/web/src/components/architecture/ArchitectureDetailsDrawer'
import { ArchitectureImpactSurface } from '../../../../../apps/web/src/components/architecture/ArchitectureImpactSurface'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(Element.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const baseSource = {
  kind: 'proposal-generation',
  threadId: 'thread-impact',
  generationId: 'generation-impact',
  side: 'base',
  graphDigest: `sha256:${'a'.repeat(64)}`,
} as const
const headSource = {
  kind: 'proposal-generation',
  threadId: 'thread-impact',
  generationId: 'generation-impact',
  side: 'proposed',
  graphDigest: `sha256:${'b'.repeat(64)}`,
} as const

const result = {
  version: 2,
  summary: 'Exact retained generations were compared.',
  base: { generatedAt: '2026-08-09T12:00:00.000Z', gitRef: 'base-ref' },
  head: { generatedAt: '2026-08-09T12:01:00.000Z', gitRef: 'head-ref' },
  changed: true,
  addedNodes: { items: ['src/added.ts'], total: 3, omitted: 2 },
  removedNodes: { items: ['src/removed.ts'], total: 1, omitted: 0 },
  addedEdges: {
    items: [{ from: 'src/added.ts', to: 'src/shared.ts' }],
    total: 1,
    omitted: 0,
  },
  removedEdges: {
    items: [{ from: 'src/removed.ts', to: 'src/shared.ts' }],
    total: 1,
    omitted: 0,
  },
  movedNodes: {
    items: [{ from: 'src/old.ts', to: 'src/new.ts' }],
    total: 1,
    omitted: 0,
  },
  moveFlows: {
    items: [{ from: 'src/legacy', to: 'src/modern', count: 4 }],
    total: 2,
    omitted: 1,
  },
  movedEdges: 0,
  apiChanges: {
    items: [
      {
        file: 'src/added.ts',
        addedExports: {
          items: [{ name: 'AddedShape', typeOnly: true }],
          total: 1,
          omitted: 0,
        },
        removedExports: { items: [], total: 0, omitted: 0 },
      },
      {
        file: 'src/removed.ts',
        addedExports: { items: [], total: 0, omitted: 0 },
        removedExports: {
          items: [
            {
              name: 'removedRuntime',
              brokenConsumers: {
                items: ['src/consumer-a.ts'],
                total: 2,
                omitted: 1,
              },
            },
          ],
          total: 1,
          omitted: 0,
        },
      },
      {
        file: 'src/new.ts',
        addedExports: {
          items: [{ name: 'MovedType', typeOnly: true }],
          total: 1,
          omitted: 0,
        },
        removedExports: { items: [], total: 0, omitted: 0 },
      },
      {
        file: 'src/stable.ts',
        addedExports: {
          items: [{ name: 'stableAddition' }],
          total: 2,
          omitted: 1,
        },
        removedExports: { items: [], total: 0, omitted: 0 },
      },
    ],
    total: 5,
    omitted: 1,
  },
  apiTotals: { files: 5, addedExports: 4, removedExports: 1, brokenConsumers: 2 },
  newViolations: { items: [], total: 0, omitted: 0 },
  resolvedViolations: { items: [], total: 0, omitted: 0 },
  comparison: { kind: 'proposal-generation', generationId: 'generation-impact' },
  impactDigest: `sha256:${'c'.repeat(64)}`,
  baseSource,
  headSource,
} as unknown as ArchitectureImpactResult

describe('ArchitectureImpactSurface', () =>
{
  it('uses one fixed union while preserving evidence-backed side visibility and sources', () =>
  {
    const model = createArchitectureImpactModel(result)
    const added = model.nodes.find((node) => node.path === 'src/added.ts')
    const removed = model.nodes.find((node) => node.path === 'src/removed.ts')
    const addedEdge = model.edges.find((edge) => edge.kind === 'added-import')
    const removedEdge = model.edges.find((edge) => edge.kind === 'removed-import')
    const movedEdge = model.edges.find((edge) => edge.kind === 'move')
    const moveFlow = model.edges.find((edge) => edge.kind === 'move-flow')
    const movedApi = model.nodes.find((node) => node.path === 'src/new.ts')
    const stableApi = model.nodes.find((node) => node.path === 'src/stable.ts')
    const flowFrom = model.nodes.find((node) => node.path === 'src/legacy')

    expect(added).toBeDefined()
    expect(removed).toBeDefined()
    expect(architectureImpactNodeVisible(added!, 'before')).toBe(false)
    expect(architectureImpactNodeVisible(added!, 'after')).toBe(true)
    expect(architectureImpactNodeVisible(removed!, 'before')).toBe(true)
    expect(architectureImpactNodeVisible(removed!, 'after')).toBe(false)
    expect(architectureImpactEdgeVisible(addedEdge!, 'before')).toBe(false)
    expect(architectureImpactEdgeVisible(removedEdge!, 'after')).toBe(false)
    expect(architectureImpactEdgeVisible(movedEdge!, 'diff')).toBe(true)
    expect(architectureImpactEdgeVisible(movedEdge!, 'before')).toBe(false)
    expect(architectureImpactEdgeVisible(movedEdge!, 'after')).toBe(false)
    expect(architectureImpactEdgeVisible(moveFlow!, 'diff')).toBe(true)
    expect(architectureImpactEdgeVisible(moveFlow!, 'before')).toBe(false)
    expect(architectureImpactEdgeVisible(moveFlow!, 'after')).toBe(false)
    expect(moveFlow?.count).toBe(4)
    expect(architectureImpactNodeVisible(movedApi!, 'before')).toBe(false)
    expect(architectureImpactNodeVisible(movedApi!, 'after')).toBe(true)
    expect(architectureImpactNodeVisible(stableApi!, 'before')).toBe(true)
    expect(architectureImpactNodeVisible(stableApi!, 'after')).toBe(true)
    expect(architectureImpactNodeVisible(flowFrom!, 'diff')).toBe(true)
    expect(architectureImpactNodeVisible(flowFrom!, 'before')).toBe(false)
    expect(architectureImpactNodeVisible(flowFrom!, 'after')).toBe(false)
    expect(flowFrom?.entity).toBe('directory')
    expect(architectureImpactNodeSource(model, flowFrom!, 'diff')).toBeNull()
    expect(removed?.api?.removedExports.items).toEqual([
      {
        name: 'removedRuntime',
        typeOnly: false,
        brokenConsumers: {
          items: ['src/consumer-a.ts'],
          total: 2,
          omitted: 1,
        },
      },
    ])
    expect(architectureImpactNodeSource(model, added!, 'diff')).toEqual(headSource)
    expect(architectureImpactNodeSource(model, removed!, 'diff')).toEqual(baseSource)
    expect(model.omissions).toEqual([
      { label: 'added files', count: 2 },
      { label: 'move flows', count: 1 },
      { label: 'API files', count: 1 },
      { label: 'broken consumers of removedRuntime', count: 1 },
      { label: 'added exports in src/stable.ts', count: 1 },
    ])
  })

  it('starts with a closed drawer and opens the exact proposed source from an added node', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onOpenFile = vi.fn()
    try
    {
      await act(async () =>
      {
        root.render(
          <ArchitectureImpactSurface
            result={result}
            error={null}
            isPending={false}
            hasSettled
            onRetry={() => undefined}
            onOpenFile={onOpenFile}
          />,
        )
      })

      expect(document.body.textContent).not.toContain('Returned file witness')
      expect(container.textContent).toContain('The server omitted 2 added files')
      expect(container.textContent).toContain(
        'Changed paths and their immediate architecture context',
      )
      expect(container.querySelector('[aria-label="List view"]')).toBeNull()
      expect(
        Array.from(container.querySelectorAll('button')).some(
          (button) => button.textContent === 'Before' || button.textContent === 'After',
        ),
      ).toBe(false)

      const added = container.querySelector<HTMLButtonElement>(
        '[aria-label="Inspect src/added.ts"]',
      )
      await act(async () => added?.click())

      expect(document.body.textContent).toContain('Returned file witness')
      expect(document.body.textContent).toContain('Added exports')
      expect(document.body.textContent).toContain('AddedShape')
      expect(document.body.textContent).toContain('type only')
      expect(document.body.querySelector('details[open]')).toBeNull()
      const openSource = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('Proposed source'))
      await act(async () => openSource?.click())
      expect(onOpenFile).toHaveBeenCalledWith(headSource, 'src/added.ts')

      const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')
      await act(async () => close?.click())
      const removed = container.querySelector<HTMLButtonElement>(
        '[aria-label="Inspect src/removed.ts"]',
      )
      await act(async () => removed?.click())
      expect(document.body.textContent).toContain('Removed exports')
      expect(document.body.textContent).toContain('removedRuntime')
      expect(document.body.textContent).toContain('2 broken consumers')
      expect(document.body.textContent).toContain('src/consumer-a.ts')
      expect(document.body.textContent).toContain('+1 omitted')
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps move relationships in the Diff graph and exposes returned move flows', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(
          <ArchitectureImpactSurface
            result={result}
            error={null}
            isPending={false}
            hasSettled
            onRetry={() => undefined}
            onOpenFile={() => undefined}
          />,
        )
      })
      const graphNodes = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[aria-label^="Inspect src/"]'),
      )
      graphNodes[0]?.focus()
      await act(async () =>
      {
        graphNodes[0]?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        )
      })
      expect(document.activeElement).toBe(graphNodes[1])

      expect(
        container.querySelector('[aria-label="Inspect Moved file from src/old.ts to src/new.ts"]'),
      ).not.toBeNull()
      expect(
        container.querySelector('[aria-label="Inspect Move flow from src/legacy to src/modern"]'),
      ).not.toBeNull()

      expect(container.querySelector('[aria-label="List view"]')).toBeNull()
      expect(
        Array.from(container.querySelectorAll('button')).some(
          (button) => button.textContent === 'Before' || button.textContent === 'After',
        ),
      ).toBe(false)
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('applies the graph budget across the complete Diff witness', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const sideSkewResult = {
      ...result,
      addedNodes: {
        items: Array.from({ length: 61 }, (_, index) => `src/added-${index}.ts`),
        total: 61,
        omitted: 0,
      },
      removedNodes: { items: ['src/before-only.ts'], total: 1, omitted: 0 },
      addedEdges: { items: [], total: 0, omitted: 0 },
      removedEdges: { items: [], total: 0, omitted: 0 },
      movedNodes: { items: [], total: 0, omitted: 0 },
      moveFlows: { items: [], total: 0, omitted: 0 },
      apiChanges: { items: [], total: 0, omitted: 0 },
      apiTotals: { files: 0, addedExports: 0, removedExports: 0, brokenConsumers: 0 },
      impactDigest: `sha256:${'d'.repeat(64)}`,
    } as unknown as ArchitectureImpactResult
    try
    {
      await act(async () =>
      {
        root.render(
          <ArchitectureImpactSurface
            result={sideSkewResult}
            error={null}
            isPending={false}
            hasSettled
            onRetry={() => undefined}
            onOpenFile={() => undefined}
          />,
        )
      })

      expect(container.querySelector('[data-impact-omissions]')?.textContent).toContain(
        'Showing 60 of 62 returned paths and 0 of 0 returned relationships',
      )
      expect(
        container.querySelectorAll<HTMLButtonElement>('[aria-label^="Inspect src/"]'),
      ).toHaveLength(60)
      expect(container.querySelector('[aria-label="List view"]')).toBeNull()
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('closes node and edge details when the exact Impact resource changes', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const replacementResult = {
      ...result,
      comparison: {
        kind: 'proposal-generation',
        generationId: 'generation-replacement',
      },
      impactDigest: `sha256:${'e'.repeat(64)}`,
      baseSource: {
        ...baseSource,
        generationId: 'generation-replacement',
        graphDigest: `sha256:${'f'.repeat(64)}`,
      },
      headSource: {
        ...headSource,
        generationId: 'generation-replacement',
        graphDigest: `sha256:${'0'.repeat(64)}`,
      },
    } as unknown as ArchitectureImpactResult
    const renderResult = async (nextResult: ArchitectureImpactResult): Promise<void> =>
    {
      await act(async () =>
      {
        root.render(
          <ArchitectureImpactSurface
            result={nextResult}
            error={null}
            isPending={false}
            hasSettled
            onRetry={() => undefined}
            onOpenFile={() => undefined}
          />,
        )
      })
    }
    try
    {
      await renderResult(result)
      const node = container.querySelector<HTMLButtonElement>('[aria-label="Inspect src/added.ts"]')
      await act(async () => node?.click())
      expect(document.body.textContent).toContain('Returned file witness')

      await renderResult(replacementResult)
      expect(document.body.textContent).not.toContain('Returned file witness')

      await renderResult(result)
      const edge = container.querySelector<HTMLButtonElement>(
        '[aria-label="Inspect Added import from src/added.ts to src/shared.ts"]',
      )
      await act(async () => edge?.click())
      expect(document.body.textContent).toContain('Returned relationship witness')

      await renderResult(replacementResult)
      expect(document.body.textContent).not.toContain('Returned relationship witness')
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps graph relationships to one roving tab stop and restores focused edges', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(
          <ArchitectureImpactSurface
            result={result}
            error={null}
            isPending={false}
            hasSettled
            onRetry={() => undefined}
            onOpenFile={() => undefined}
          />,
        )
      })

      const edges = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-impact-edge-id]'),
      )
      expect(edges.length).toBeGreaterThan(1)
      expect(edges.filter((edge) => edge.tabIndex === 0)).toHaveLength(1)
      expect(edges.slice(1).every((edge) => edge.tabIndex === -1)).toBe(true)
      expect(edges[0]?.className).toContain('h-3.5')

      edges[0]?.focus()
      await act(async () =>
      {
        edges[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      expect(document.activeElement).toBe(edges[1])
      expect(edges.filter((edge) => edge.tabIndex === 0)).toEqual([edges[1]])

      await act(async () => edges[1]?.click())
      expect(document.body.textContent).toContain('Returned relationship witness')

      const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')
      await act(async () => close?.click())
      expect(document.activeElement).toBe(edges[1])
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps wide details nonmodal, labelled, and focused on their trigger', async () =>
  {
    const trigger = document.createElement('button')
    trigger.textContent = 'Relationship trigger'
    document.body.append(trigger)
    trigger.focus()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onClose = vi.fn()
    try
    {
      await act(async () =>
      {
        root.render(
          <ArchitectureDetailsDrawer
            description="Returned relationship witness"
            narrow={false}
            open
            returnFocus={trigger}
            title="Added import"
            onClose={onClose}
          >
            <button type="button">Open source</button>
          </ArchitectureDetailsDrawer>,
        )
      })

      const details = container.querySelector<HTMLElement>('[data-architecture-details-drawer]')
      const title = details?.querySelector('h2')
      const description = details?.querySelector('p')
      expect(details?.getAttribute('role')).toBe('region')
      expect(details?.getAttribute('aria-labelledby')).toBe(title?.id)
      expect(details?.getAttribute('aria-describedby')).toBe(description?.id)
      expect(document.activeElement).toBe(trigger)

      await act(async () =>
      {
        globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      })
      expect(onClose).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(trigger)
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
      trigger.remove()
    }
  })
})
