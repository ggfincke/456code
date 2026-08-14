// tests/apps/web/components/architecture/ArchitectureScopeSurface.test.tsx
// verifies bounded scope paging, exact file routing, and dependency direction controls

// @vitest-environment happy-dom

import type {
  ArchitectureRelativePath,
  ArchitectureStandingSource,
  CartographerGetArchitectureNeighborhoodResult,
  CartographerGetArchitectureScopeResult,
  EnvironmentId,
  ThreadId,
} from '@t3tools/contracts'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const scopeMocks = vi.hoisted(() =>
{
  const scopeAtom = Symbol('architecture-scope')
  const neighborhoodAtom = Symbol('architecture-neighborhood')
  return {
    scopeAtom,
    neighborhoodAtom,
    getArchitectureScope: vi.fn((_request?: unknown) => scopeAtom),
    getArchitectureNeighborhood: vi.fn((_request?: unknown) => neighborhoodAtom),
    queryResults: new Map<unknown, unknown>(),
  }
})

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    getArchitectureScope: scopeMocks.getArchitectureScope,
    getArchitectureNeighborhood: scopeMocks.getArchitectureNeighborhood,
  },
}))
vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (atom: unknown) => scopeMocks.queryResults.get(atom),
}))

import {
  ArchitectureNeighborhoodView,
  ArchitectureScopeSurface,
  ArchitectureScopeView,
  type ArchitectureNeighborhoodViewProps,
  type ArchitectureScopeViewProps,
} from '../../../../../apps/web/src/components/architecture/ArchitectureScopeSurface'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(() =>
{
  scopeMocks.getArchitectureScope.mockImplementation((_request?: unknown) => scopeMocks.scopeAtom)
  scopeMocks.getArchitectureNeighborhood.mockImplementation(
    (_request?: unknown) => scopeMocks.neighborhoodAtom,
  )
  scopeMocks.queryResults.clear()
})

const source = {
  kind: 'standing-project-generation',
  projectId: 'project-scope-test',
  generationId: '1'.repeat(64),
  side: 'analyzed',
  graphDigest: `sha256:${'2'.repeat(64)}`,
} as ArchitectureStandingSource

const scopeResult = {
  version: 1,
  source,
  scope: { level: 'systems', id: 'system:client' },
  childLevel: 'blocks',
  children: [
    {
      id: 'block:state',
      key: 'state',
      level: 'blocks',
      label: 'State',
      description: 'Shared client state.',
      parent: 'system:client',
      fileCount: 12,
      inbound: 3,
      outbound: 5,
      position: { x: 0, y: 0 },
    },
    {
      id: 'block:surfaces',
      key: 'surfaces',
      level: 'blocks',
      label: 'Surfaces',
      parent: 'system:client',
      fileCount: 18,
      inbound: 5,
      outbound: 2,
      position: { x: 12, y: 6 },
    },
  ],
  childCount: { total: 5, indexed: 4, returned: 2, omitted: 1 },
  nextCursor: 'children-page-2',
  edges: [{ from: 'block:state', to: 'block:surfaces', weight: 4 }],
  edgeCount: { total: 1, indexed: 1, returned: 1, omitted: 0 },
  files: [
    {
      id: 'apps/web/src/state/projects.ts',
      label: 'projects.ts',
      system: 'Client Runtime',
      block: 'State',
      dir: 'apps/web/src/state',
      fanIn: 7,
      fanOut: 3,
    },
    {
      id: 'apps/web/src/components/ChatView.tsx',
      label: 'ChatView.tsx',
      system: 'Client Runtime',
      block: 'Surfaces',
      dir: 'apps/web/src/components',
      fanIn: 2,
      fanOut: 11,
    },
  ],
  fileCount: { total: 4, indexed: 4, returned: 2, omitted: 0 },
  nextFileCursor: 'files-page-2',
} as CartographerGetArchitectureScopeResult

function scopeProps(
  overrides: Partial<ArchitectureScopeViewProps> = {},
): ArchitectureScopeViewProps
{
  return {
    target: { source, scope: { level: 'systems', id: 'system:client' } },
    result: scopeResult,
    isPending: false,
    error: null,
    childPage: 1,
    filePage: 1,
    hasPreviousChildren: false,
    hasPreviousFiles: false,
    narrow: false,
    onRetry: () => undefined,
    onNextChildren: () => undefined,
    onPreviousChildren: () => undefined,
    onNextFiles: () => undefined,
    onPreviousFiles: () => undefined,
    onOpenScope: () => undefined,
    onOpenFile: () => undefined,
    ...overrides,
  }
}

