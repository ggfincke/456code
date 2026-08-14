// tests/apps/web/components/architecture/RepositoryAtlasSurface.test.tsx
// verifies exact Repository map status, graph navigation, and deliberate scope opening

// @vitest-environment happy-dom

import type {
  ArchitectureStandingSource,
  CartographerGetRepositoryMapResult,
  EnvironmentId,
  ProjectAtlasStatus,
  ThreadId,
} from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const atlasMocks = vi.hoisted(() =>
{
  const exactMapAtom = Symbol('exact-map')
  const statusAtom = Symbol('atlas-status')
  const rebuildCommand = Symbol('rebuild-atlas')
  return {
    exactMapAtom,
    statusAtom,
    rebuildCommand,
    getRepositoryMap: vi.fn(() => exactMapAtom),
    projectAtlasStatus: vi.fn(() => statusAtom),
    runRebuild: vi.fn(async () => ({ _tag: 'Success', value: null })),
    queryResults: new Map<unknown, unknown>(),
  }
})

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    getRepositoryMap: atlasMocks.getRepositoryMap,
    projectAtlasStatus: atlasMocks.projectAtlasStatus,
    rebuildProjectAtlas: atlasMocks.rebuildCommand,
  },
}))
vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (atom: unknown) => atlasMocks.queryResults.get(atom),
}))
vi.mock('~/state/use-atom-command', () => ({
  useAtomCommand: () => atlasMocks.runRebuild,
}))

vi.mock('../../../../../apps/web/src/components/architecture/ArchitectureScopeSurface', () => ({
  ArchitectureScopeSurface: (props: {
    readonly target: {
      readonly source: ArchitectureStandingSource
      readonly scope: { readonly level: string }
    }
    readonly onInspectScope?:
      | ((target: {
          readonly source: ArchitectureStandingSource
          readonly scope: { readonly level: 'blocks'; readonly id: string }
        }) => void)
      | undefined
    readonly onOpenScope: (target: {
      readonly source: ArchitectureStandingSource
      readonly scope: { readonly level: 'blocks'; readonly id: string }
    }) => void
  }) =>
  {
    const blockTarget = {
      source: props.target.source,
      scope: { level: 'blocks' as const, id: 'block:api' },
    }
    return (
      <div data-scope-level={props.target.scope.level}>
        <button type="button" onClick={() => props.onInspectScope?.(blockTarget)}>
          Inspect fixture block
        </button>
        <button type="button" onClick={() => props.onOpenScope(blockTarget)}>
          Open fixture block
        </button>
      </div>
    )
  },
}))

import {
  RepositoryAtlasSurface,
  RepositoryAtlasView,
  type RepositoryAtlasViewProps,
} from '../../../../../apps/web/src/components/architecture/RepositoryAtlasSurface'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const source = {
  kind: 'standing-project-generation',
  projectId: 'project-atlas-test',
  generationId: 'a'.repeat(64),
  side: 'analyzed',
  graphDigest: `sha256:${'b'.repeat(64)}`,
} as ArchitectureStandingSource

const updatedSource = {
  ...source,
  generationId: 'c'.repeat(64),
  graphDigest: `sha256:${'d'.repeat(64)}`,
} as ArchitectureStandingSource

const sameGenerationOtherSource = {
  ...source,
  projectId: 'project-atlas-other',
  graphDigest: `sha256:${'e'.repeat(64)}`,
} as ArchitectureStandingSource

const journeySource = {
  ...source,
  projectId: 'project-atlas-journey',
} as ArchitectureStandingSource

const result = {
  version: 1,
  source,
  builtAt: '2026-08-09T12:00:00.000Z',
  dirty: true,
  repo: { name: '456code', scope: '/workspace/456code', gitRef: 'feature/native-atlas' },
  counts: { files: 120, imports: 340, systems: 5, blocks: 18, dirs: 42 },
  health: {
    cycles: 1,
    orphans: 2,
    violatingImports: 3,
    violatedRules: 2,
    ruleTotal: 7,
  },
  level: 'systems',
  systemSource: 'authored',
  units: [
    {
      id: 'system:client',
      key: 'client',
      level: 'systems',
      label: 'Client Runtime',
      description: 'Shared client state and platform integration.',
      fileCount: 48,
      inbound: 4,
      outbound: 7,
      position: { x: 0, y: 0 },
    },
    {
      id: 'system:server',
      key: 'server',
      level: 'systems',
      label: 'Server Runtime',
      fileCount: 72,
      inbound: 6,
      outbound: 3,
      position: { x: 10, y: 12 },
    },
  ],
  unitCount: { total: 5, indexed: 4, returned: 2, omitted: 1 },
  edges: [{ from: 'system:client', to: 'system:server', weight: 9 }],
  edgeCount: { total: 4, indexed: 3, returned: 1, omitted: 1 },
} as CartographerGetRepositoryMapResult

