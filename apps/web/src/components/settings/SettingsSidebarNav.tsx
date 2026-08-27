// apps/web/src/components/settings/SettingsSidebarNav.tsx
// renders settings navigation and settings search

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from 'react'
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BlocksIcon,
  BotIcon,
  ActivityIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  ImportIcon,
  KeyboardIcon,
  Link2Icon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from 'lucide-react'
import { useCanGoBack, useLocation, useNavigate } from '@tanstack/react-router'

import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Kbd } from '../ui/kbd'
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '../ui/sidebar'
import { scrollToSettingsTarget } from './settingsLayout'
import {
  searchSettings,
  SETTINGS_SECTION_LABELS,
  SETTINGS_NAV_PATHS,
  SETTINGS_SEARCH_INPUT_ID,
  type SettingsPath,
  type SettingsSearchItem,
} from './settingsSearch'

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  '/settings/general': Settings2Icon,
  '/settings/keybindings': KeyboardIcon,
  '/settings/providers': BotIcon,
  '/settings/integrations': BlocksIcon,
  '/settings/diagnostics': ActivityIcon,
  '/settings/source-control': GitBranchIcon,
  '/settings/connections': Link2Icon,
  '/settings/beta': FlaskConicalIcon,
  '/settings/import': ImportIcon,
  '/settings/archived': ArchiveIcon,
}

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string
  to: SettingsPath
  icon: ComponentType<{ className?: string }>
}> = SETTINGS_NAV_PATHS.map((to) => ({
  to,
  label: SETTINGS_SECTION_LABELS[to],
  icon: SETTINGS_SECTION_ICONS[to],
}))

function SettingsSectionIcon({ to }: { to: SettingsPath })
{
  const Icon = SETTINGS_SECTION_ICONS[to]
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />
}

export function SettingsSidebarNav({ pathname }: { pathname: string })
{
  const navigate = useNavigate()
  const currentHash = useLocation({ select: (location) => location.hash })
  const canGoBack = useCanGoBack()
  const { isMobile, setOpenMobile } = useSidebar()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeResultIndex, setActiveResultIndex] = useState(0)
  const results = searchSettings(query)
  const isSearching = query.trim().length > 0
  const hasResults = results.length > 0

  // keep the keyboard-highlighted result inside the scrolled result list
  useEffect(() =>
  {
    const result = results[activeResultIndex]
    if (!result) return
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeResultIndex, results])

  const handleSectionClick = useCallback(
    (to: SettingsPath) =>
    {
      if (isMobile)
      {
        setOpenMobile(false)
      }
      void navigate({ to, hash: '', replace: true, hashScrollIntoView: false })
    },
    [isMobile, navigate, setOpenMobile],
  )
  const clearSearch = useCallback(() =>
  {
    setQuery('')
    setActiveResultIndex(0)
  }, [])
  const handleSearchResultClick = useCallback(
    (item: SettingsSearchItem) =>
    {
      clearSearch()
      if (isMobile)
      {
        setOpenMobile(false)
      }
      // entries without an anchor only know their panel, so they navigate without a
      // hash; a hash nothing answers would just linger in the URL.
      if (item.anchorId === undefined)
      {
        void navigate({ to: item.to, hash: '', replace: true, hashScrollIntoView: false })
        return
      }
      // already on the target panel & hash: the mount-time scroll will not fire again,
      // so scroll from here instead.
      if (pathname === item.to && currentHash.replace(/^#/u, '') === item.anchorId)
      {
        scrollToSettingsTarget(item.anchorId)
        return
      }
      void navigate({
        to: item.to,
        hash: item.anchorId,
        replace: true,
        hashScrollIntoView: false,
      })
    },
    [clearSearch, currentHash, isMobile, navigate, pathname, setOpenMobile],
  )
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) =>
    {
      if (event.key === 'Escape')
      {
        event.preventDefault()
        event.stopPropagation()
        clearSearch()
        return
      }
      if (results.length === 0) return
      if (event.key === 'ArrowDown')
      {
        event.preventDefault()
        setActiveResultIndex((index) => (index + 1) % results.length)
        return
      }
      if (event.key === 'ArrowUp')
      {
        event.preventDefault()
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length)
        return
      }
      if (event.key === 'Enter')
      {
        event.preventDefault()
        const result = results[activeResultIndex]
        if (result) handleSearchResultClick(result)
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, results],
  )
  const handleBackClick = useCallback(() =>
  {
    if (isMobile)
    {
      setOpenMobile(false)
    }
    if (canGoBack)
    {
      window.history.back()
      return
    }
    void navigate({ to: '/' })
  }, [canGoBack, isMobile, navigate, setOpenMobile])

  const activeResultId = results[activeResultIndex]?.id

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="gap-2 px-2 py-3">
          <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:ring-2 focus-within:ring-ring">
            <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            <Input
              ref={searchInputRef}
              id={SETTINGS_SEARCH_INPUT_ID}
              nativeInput
              unstyled
              type="search"
              value={query}
              onChange={(event) =>
              {
                setQuery(event.currentTarget.value)
                setActiveResultIndex(0)
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search"
              aria-label="Search settings"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={isSearching && hasResults}
              aria-controls={isSearching && hasResults ? 'settings-search-results' : undefined}
              aria-activedescendant={
                isSearching && activeResultId !== undefined
                  ? `settings-search-result-${activeResultId}`
                  : undefined
              }
              className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
            />
            {query.length > 0 ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-5 shrink-0 rounded-sm text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
                aria-label="Clear settings search"
                onClick={() =>
                  {
                  clearSearch()
                  searchInputRef.current?.focus()
                }}
              >
                <XIcon className="size-3" />
              </Button>
            ) : (
              <Kbd className="mr-px h-4 min-w-0 rounded-sm bg-sidebar-control-surface px-1.5 text-[10px] text-sidebar-muted-foreground ring-1 ring-sidebar-border">
                /
              </Kbd>
            )}
          </div>
          {isSearching && !hasResults ? (
            <p
              role="status"
              className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
            >
              No settings found
            </p>
          ) : null}
          <SidebarMenu
            id={isSearching && hasResults ? 'settings-search-results' : undefined}
            role={isSearching && hasResults ? 'listbox' : undefined}
            aria-label={isSearching && hasResults ? 'Settings search results' : undefined}
          >
            {isSearching
              ? results.map((item, index) => (
                  <SidebarMenuItem key={item.id} role="presentation">
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSectionIcon to={item.to} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-[11px] text-sidebar-muted-foreground/75">
                          {SETTINGS_SECTION_LABELS[item.to]}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              : SETTINGS_NAV_ITEMS.map((item) =>
                {
                  const Icon = item.icon
                  const isActive = pathname === item.to
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        size="sm"
                        isActive={isActive}
                        className={
                          isActive
                            ? 'h-8 items-center gap-2 rounded-md bg-sidebar-row-active px-2 py-1.5 text-left text-sm font-medium text-sidebar-foreground'
                            : 'h-8 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground'
                        }
                        onClick={() => handleSectionClick(item.to)}
                      >
                        <Icon
                          className={
                            isActive
                              ? 'size-4 shrink-0 text-sidebar-foreground'
                              : 'size-4 shrink-0 text-sidebar-muted-foreground/60'
                          }
                        />
                        <span className="truncate">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2">
        <SidebarMenu className="min-w-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  )
}
