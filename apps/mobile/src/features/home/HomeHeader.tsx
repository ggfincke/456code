// apps/mobile/src/features/home/HomeHeader.tsx
// render home header

import type { EnvironmentId, SidebarThreadSortOrder } from '@t3tools/contracts'
import { useAtomValue } from '@effect/atom-react'
import { AsyncResult } from 'effect/unstable/reactivity'
import { NativeStackScreenOptions } from '../../native/StackHeader'
import { useCallback, useRef } from 'react'
import type { SearchBarCommands } from 'react-native-screens'

import { useThemeColor } from '../../lib/useThemeColor'
import { mobilePreferencesAtom } from '../../state/preferences'
import { useHardwareKeyboardCommand } from '../keyboard/hardwareKeyboardCommands'
import { withNativeGlassHeaderItem } from '../layout/native-glass-header-items'
import { createNativeMailSearchToolbarItem } from '../layout/native-mail-search-toolbar'
import type { HomeProjectSortOrder } from './homeThreadList'
import {
  buildHomeListFilterMenu,
  type HomeListFilterMenuEnvironment,
  type HomeListFilterMenuProject,
} from './home-list-filter-menu'
import { hasCustomHomeListOptions } from './home-list-options'

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment

// thread list v2 uses fixed creation order, so its filter menu omits sort controls.
function useThreadListV2FilterGate(): boolean
{
  const preferencesResult = useAtomValue(mobilePreferencesAtom)
  return (
    AsyncResult.isSuccess(preferencesResult) && preferencesResult.value.threadListV2Enabled === true
  )
}

export function HomeHeader(props: {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>
  readonly searchQuery: string
  readonly selectedEnvironmentId: EnvironmentId | null
  readonly selectedProjectKey: string | null
  readonly projectSortOrder: HomeProjectSortOrder
  readonly threadSortOrder: SidebarThreadSortOrder
  readonly onSearchQueryChange: (query: string) => void
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void
  readonly onProjectChange: (projectKey: string | null) => void
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void
  readonly onOpenSettings: () => void
  readonly onStartNewTask: () => void
})
{
  const searchBarRef = useRef<SearchBarCommands>(null)
  const iconColor = useThemeColor('--color-icon')
  const threadListV2Enabled = useThreadListV2FilterGate()
  const hasCustomListOptions = threadListV2Enabled
    ? props.selectedEnvironmentId !== null || props.selectedProjectKey !== null
    : hasCustomHomeListOptions(props)
  const focusSearch = useCallback(() =>
  {
    searchBarRef.current?.focus()
    return searchBarRef.current !== null
  }, [])
  useHardwareKeyboardCommand('focusSearch', focusSearch)
  const filterMenu = buildHomeListFilterMenu({
    ...props,
    listOrganization: !threadListV2Enabled,
  })

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={filterMenu.items}
        options={{
          // static header config (glass, title, fonts) lives in Stack.tsx
          // (GLASS_HEADER_OPTIONS). Only dynamic values are set here.
          headerTintColor: iconColor,
          unstable_headerRightItems: () => [
            withNativeGlassHeaderItem({
              accessibilityLabel: 'Open settings',
              icon: { name: 'ellipsis', type: 'sfSymbol' } as const,
              identifier: 'home-settings',
              label: '',
              onPress: props.onOpenSettings,
              type: 'button',
            }),
          ],
          unstable_headerToolbarItems: () => [
            createNativeMailSearchToolbarItem({
              composeButtonId: 'home-new-task',
              composeSystemImageName: 'square.and.pencil',
              filterMenu,
              filterButtonId: 'home-filter',
              filterSystemImageName: hasCustomListOptions
                ? 'line.3.horizontal.decrease.circle.fill'
                : 'line.3.horizontal.decrease',
              onComposePress: props.onStartNewTask,
              onSearchTextChange: props.onSearchQueryChange,
              placeholder: 'Search',
              searchTextChangeId: 'home-search-text',
            }),
          ],
          headerSearchBarOptions: undefined,
        }}
      />
    </>
  )
}
