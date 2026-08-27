// tests/apps/web/components/settings/SettingsSidebarNav.test.tsx
// exercise settings search keyboard navigation and repeated hash targeting

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { SettingsSidebarNav } from '../../../../../apps/web/src/components/settings/SettingsSidebarNav'
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from '../../../../../apps/web/src/components/settings/settingsLayout'
import { Sidebar, SidebarProvider } from '../../../../../apps/web/src/components/ui/sidebar'
import { Route as SettingsRoute } from '../../../../../apps/web/src/routes/settings'

vi.mock('../../../../../apps/web/src/components/settings/SettingsPanels', () => ({
  useSettingsRestore: () => ({ changedSettingLabels: [], restoreDefaults: vi.fn() }),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(Element.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const SettingsLayout = SettingsRoute.options.component!
let root: Root
let container: HTMLDivElement
let scrollIntoView = vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>()

function SearchLayout()
{
  const pathname = useLocation({ select: (location) => location.pathname })
  return (
    <SidebarProvider>
      <Sidebar>
        <SettingsSidebarNav pathname={pathname} />
      </Sidebar>
      <Outlet />
    </SidebarProvider>
  )
}

async function renderSettings()
{
  const rootRoute = createRootRoute({ component: SearchLayout })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'settings',
    component: SettingsLayout,
  })
  const generalRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'general',
    component: () => (
      <SettingsPageContainer>
        <SettingsSection title="General">
          <SettingsRow id="settings-theme" title="Theme" description="Choose a theme" />
          <input aria-label="Other setting" />
        </SettingsSection>
      </SettingsPageContainer>
    ),
  })
  const integrationsRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'integrations',
    component: () => (
      <SettingsPageContainer>
        <SettingsSection id="browser" title="Browser">
          <p>Browser controls</p>
        </SettingsSection>
      </SettingsPageContainer>
    ),
  })
  const history = createMemoryHistory({ initialEntries: ['/settings/general'] })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      settingsRoute.addChildren([generalRoute, integrationsRoute]),
    ]),
    history,
  })
  await act(async () =>
  {
    await router.load()
    root.render(<RouterProvider router={router} />)
  })
  return router
}

function getSearchInput(): HTMLInputElement
{
  return document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
}

function typeQuery(query: string)
{
  const input = getSearchInput()
  act(() =>
  {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressKey(target: HTMLElement, key: string)
{
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () =>
  {
    target.dispatchEvent(event)
  })
  return event
}

beforeEach(() =>
{
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  scrollIntoView = vi.fn()
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)
})

afterEach(() =>
{
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('settings search navigation', () =>
{
  it('contains Escape, selects with arrows and Enter, and refocuses repeated hash targets', async () =>
  {
    const router = await renderSettings()
    typeQuery('theme')
    const escape = await pressKey(getSearchInput(), 'Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(getSearchInput().value).toBe('')
    expect(router.state.location.pathname).toBe('/settings/general')
    await pressKey(getSearchInput(), 'Escape')
    expect(router.state.location.pathname).toBe('/settings/general')

    typeQuery('browser')
    await pressKey(getSearchInput(), 'ArrowDown')
    expect(getSearchInput().getAttribute('aria-activedescendant')).toBe(
      'settings-search-result-agent-browser-access',
    )
    await pressKey(getSearchInput(), 'ArrowUp')
    await pressKey(getSearchInput(), 'Enter')
    await act(async () =>
    {
      await router.load()
    })
    expect(router.state.location.pathname).toBe('/settings/integrations')
    expect(router.state.location.hash).toBe('browser')
    expect(document.activeElement?.id).toBe('browser')

    scrollIntoView.mockClear()
    typeQuery('viewport')
    await pressKey(getSearchInput(), 'Enter')
    expect(document.activeElement?.id).toBe('browser')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(getSearchInput().value).toBe('')
  })

  it('focuses search with slash without stealing slash from another text input', async () =>
  {
    await renderSettings()
    await pressKey(document.body, '/')
    await act(async () =>
    {
      await new Promise(requestAnimationFrame)
    })
    expect(document.activeElement).toBe(getSearchInput())
    const otherInput = document.querySelector<HTMLInputElement>('[aria-label="Other setting"]')!
    otherInput.focus()
    const slash = await pressKey(otherInput, '/')
    expect(slash.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(otherInput)
  })

  it('opens a closed mobile sidebar for slash and keeps focus on the selected target after closing', async () =>
  {
    const matchMedia = window.matchMedia.bind(window)
    vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    {
      const media = matchMedia(query)
      Object.defineProperty(media, 'matches', { value: query === '(max-width: 767px)' })
      return media
    })
    const router = await renderSettings()
    expect(getSearchInput()).toBeNull()
    await pressKey(document.body, '/')
    await act(async () =>
    {
      await new Promise(requestAnimationFrame)
    })
    expect(document.activeElement).toBe(getSearchInput())
    typeQuery('viewport')
    await pressKey(getSearchInput(), 'Enter')
    await act(async () =>
    {
      await router.load()
      await new Promise(requestAnimationFrame)
    })
    expect(router.state.location.pathname).toBe('/settings/integrations')
    expect(document.activeElement?.id).toBe('browser')
  })
})
