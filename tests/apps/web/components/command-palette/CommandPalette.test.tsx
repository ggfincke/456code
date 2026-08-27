// tests/apps/web/components/command-palette/CommandPalette.test.tsx
// keep shortcut-selected search surfaces exclusive and unmounted when closed

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

vi.mock('@tanstack/react-router', () => ({ useParams: () => null }))
vi.mock('../../../../../apps/web/src/state/server', async () =>
{
  const { Atom } = await import('effect/unstable/reactivity')
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import('@t3tools/shared/keybindings')
  return { primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) }
})
vi.mock('../../../../../apps/web/src/components/command-palette/OpenCommandPaletteDialog', () => ({
  CommandPaletteDialog: () => <div data-search-surface="commands" />,
}))
vi.mock('../../../../../apps/web/src/components/files/ProjectFilePicker', () => ({
  ProjectFilePicker: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => (
    <button data-search-surface="files" onClick={() => onOpenChange(false)}>
      Close file picker
    </button>
  ),
}))
vi.mock('../../../../../apps/web/src/components/search/ProjectContentSearch', () => ({
  ProjectContentSearch: () => <div data-search-surface="contents" />,
}))

import { CommandPalette } from '../../../../../apps/web/src/components/command-palette/CommandPalette'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('switches between file, content, and command searches without leaving closed search components mounted', async () =>
{
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const shortcut = async (key: string, shiftKey = false) =>
  {
    const event = new KeyboardEvent('keydown', {
      key,
      shiftKey,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () =>
    {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
  }
  try
  {
    await act(async () =>
      root.render(
        <CommandPalette>
          <p>Workspace</p>
        </CommandPalette>,
      ),
    )
    expect(container.querySelector('[data-search-surface]')).toBeNull()
    await shortcut('p')
    expect(
      container.querySelector('[data-search-surface]')?.getAttribute('data-search-surface'),
    ).toBe('files')
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[data-search-surface]')).toBeNull()
    await shortcut('f', true)
    expect(container.querySelectorAll('[data-search-surface]')).toHaveLength(1)
    expect(
      container.querySelector('[data-search-surface]')?.getAttribute('data-search-surface'),
    ).toBe('contents')
    await shortcut('k')
    expect(
      container.querySelector('[data-search-surface]')?.getAttribute('data-search-surface'),
    ).toBe('commands')
    await shortcut('k')
    expect(container.querySelector('[data-search-surface]')).toBeNull()
  }
  finally
  {
    act(() => root.unmount())
    container.remove()
  }
})