const neighborhoodResult = {
  version: 1,
  source,
  target: 'apps/web/src/state/projects.ts',
  direction: 'both',
  maxDepth: 1,
  upstream: {
    items: ['apps/web/src/components/ChatView.tsx'],
    total: 2,
    omitted: 1,
  },
  downstream: {
    items: ['packages/client-runtime/src/state/projects/projectCommands.ts'],
    total: 1,
    omitted: 0,
  },
  impactedFileCount: 3,
} as CartographerGetArchitectureNeighborhoodResult

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

describe('ArchitectureScopeView', () =>
{
  it('keeps child and file paging distinct while disclosing exact count categories', () =>
  {
    const markup = renderToStaticMarkup(<ArchitectureScopeView {...scopeProps()} />)

    expect(markup).toContain('2 returned of 4 indexed units · 1 not indexed')
    expect(markup).toContain('2 returned of 4 indexed files')
    expect(markup).toContain('aria-label="Next blocks page"')
    expect(markup).toContain('aria-label="Next file page"')
    expect(markup).toContain('Files in scope')
    expect(markup).not.toContain('Explorer')
    expect(markup).not.toContain('Insights')

    const filesOnlyMarkup = renderToStaticMarkup(
      <ArchitectureScopeView
        {...scopeProps({
          target: { source, scope: { level: 'dirs', id: 'dirs:apps/web/src/state' } },
          result: {
            ...scopeResult,
            scope: { level: 'dirs', id: 'dirs:apps/web/src/state' },
            childLevel: 'dirs',
            children: [],
            childCount: { total: 0, indexed: 0, returned: 0, omitted: 0 },
            edges: [],
            edgeCount: { total: 0, indexed: 0, returned: 0, omitted: 0 },
          },
        })}
      />,
    )
    const filesOnlyDocument = new DOMParser().parseFromString(filesOnlyMarkup, 'text/html')
    expect(filesOnlyDocument.body.textContent).toContain('Folder scope')
    expect(filesOnlyDocument.querySelector('[data-architecture-view]')).toBeNull()
    expect(filesOnlyDocument.querySelector('[data-scope-files]')?.hasAttribute('open')).toBe(true)
  })

  it('opens block, folder, file, and dependency resources only through explicit actions', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onNextChildren = vi.fn()
    const onNextFiles = vi.fn()
    const onOpenScope = vi.fn()
    const onOpenFile = vi.fn()

    act(() =>
      root.render(
        <ArchitectureScopeView
          {...scopeProps({ onNextChildren, onNextFiles, onOpenScope, onOpenFile })}
        />,
      ),
    )

    act(() => findButton(container, 'Next blocks page').click())
    expect(onNextChildren).toHaveBeenCalledOnce()

    const block = container.querySelector('[data-architecture-unit-id="block:state"]')
    act(() => (block as HTMLButtonElement).click())
    expect(onOpenScope).not.toHaveBeenCalled()
    act(() => findButton(container, 'Open block').click())
    expect(onOpenScope).toHaveBeenCalledWith({
      source,
      scope: { level: 'blocks', id: 'block:state' },
    })
    act(() => findButton(container, 'Close architecture details').click())

    const details = container.querySelector('[data-scope-files]') as HTMLDetailsElement
    act(() =>
    {
      details.open = true
      details.dispatchEvent(new Event('toggle', { bubbles: true }))
    })
    act(() => findButton(container, 'Next file page').click())
    expect(onNextFiles).toHaveBeenCalledOnce()

    const fileButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('apps/web/src/state/projects.ts'),
    ) as HTMLButtonElement
    act(() => fileButton.click())
    expect(onOpenFile).not.toHaveBeenCalled()
    act(() => findButton(container, 'Dependencies').click())
    expect(onOpenScope).toHaveBeenLastCalledWith({
      source,
      scope: { level: 'file-neighborhood', path: 'apps/web/src/state/projects.ts' },
    })
    act(() => findButton(container, 'Open file').click())
    expect(onOpenFile).toHaveBeenCalledWith({
      source,
      relativePath: 'apps/web/src/state/projects.ts',
    })

    const folderId = 'dirs:apps/web/src/state'
    act(() =>
      root.render(
        <ArchitectureScopeView
          {...scopeProps({
            target: { source, scope: { level: 'blocks', id: 'block:state' } },
            result: {
              ...scopeResult,
              scope: { level: 'blocks', id: 'block:state' },
              childLevel: 'dirs',
              children: [
                {
                  id: folderId,
                  key: 'apps/web/src/state',
                  level: 'dirs',
                  label: 'state',
                  parent: 'block:state',
                  fileCount: 12,
                  inbound: 0,
                  outbound: 0,
                  position: { x: 0, y: 0 },
                },
              ],
              childCount: { total: 1, indexed: 1, returned: 1, omitted: 0 },
              edges: [],
              edgeCount: { total: 0, indexed: 0, returned: 0, omitted: 0 },
            },
            onOpenScope,
            onOpenFile,
          })}
        />,
      ),
    )
    const folder = container.querySelector(`[data-architecture-unit-id="${folderId}"]`)
    const callsBeforeFolderOpen = onOpenScope.mock.calls.length
    act(() => (folder as HTMLButtonElement).click())
    expect(onOpenScope).toHaveBeenCalledTimes(callsBeforeFolderOpen)
    act(() => findButton(container, 'Open folder').click())
    expect(onOpenScope).toHaveBeenLastCalledWith({
      source,
      scope: { level: 'dirs', id: folderId },
    })

    act(() => root.unmount())
    container.remove()
  })

  it.each([
    {
      page: 'child',
      nextLabel: 'Next blocks page',
      pagesLabel: 'blocks pages',
      previousLabel: 'Previous blocks page',
    },
    {
      page: 'file',
      nextLabel: 'Next file page',
      pagesLabel: 'file pages',
      previousLabel: 'Previous file page',
    },
  ])(
    'keeps the last-good $page page identity and Previous action while a later page loads or fails',
    ({ nextLabel, pagesLabel, previousLabel }) =>
    {
      const failedPageAtom = Symbol('failed-architecture-scope-page')
      const refresh = vi.fn()
      scopeMocks.queryResults.set(scopeMocks.scopeAtom, {
        data: scopeResult,
        error: null,
        failure: null,
        isPending: false,
        hasSettled: true,
        refresh,
      })
      scopeMocks.queryResults.set(failedPageAtom, {
        data: null,
        error: null,
        failure: null,
        isPending: true,
        hasSettled: false,
        refresh,
      })
      scopeMocks.getArchitectureScope.mockImplementation((request?: unknown) =>
      {
        const input = (request as { readonly input?: Record<string, unknown> } | undefined)?.input
        return input?.cursor || input?.fileCursor ? failedPageAtom : scopeMocks.scopeAtom
      })

      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      const renderSurface = (): void =>
      {
        root.render(
          <ArchitectureScopeSurface
            environmentId={'environment-scope-test' as EnvironmentId}
            onOpenFile={() => undefined}
            onOpenScope={() => undefined}
            target={{ source, scope: { level: 'systems', id: 'system:client' } }}
            threadId={'thread-scope-test' as ThreadId}
          />,
        )
      }

      act(renderSurface)

      act(() => findButton(container, nextLabel).click())

      expect(container.querySelector(`nav[aria-label="${pagesLabel}"]`)?.textContent).toContain(
        'Page 1',
      )
      expect(container.querySelector('[data-architecture-unit-id="block:state"]')).not.toBeNull()
      expect(findButton(container, previousLabel).disabled).toBe(false)

      scopeMocks.queryResults.set(failedPageAtom, {
        data: null,
        error: 'The next architecture page failed.',
        failure: new Error('The next architecture page failed.'),
        isPending: false,
        hasSettled: true,
        refresh,
      })
      act(renderSurface)

      expect(container.textContent).toContain('The next architecture page failed.')
      expect(container.querySelector('[data-architecture-unit-id="block:state"]')).not.toBeNull()
      expect(container.querySelector(`nav[aria-label="${pagesLabel}"]`)?.textContent).toContain(
        'Page 1',
      )
      const previous = findButton(container, previousLabel)
      expect(previous.disabled).toBe(false)

      act(() => previous.click())
      expect(container.textContent).not.toContain('The next architecture page failed.')
      expect(container.querySelector('[data-architecture-unit-id="block:state"]')).not.toBeNull()

      act(() => root.unmount())
      container.remove()
    },
  )
})

