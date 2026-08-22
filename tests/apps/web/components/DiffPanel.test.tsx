// tests/apps/web/components/DiffPanel.test.tsx
// verifies accessible diff tabs lazily retain visited subviews

// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  DiffPanelChangesAvailability,
  DiffPanelViews,
  type DiffPanelView,
} from '../../../../apps/web/src/components/DiffPanelShell'

function markup(activeView: DiffPanelView): string
{
  return renderToStaticMarkup(
    <DiffPanelViews
      activeView={activeView}
      onViewChange={() => undefined}
      changes={<div>Changes content</div>}
      architecture={<div>Architecture content</div>}
    />,
  )
}

function ArchitectureQueryProbe(props: { readonly query: () => void })
{
  props.query()
  return <div>Architecture content</div>
}

function DiffViewsHarness(props: { readonly architectureQuery: () => void })
{
  const [activeView, setActiveView] = useState<DiffPanelView>('changes')
  return (
    <DiffPanelViews
      activeView={activeView}
      architecture={<ArchitectureQueryProbe query={props.architectureQuery} />}
      changes={<div>Changes content</div>}
      onViewChange={setActiveView}
    />
  )
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('DiffPanel views', () =>
{
  it('keeps the untouched Changes view free of architecture content', () =>
  {
    const rendered = markup('changes')

    expect(rendered).toContain('role="tablist" aria-label="Diff views"')
    expect(rendered.match(/role="tab"/g)).toHaveLength(2)
    expect(rendered.match(/role="tabpanel"/g)).toHaveLength(2)
    expect(rendered).toContain('>Impact Diff</button>')
    expect(rendered).toContain('Changes content')
    expect(rendered).not.toContain('Architecture content')
  })

  it('mounts Impact Diff on first activation and retains it after returning to Changes', () =>
  {
    const architectureQuery = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    act(() => root.render(<DiffViewsHarness architectureQuery={architectureQuery} />))
    expect(architectureQuery).not.toHaveBeenCalled()

    const impactTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === 'Impact Diff',
    ) as HTMLButtonElement
    act(() => impactTab.click())
    expect(architectureQuery).toHaveBeenCalled()
    expect(container.textContent).toContain('Architecture content')

    const changesTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === 'Changes',
    ) as HTMLButtonElement
    act(() => changesTab.click())
    expect(container.textContent).toContain('Architecture content')
    expect(container.querySelector('[role="tabpanel"][hidden]')?.textContent).toContain(
      'Architecture content',
    )

    act(() => root.unmount())
    container.remove()
  })

  it('renders an exact retained run diff when the current path is not a repository', () =>
  {
    const exact = renderToStaticMarkup(
      <DiffPanelChangesAvailability
        hasActiveThread
        isCurrentPathGitRepository={false}
        readsRetainedRepositoryIdentity
        hasSelectedTurn={false}
        hasCompletedTurns
      >
        <div>Exact retained run diff</div>
      </DiffPanelChangesAvailability>,
    )
    const legacy = renderToStaticMarkup(
      <DiffPanelChangesAvailability
        hasActiveThread
        isCurrentPathGitRepository={false}
        readsRetainedRepositoryIdentity={false}
        hasSelectedTurn={false}
        hasCompletedTurns
      >
        <div>Legacy run diff</div>
      </DiffPanelChangesAvailability>,
    )

    expect(exact).toContain('Exact retained run diff')
    expect(exact).not.toContain('not a git repository')
    expect(legacy).toContain('not a git repository')
    expect(legacy).not.toContain('Legacy run diff')
  })

  it('renders a captured checkpoint diff without a current repository path', () =>
  {
    const rendered = renderToStaticMarkup(
      <DiffPanelChangesAvailability
        hasActiveThread
        isCurrentPathGitRepository={false}
        readsRetainedRepositoryIdentity
        hasSelectedTurn
        hasCompletedTurns
      >
        <div>Captured checkpoint diff</div>
      </DiffPanelChangesAvailability>,
    )

    expect(rendered).toContain('Captured checkpoint diff')
    expect(rendered).not.toContain('not a git repository')
  })
})
