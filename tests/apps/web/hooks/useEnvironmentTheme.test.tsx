// tests/apps/web/hooks/useEnvironmentTheme.test.tsx
// verify live theme adoption, human intent, and palette lifecycle through mounted hooks

// @vitest-environment happy-dom

import { RegistryContext } from '@effect/atom-react'
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type EnvironmentTheme,
  type ServerSettings,
} from '@t3tools/contracts'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('~/state/server', async () =>
{
  const { Atom } = await import('effect/unstable/reactivity')
  const { DEFAULT_SERVER_SETTINGS } = await import('@t3tools/contracts')
  return {
    primaryServerConfigSourceAtom: Atom.make<'cache' | 'live' | null>('cache'),
    primaryServerSettingsAtom: Atom.make(DEFAULT_SERVER_SETTINGS),
    primaryServerEnvironmentThemesAtom: Atom.make<ReadonlyArray<EnvironmentTheme>>([]),
  }
})
vi.mock('~/state/primaryEnvironment', async () =>
{
  const { Atom } = await import('effect/unstable/reactivity')
  return { primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null) }
})

import { useDefaultThemeAdoption } from '../../../../apps/web/src/hooks/useDefaultTheme'
import {
  publishedThemeDefinitions,
  useEnvironmentThemeSync,
} from '../../../../apps/web/src/hooks/useEnvironmentTheme'
import { useTheme } from '../../../../apps/web/src/hooks/useTheme'
import { toCanonicalThemeColor } from '../../../../apps/web/src/themePalette'
import { primaryEnvironmentIdAtom } from '../../../../apps/web/src/state/primaryEnvironment'
import {
  primaryServerConfigSourceAtom,
  primaryServerEnvironmentThemesAtom,
  primaryServerSettingsAtom,
} from '../../../../apps/web/src/state/server'

function ThemeHarness()
{
  useEnvironmentThemeSync()
  useDefaultThemeAdoption()
  const { theme, setTheme, resolvedTheme, userSelectionRevision } = useTheme()
  return (
    <>
      <output data-appearance={resolvedTheme} data-revision={userSelectionRevision}>
        {theme}
      </output>
      <button type="button" onClick={() => setTheme(theme)}>
        Reselect
      </button>
      <button type="button" onClick={() => setTheme('light')}>
        Light
      </button>
      <button type="button" onClick={() => setTheme('ocean')}>
        Ocean
      </button>
      <button type="button" onClick={() => setTheme('system')}>
        System
      </button>
    </>
  )
}

const PUBLISHED: EnvironmentTheme = {
  id: 'published',
  name: 'Published',
  appearance: 'dark',
  canvas: '#111111',
  accent: '#aabbff',
}