const journeyResult = {
  ...result,
  source: journeySource,
} as CartographerGetRepositoryMapResult

const readyStatus = {
  state: 'ready',
  source: updatedSource,
  freshness: { builtAt: '2026-08-09T12:05:00.000Z', dirty: true },
  lastBuildError: null,
} as ProjectAtlasStatus

const buildingStatus = {
  ...readyStatus,
  state: 'building',
} as ProjectAtlasStatus

const cleanReadyStatus = {
  ...readyStatus,
  source,
  freshness: { builtAt: '2026-08-09T12:00:00.000Z', dirty: false },
} as ProjectAtlasStatus

const errorStatus = {
  ...readyStatus,
  state: 'error',
  lastBuildError: 'The latest native repository map could not be built.',
} as ProjectAtlasStatus

function viewProps(overrides: Partial<RepositoryAtlasViewProps> = {}): RepositoryAtlasViewProps
{
  return {
    result,
    isReloading: false,
    status: readyStatus,
    hasStatusSettled: true,
    isRebuilding: false,
    stale: true,
    updatedTarget: updatedSource,
    narrow: false,
    onOpenScope: () => undefined,
    onViewUpdated: () => undefined,
    onReloadMap: () => undefined,
    onRetryStatus: () => undefined,
    onRebuild: () => undefined,
    ...overrides,
  }
}

function query(
  data: unknown,
  options: {
    readonly error?: string | null | undefined
    readonly pending?: boolean | undefined
    readonly refresh?: (() => void) | undefined
    readonly settled?: boolean | undefined
  } = {},
)
{
  return {
    data,
    error: options.error ?? null,
    failure: options.error ? new Error(options.error) : null,
    isPending: options.pending ?? false,
    hasSettled: options.settled ?? true,
    refresh: options.refresh ?? (() => undefined),
  }
}

beforeEach(() =>
{
  atlasMocks.queryResults.clear()
  atlasMocks.getRepositoryMap.mockClear()
  atlasMocks.projectAtlasStatus.mockClear()
  atlasMocks.runRebuild.mockClear()
  atlasMocks.runRebuild.mockResolvedValue({ _tag: 'Success', value: null })
})