function NeighborhoodHarness(props: {
  readonly onDirectionChange: (direction: 'upstream' | 'downstream' | 'both') => void
  readonly onOpenFile: ArchitectureNeighborhoodViewProps['onOpenFile']
})
{
  const [direction, setDirection] = useState<'upstream' | 'downstream' | 'both'>('both')
  return (
    <ArchitectureNeighborhoodView
      direction={direction}
      error={null}
      isPending={false}
      narrow={false}
      onDirectionChange={(next) =>
      {
        props.onDirectionChange(next)
        setDirection(next)
      }}
      onOpenFile={props.onOpenFile}
      onRetry={() => undefined}
      path={'apps/web/src/state/projects.ts' as ArchitectureRelativePath}
      result={neighborhoodResult}
      source={source}
    />
  )
}

describe('ArchitectureNeighborhoodView', () =>
{
  it('uses one deterministic Incoming, Outgoing, or Both control and preserves exact source', () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onDirectionChange = vi.fn()
    const onOpenFile = vi.fn()

    act(() =>
      root.render(
        <NeighborhoodHarness onDirectionChange={onDirectionChange} onOpenFile={onOpenFile} />,
      ),
    )
    expect(container.querySelector('[aria-label="Incoming dependencies"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Outgoing dependencies"]')).not.toBeNull()
    expect(container.textContent).toContain('1 returned of 2 · 1 omitted')

    act(() => findButton(container, 'Outgoing').click())
    expect(onDirectionChange).toHaveBeenCalledWith('downstream')
    expect(container.querySelector('[aria-label="Incoming dependencies"]')).toBeNull()
    expect(container.querySelector('[aria-label="Outgoing dependencies"]')).not.toBeNull()

    const path = 'packages/client-runtime/src/state/projects/projectCommands.ts'
    const pathButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(path),
    ) as HTMLButtonElement
    act(() => pathButton.click())
    expect(onOpenFile).not.toHaveBeenCalled()
    act(() => findButton(container, 'Open file').click())
    expect(onOpenFile).toHaveBeenCalledWith({ source, relativePath: path })

    act(() => root.unmount())
    container.remove()
  })

  it('constructs generation-bound scope and neighborhood queries without current-tree fallback', () =>
  {
    const refresh = vi.fn()
    const query = (data: unknown) => ({
      data,
      error: null,
      failure: null,
      isPending: false,
      hasSettled: true,
      refresh,
    })
    scopeMocks.queryResults.set(scopeMocks.scopeAtom, query(scopeResult))
    scopeMocks.queryResults.set(scopeMocks.neighborhoodAtom, query(neighborhoodResult))
    scopeMocks.getArchitectureScope.mockClear()
    scopeMocks.getArchitectureNeighborhood.mockClear()

    const sharedProps = {
      environmentId: 'environment-scope-test' as EnvironmentId,
      threadId: 'thread-scope-test' as ThreadId,
      onOpenScope: () => undefined,
      onOpenFile: () => undefined,
    }
    renderToStaticMarkup(
      <ArchitectureScopeSurface
        {...sharedProps}
        target={{ source, scope: { level: 'systems', id: 'system:client' } }}
      />,
    )
    expect(scopeMocks.getArchitectureScope).toHaveBeenCalledWith({
      environmentId: 'environment-scope-test',
      input: {
        threadId: 'thread-scope-test',
        source,
        scope: { level: 'systems', id: 'system:client' },
        limit: 50,
        fileLimit: 50,
      },
    })

    renderToStaticMarkup(
      <ArchitectureScopeSurface
        {...sharedProps}
        target={{
          source,
          scope: { level: 'file-neighborhood', path: 'apps/web/src/state/projects.ts' },
        }}
      />,
    )
    expect(scopeMocks.getArchitectureNeighborhood).toHaveBeenCalledWith({
      environmentId: 'environment-scope-test',
      input: {
        threadId: 'thread-scope-test',
        source,
        target: 'apps/web/src/state/projects.ts',
        direction: 'both',
        maxDepth: 1,
      },
    })
  })
})