describe('environment theme adoption', () =>
{
  let registry: AtomRegistry.AtomRegistry
  let root: Root
  let container: HTMLDivElement
  let environmentId: EnvironmentId
  let testId = 0
  const set = <A,>(atom: Atom.Atom<A>, value: A) => registry.set(atom as Atom.Writable<A>, value)
  const settings = (theme: string, generation: string): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    defaultTheme: theme,
    defaultThemeSetAt: generation,
  })
  const selected = () => container.querySelector('output')!.textContent
  const select = async (label: string) =>
    act(async () =>
    {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === label)!
        .click()
    })
  const render = async () =>
    act(async () =>
    {
      root.render(
        <RegistryContext.Provider value={registry}>
          <ThemeHarness />
        </RegistryContext.Provider>,
      )
    })

  beforeEach(() =>
  {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    window.localStorage.clear()
    registry = AtomRegistry.make()
    environmentId = EnvironmentId.make(`theme-test-${++testId}`)
    set(primaryEnvironmentIdAtom, environmentId)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () =>
  {
    await act(async () => root.unmount())
    registry.dispose()
    container.remove()
    Reflect.deleteProperty(window, 'desktopBridge')
    vi.restoreAllMocks()
  })

  it('waits for live defaults and preserves identical human reselection before a late palette', async () =>
  {
    set(primaryServerSettingsAtom, settings('dark', 'cached'))
    await render()
    expect(selected()).toBe('system')
    await act(async () =>
    {
      set(primaryServerSettingsAtom, settings('published', 'one'))
      set(primaryServerConfigSourceAtom, 'live')
    })
    const revision = Number(container.querySelector('output')!.getAttribute('data-revision'))
    await select('Reselect')
    expect(Number(container.querySelector('output')!.getAttribute('data-revision'))).toBe(
      revision + 1,
    )
    await act(async () => set(primaryServerEnvironmentThemesAtom, [PUBLISHED]))
    expect(selected()).toBe('system')
    expect(window.localStorage.getItem(`456code:default-theme-consumed:v1:${environmentId}`)).toBe(
      'published@one',
    )
    await act(async () => set(primaryServerSettingsAtom, settings('published', 'two')))
    expect(selected()).toBe('published')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    await select('Light')
    await act(async () => set(primaryServerSettingsAtom, settings('published', 'two')))
    expect(selected()).toBe('light')
    await act(async () => set(primaryServerSettingsAtom, settings('', '')))
    expect(selected()).toBe('light')
  })

  it('keeps a missing selection and repaints its republished appearance without leaking IDs to Electron', async () =>
  {
    const setTheme = vi.fn(async (_theme: 'light' | 'dark' | 'system') => undefined)
    Object.defineProperty(window, 'desktopBridge', { configurable: true, value: { setTheme } })
    const published: EnvironmentTheme = { ...PUBLISHED, appearance: 'light', canvas: '#eeeeee' }
    expect(publishedThemeDefinitions([published])[0]?.colors).toMatchObject({
      canvas: toCanonicalThemeColor(published.canvas),
      accent: toCanonicalThemeColor(published.accent),
    })
    set(primaryServerEnvironmentThemesAtom, [published])
    set(primaryServerSettingsAtom, settings('published', 'one'))
    set(primaryServerConfigSourceAtom, 'live')
    await render()
    expect(selected()).toBe('published')
    expect(setTheme).toHaveBeenLastCalledWith('light')
    const previousCanvas = document.documentElement.style.getPropertyValue('--app-theme-canvas')
    expect(previousCanvas.length).toBeGreaterThan(0)
    await act(async () => set(primaryServerEnvironmentThemesAtom, []))
    expect(selected()).toBe('published')
    expect(window.localStorage.getItem('456code:theme')).toBe('published')
    expect(document.documentElement.dataset.environmentTheme).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--app-theme-canvas')).toBe('')
    expect(setTheme).toHaveBeenLastCalledWith('system')
    const revision = Number(container.querySelector('output')!.getAttribute('data-revision'))
    await select('Reselect')
    expect(Number(container.querySelector('output')!.getAttribute('data-revision'))).toBe(
      revision + 1,
    )
    await act(async () => set(primaryServerEnvironmentThemesAtom, [PUBLISHED]))
    expect(selected()).toBe('published')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--app-theme-canvas')).not.toBe(
      previousCanvas,
    )
    expect(setTheme).toHaveBeenLastCalledWith('dark')
    await select('Ocean')
    expect(document.documentElement.classList.contains('ocean')).toBe(true)
    expect(document.documentElement.dataset.environmentTheme).toBeUndefined()
    await select('System')
    expect(setTheme).toHaveBeenLastCalledWith('system')
    expect(
      setTheme.mock.calls.every(([value]) => ['light', 'dark', 'system'].includes(value)),
    ).toBe(true)
  })

  it('does not consume failed adoption and keeps its in-memory guard when marker persistence fails', async () =>
  {
    const marker = `456code:default-theme-consumed:v1:${environmentId}`
    window.localStorage.setItem(marker, 'old')
    const write = window.localStorage.setItem.bind(window.localStorage)
    let failThemeWrite = true
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) =>
    {
      if (key === marker || (key === '456code:theme' && failThemeWrite)) throw new Error('blocked')
      write(key, value)
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() =>
    {})
    set(primaryServerSettingsAtom, settings('dark', 'one'))
    set(primaryServerConfigSourceAtom, 'live')
    await render()
    expect(selected()).toBe('system')
    expect(window.localStorage.getItem(marker)).toBe('old')
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ operation: 'write', errorTag: 'ThemeStorageError' }),
    )
    failThemeWrite = false
    await act(async () => root.unmount())
    root = createRoot(container)
    set(primaryEnvironmentIdAtom, environmentId)
    set(primaryServerSettingsAtom, settings('dark', 'one'))
    set(primaryServerConfigSourceAtom, 'live')
    await render()
    expect(selected()).toBe('dark')
    await select('Light')
    await act(async () => root.unmount())
    root = createRoot(container)
    set(primaryEnvironmentIdAtom, environmentId)
    set(primaryServerSettingsAtom, settings('dark', 'one'))
    set(primaryServerConfigSourceAtom, 'live')
    await render()
    expect(selected()).toBe('light')
    await act(async () => set(primaryServerSettingsAtom, settings('dark', 'two')))
    expect(selected()).toBe('dark')
  })
})