function findButton(container: ParentNode, label: string): HTMLButtonElement
{
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.includes(label) ||
      candidate.getAttribute('aria-label')?.includes(label),
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`)
  return button
}

describe('RepositoryAtlasView', () =>
{
  it('discloses returned, indexed, and unindexed totals with compact native status', () =>
  {
    const markup = renderToStaticMarkup(
      <RepositoryAtlasView {...viewProps({ mapError: 'The map read failed.' })} />,
    )

    expect(markup).toContain('Repository map')
    expect(markup).toContain('Dirty snapshot')
    expect(markup).toContain('Update available')
    expect(markup).toContain('Source changed')
    expect(markup).toContain('2 returned of 4 indexed units · 1 not indexed')
    expect(markup).toContain('1 returned of 3 indexed dependencies · 1 not indexed')
    expect(markup).toContain('Health · 1 cycles · 2 orphans')
    expect(markup).toContain('The pinned last-good map remains visible.')
    expect(markup).toContain('Map read failed.')
    expect(markup).toContain('aria-label="Reload map"')
    expect(markup).toContain('View updated map')
    expect(markup).toContain('marker-end="url(#architecture-arrow-')
    expect(markup).not.toContain('Explorer')
    expect(markup).not.toContain('Insights')
    expect(markup).not.toContain('Analyze')
  })

  it('selects without opening, opens explicitly, and restores focus', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onOpenScope = vi.fn()

    act(() => root.render(<RepositoryAtlasView {...viewProps({ onOpenScope })} />))
    const clientNode = container.querySelector('[data-architecture-unit-id="system:client"]')
    expect(clientNode).toBeInstanceOf(HTMLButtonElement)

    act(() => (clientNode as HTMLButtonElement).click())
    expect(onOpenScope).not.toHaveBeenCalled()
    expect(container.querySelector('[data-architecture-details-drawer]')).not.toBeNull()

    act(() => findButton(container, 'Open system').click())
    expect(onOpenScope).toHaveBeenCalledWith({
      source,
      scope: { level: 'systems', id: 'system:client' },
    })

    act(() => globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('[data-architecture-details-drawer]')).toBeNull()
    expect(document.activeElement).toBe(clientNode)

    expect(container.querySelector('[data-architecture-view="graph"]')).not.toBeNull()
    expect(container.querySelector('[data-architecture-canvas]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Architecture presentation"]')).toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it('uses the normal focus-trapped Sheet primitive for a narrow details surface', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    act(() => root.render(<RepositoryAtlasView {...viewProps({ narrow: true })} />))
    const node = container.querySelector('[data-architecture-unit-id="system:server"]')
    act(() => (node as HTMLButtonElement).click())

    expect(document.body.querySelector('[data-slot="sheet-popup"]')).not.toBeNull()
    expect(document.body.querySelector('[data-slot="sheet-backdrop"]')).not.toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it('returns directly to blocks after inspecting and opening the same block', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    act(() =>
      root.render(
        <RepositoryAtlasView
          {...viewProps({
            environmentId: 'environment-atlas-test' as EnvironmentId,
            onOpenFile: () => undefined,
            result: journeyResult,
            threadId: 'thread-atlas-test' as ThreadId,
          })}
        />,
      ),
    )
    const clientNode = container.querySelector('[data-architecture-unit-id="system:client"]')
    act(() => (clientNode as HTMLButtonElement).click())
    act(() => findButton(container, 'Open system').click())
    act(() => findButton(container, 'Inspect fixture block').click())
    act(() => findButton(container, 'Open fixture block').click())

    expect(container.querySelector('[data-scope-level="blocks"]')).not.toBeNull()
    act(() => findButton(container, 'Back to Blocks').click())
    expect(container.querySelector('[data-scope-level="systems"]')).not.toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it('queries the pinned generation and discovers updates from exact project status', () =>
  {
    const refresh = vi.fn()
    atlasMocks.queryResults.set(atlasMocks.exactMapAtom, query(result, { refresh }))
    atlasMocks.queryResults.set(atlasMocks.statusAtom, query(readyStatus, { refresh }))

    const markup = renderToStaticMarkup(
      <RepositoryAtlasSurface
        environmentId={'environment-atlas-test' as EnvironmentId}
        onOpenScope={() => undefined}
        onViewUpdated={() => undefined}
        target={source}
        threadId={'thread-atlas-test' as ThreadId}
      />,
    )

    expect(markup).toContain('View updated map')

    expect(atlasMocks.getRepositoryMap).toHaveBeenCalledTimes(1)
    expect(atlasMocks.getRepositoryMap).toHaveBeenCalledWith({
      environmentId: 'environment-atlas-test',
      input: {
        threadId: 'thread-atlas-test',
        projectId: source.projectId,
        generationId: source.generationId,
      },
    })
    expect(atlasMocks.projectAtlasStatus).toHaveBeenCalledWith({
      environmentId: 'environment-atlas-test',
      input: { projectId: source.projectId },
    })
  })

  it('does not show a pending subscription label after clean status has settled', () =>
  {
    atlasMocks.queryResults.set(atlasMocks.exactMapAtom, query(result))
    atlasMocks.queryResults.set(
      atlasMocks.statusAtom,
      query(cleanReadyStatus, { pending: true, settled: true }),
    )

    const markup = renderToStaticMarkup(
      <RepositoryAtlasSurface
        environmentId={'environment-atlas-test' as EnvironmentId}
        onOpenScope={() => undefined}
        target={source}
        threadId={'thread-atlas-test' as ThreadId}
      />,
    )

    expect(markup).not.toContain('Checking build status')
    expect(markup).not.toContain('Checking for updates')
    expect(markup).not.toContain('Updating status')
  })

  it('keeps the last-good map visible and routes map and subscription recovery independently', () =>
  {
    const mapRefresh = vi.fn()
    const statusRefresh = vi.fn()
    atlasMocks.queryResults.set(atlasMocks.exactMapAtom, query(result, { refresh: mapRefresh }))
    atlasMocks.queryResults.set(
      atlasMocks.statusAtom,
      query(readyStatus, { refresh: statusRefresh }),
    )

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const props = {
      environmentId: 'environment-atlas-test' as EnvironmentId,
      onOpenScope: () => undefined,
      target: source,
      threadId: 'thread-atlas-test' as ThreadId,
    }

    act(() => root.render(<RepositoryAtlasSurface {...props} />))
    expect(container.textContent).toContain('456code')

    atlasMocks.queryResults.set(
      atlasMocks.exactMapAtom,
      query(null, { error: 'The exact map read failed.', refresh: mapRefresh }),
    )
    atlasMocks.queryResults.set(
      atlasMocks.statusAtom,
      query(readyStatus, { error: 'The status subscription stopped.', refresh: statusRefresh }),
    )
    act(() => root.render(<RepositoryAtlasSurface {...props} />))

    expect(container.textContent).toContain('456code')
    expect(container.textContent).toContain('Map read failed.')
    expect(container.textContent).toContain('Build status unavailable.')
    expect(container.textContent).toContain('The pinned last-good map remains visible.')

    act(() => findButton(container, 'Retry').click())
    expect(statusRefresh).toHaveBeenCalledOnce()
    expect(mapRefresh).not.toHaveBeenCalled()

    const reloadMap = container.querySelector('[aria-label="Reload map"]')
    act(() => (reloadMap as HTMLButtonElement).click())
    expect(mapRefresh).toHaveBeenCalledOnce()
    expect(statusRefresh).toHaveBeenCalledOnce()

    act(() => root.unmount())
    container.remove()
  })

  it('drops a pinned map when the exact resource changes with the same generation', () =>
  {
    atlasMocks.queryResults.set(atlasMocks.exactMapAtom, query(result))
    atlasMocks.queryResults.set(atlasMocks.statusAtom, query(cleanReadyStatus))

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const sharedProps = {
      environmentId: 'environment-atlas-test' as EnvironmentId,
      onOpenScope: () => undefined,
      threadId: 'thread-atlas-test' as ThreadId,
    }

    act(() => root.render(<RepositoryAtlasSurface {...sharedProps} target={source} />))
    expect(container.textContent).toContain('456code')

    atlasMocks.queryResults.set(
      atlasMocks.exactMapAtom,
      query(null, { pending: true, settled: false }),
    )
    atlasMocks.queryResults.set(
      atlasMocks.statusAtom,
      query(null, { pending: true, settled: false }),
    )
    act(() =>
      root.render(<RepositoryAtlasSurface {...sharedProps} target={sameGenerationOtherSource} />),
    )

    expect(container.textContent).not.toContain('456code')
    expect(container.textContent).toContain('Loading the sealed repository map.')

    act(() => root.unmount())
    container.remove()
  })

  it('shows building freshness and rebuilds a failed latest map through the project command', async () =>
  {
    const statusRefresh = vi.fn()
    atlasMocks.queryResults.set(atlasMocks.exactMapAtom, query(null))
    atlasMocks.queryResults.set(
      atlasMocks.statusAtom,
      query(buildingStatus, { pending: true, refresh: statusRefresh }),
    )

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const props = {
      environmentId: 'environment-atlas-test' as EnvironmentId,
      onOpenScope: () => undefined,
      target: source,
      threadId: 'thread-atlas-test' as ThreadId,
    }
    act(() => root.render(<RepositoryAtlasSurface {...props} />))
    expect(container.textContent).toContain('Building the first sealed repository map.')
    expect(container.textContent).not.toContain('worker')

    atlasMocks.queryResults.set(atlasMocks.exactMapAtom, query(result))
    act(() => root.render(<RepositoryAtlasSurface {...props} />))
    expect(container.textContent).toContain('Building latest map')
    expect(container.textContent).toContain('Dirty snapshot')
    expect(container.textContent).not.toContain('Updating status')
    expect(container.textContent).toContain('2026-08-09T12:00:00.000Z')

    atlasMocks.queryResults.set(
      atlasMocks.statusAtom,
      query(errorStatus, { refresh: statusRefresh }),
    )
    act(() => root.render(<RepositoryAtlasSurface {...props} />))
    expect(container.textContent).toContain('Latest build failed.')
    expect(container.textContent).toContain('The latest native repository map could not be built.')

    await act(async () =>
    {
      findButton(container, 'Rebuild').click()
      await Promise.resolve()
    })
    expect(atlasMocks.runRebuild).toHaveBeenCalledWith({
      environmentId: 'environment-atlas-test',
      input: { projectId: source.projectId },
    })
    expect(statusRefresh).toHaveBeenCalledOnce()

    act(() => root.unmount())
    container.remove()
  })
})
