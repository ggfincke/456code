// apps/mobile/src/features/threads/sidebar/ThreadNavigationSidebar.tsx
// render thread navigation sidebar

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/shell'
import { threadSearchMatchKey } from '@t3tools/client-runtime/state/thread-search'
import { LegendList } from '@legendapp/list/react-native'
import { useAtomValue } from '@effect/atom-react'
import { AsyncResult } from 'effect/unstable/reactivity'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { SearchBarCommands } from 'react-native-screens'

import { AppText as Text } from '../../../components/AppText'
import { NATIVE_LIQUID_GLASS_SUPPORTED } from '../../../native/native-glass'
import { NativeStackScreenOptions } from '../../../native/StackHeader'
import { scopedProjectKey, scopedThreadKey } from '../../../lib/scopedEntities'
import { useThemeColor } from '../../../lib/useThemeColor'
import { useProjects, useThreadShells } from '../../../state/entities'
import { mobilePreferencesAtom } from '../../../state/preferences'
import { usePendingNewTasks, type PendingNewTask } from '../../../state/use-pending-new-tasks'
import { useThreadSearch } from '../../../state/use-thread-search'
import { useWorkspaceState } from '../../../state/workspace'
import { useSavedRemoteConnections } from '../../../state/use-remote-environment-registry'
import { useHardwareKeyboardCommand } from '../../keyboard/hardwareKeyboardCommands'
import { hasCustomHomeListOptions, useHomeListOptions } from '../../home/home-list-options'
import { buildHomeListFilterMenu } from '../../home/home-list-filter-menu'
import {
  buildHomeListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeListItem,
} from '../../home/homeListItems'
import { buildHomeProjectScopes, buildHomeThreadGroups } from '../../home/homeThreadList'
import {
  SwipeableScrollGateProvider,
  useSwipeableScrollGate,
} from '../../home/thread-swipe-actions'
import { usePendingTaskListActions } from '../../home/usePendingTaskListActions'
import { useThreadListActions } from '../../home/useThreadListActions'
import { WorkspaceConnectionStatus } from '../../home/WorkspaceConnectionStatus'
import { shouldShowWorkspaceConnectionStatus } from '../../home/workspace-connection-status'
import { createSidebarHeaderItems } from './sidebar-native-header-items'
import { SidebarNavigationShell } from './sidebar-navigation-shell'
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from './thread-list-items'
import { ThreadListV2Row } from './thread-list-v2-items'
import { THREAD_LIST_V2_SETTLED_PAGE_COUNT, type ThreadListV2Item } from './threadListV2'
import { useThreadListV2State } from './use-thread-list-v2-state'

// the sidebar list serves both lists: v1 grouped items or, when the Thread
// list v2 beta is on, queued offline tasks, flat v2 rows, and a settled
// "Show more" pager.
type SidebarListItem =
  | HomeListItem
  | {
      readonly type: 'v2-pending-task'
      readonly key: string
      readonly pendingTask: PendingNewTask
      readonly isLast: boolean
    }
  | { readonly type: 'v2-thread'; readonly key: string; readonly item: ThreadListV2Item }
  | { readonly type: 'v2-show-more'; readonly key: string; readonly hiddenCount: number }

interface ThreadNavigationSidebarProps
{
  readonly width: number
  readonly visible: boolean
  readonly selectedThreadKey: string | null
  readonly onOpenSettings: () => void
  readonly onOpenEnvironmentSettings: () => void
  readonly onNewThreadInProject: (project: EnvironmentProject) => void
  readonly onSearchQueryChange: (query: string) => void
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void
  readonly onRequestVisibility: () => void
  readonly searchQuery: string
}

// iPad/large-width sidebar column.
//
// the pane is hosted inside its own navigation-inert single-screen native
// stack so the header is a real UINavigationBar with native controls
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps)
{
  return <NativeSidebarContainer {...props} />
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps)
{
  const backgroundColor = useThemeColor('--color-drawer')
  const borderColor = useThemeColor('--color-border')

  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1"
      style={{
        width: props.width,
        backgroundColor,
        borderRightColor: borderColor,
        borderRightWidth: StyleSheet.hairlineWidth,
      }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} />
      </SidebarNavigationShell>
    </View>
  )
}

function ThreadNavigationSidebarPane(props: ThreadNavigationSidebarProps)
{
  const insets = useSafeAreaInsets()
  const projects = useProjects()
  const threads = useThreadShells()
  const { state: catalogState } = useWorkspaceState()
  const { savedConnectionsById } = useSavedRemoteConnections()
  const searchBarRef = useRef<SearchBarCommands>(null)
  const openSwipeableRef = useRef<SwipeableMethods | null>(null)
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), [])
  const { archiveThread, confirmDeleteThread, settleThread, unsettleThread } =
    useThreadListActions()
  const preferencesResult = useAtomValue(mobilePreferencesAtom)
  const threadListV2Enabled =
    AsyncResult.isSuccess(preferencesResult) && preferencesResult.value.threadListV2Enabled === true
  const autoSettleOnMerge =
    !AsyncResult.isSuccess(preferencesResult) ||
    preferencesResult.value.sidebarAutoSettleOnMerge !== false
  const pendingTasks = usePendingNewTasks()
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions()
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById)
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [savedConnectionsById],
  )
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  )
  const { options, setSelectedEnvironmentId, setProjectSortOrder, setThreadSortOrder } =
    useHomeListOptions(availableEnvironmentIds)
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null)
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: options.selectedEnvironmentId,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options.projectGroupingMode, options.selectedEnvironmentId, projects],
  )
  const projectFilterOptions = useMemo(
    () =>
      projectScopes.map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
  )
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  )
  const selectedProjectScope = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === selectedProjectKey) ?? null),
    [projectScopes, selectedProjectKey],
  )
  useEffect(() =>
  {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    )
    {
      setSelectedProjectKey(null)
    }
  }, [projectFilterOptions, selectedProjectKey])
  const selectedProjectRefs = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  )
  const scopedProjects = useMemo(
    () =>
      selectedProjectRefs === null
        ? projects
        : projects.filter((project) =>
            selectedProjectRefs.has(scopedProjectKey(project.environmentId, project.id)),
          ),
    [projects, selectedProjectRefs],
  )
  const scopedThreads = useMemo(
    () =>
      selectedProjectRefs === null
        ? threads
        : threads.filter((thread) =>
            selectedProjectRefs.has(scopedProjectKey(thread.environmentId, thread.projectId)),
          ),
    [selectedProjectRefs, threads],
  )
  const scopedPendingTasks = useMemo(
    () =>
      selectedProjectRefs === null
        ? pendingTasks
        : pendingTasks.filter((pendingTask) =>
            selectedProjectRefs.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
            ),
          ),
    [pendingTasks, selectedProjectRefs],
  )
  const contentSearch = useThreadSearch({
    query: props.searchQuery,
    environmentId: options.selectedEnvironmentId,
  })
  const { matchesByKey, matchedThreadKeys } = contentSearch
  const groups = useMemo(
    () =>
      buildHomeThreadGroups({
        projects: scopedProjects,
        threads: scopedThreads,
        pendingTasks: scopedPendingTasks,
        environmentId: options.selectedEnvironmentId,
        searchQuery: props.searchQuery,
        matchedThreadKeys,
        projectSortOrder: options.projectSortOrder,
        threadSortOrder: options.threadSortOrder,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [
      matchedThreadKeys,
      options,
      props.searchQuery,
      scopedPendingTasks,
      scopedProjects,
      scopedThreads,
    ],
  )
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map())
  const updateGroupDisplay = useCallback((key: string, action: HomeGroupDisplayAction) =>
  {
    setGroupDisplayStates((previous) =>
    {
      const next = new Map(previous)
      next.set(key, nextGroupDisplayState(previous.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action))
      return next
    })
  }, [])
  const hasSearchQuery = props.searchQuery.trim().length > 0
  const listLayout = useMemo(
    () =>
      buildHomeListLayout({
        groups,
        displayStates: groupDisplayStates,
        showAllThreads: hasSearchQuery,
      }),
    [groups, groupDisplayStates, hasSearchQuery],
  )
  const projectCwdByKey = useMemo(() =>
  {
    const map = new Map<string, string>()
    for (const project of projects)
    {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot)
    }
    return map
  }, [projects])
  const projectByKey = useMemo(() =>
  {
    const map = new Map<string, EnvironmentProject>()
    for (const project of projects)
    {
      map.set(scopedProjectKey(project.environmentId, project.id), project)
    }
    return map
  }, [projects])

  const {
    handleChangeRequestState,
    layout: threadListV2Layout,
    serverConfigs,
    settlementEnvironmentIds,
    showMoreSettled,
  } = useThreadListV2State({
    enabled: threadListV2Enabled,
    threads,
    environmentId: options.selectedEnvironmentId,
    projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
    projectScopeKey: selectedProjectKey,
    searchQuery: props.searchQuery,
    matchedThreadKeys,
    autoSettleOnMerge,
  })
  const listItems = useMemo<readonly SidebarListItem[]>(() =>
  {
    if (!threadListV2Enabled) return listLayout.items
    // queued offline tasks render above the thread rows (mirrors the
    // compact Home v2 list): they are not thread shells, so the v2 item
    // builder never sees them, but they must stay visible and deletable
    // while their environment is offline. Same environment scope and
    // search filter as the list.
    const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase()
    const v2PendingTasks = pendingTasks.filter(
      (pendingTask) =>
        (options.selectedEnvironmentId === null ||
          pendingTask.message.environmentId === options.selectedEnvironmentId) &&
        (selectedProjectRefs === null ||
          selectedProjectRefs.has(
            scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
          )) &&
        (v2SearchQuery.length === 0 ||
          pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
    )
    const items: SidebarListItem[] = v2PendingTasks.map((pendingTask, index) => ({
      type: 'v2-pending-task' as const,
      key: `v2-pending:${pendingTask.message.messageId}`,
      pendingTask,
      isLast: index === v2PendingTasks.length - 1,
    }))
    for (const item of threadListV2Layout.items)
    {
      items.push({
        type: 'v2-thread' as const,
        key: scopedThreadKey(item.thread.environmentId, item.thread.id),
        item,
      })
    }
    if (threadListV2Layout.hiddenSettledCount > 0)
    {
      items.push({
        type: 'v2-show-more',
        key: 'v2-show-more',
        hiddenCount: threadListV2Layout.hiddenSettledCount,
      })
    }
    return items
  }, [
    listLayout.items,
    options.selectedEnvironmentId,
    pendingTasks,
    props.searchQuery,
    selectedProjectRefs,
    threadListV2Enabled,
    threadListV2Layout,
  ])
  const showsConnectionStatus = shouldShowWorkspaceConnectionStatus(catalogState)

  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) =>
  {
    if (openSwipeableRef.current !== methods)
    {
      openSwipeableRef.current?.close()
      openSwipeableRef.current = methods
    }
  }, [])
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) =>
  {
    if (openSwipeableRef.current === methods)
    {
      openSwipeableRef.current = null
    }
  }, [])
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) =>
    {
      props.onSelectThread(thread)
      openSwipeableRef.current?.close()
    },
    [props.onSelectThread],
  )
  const handleScrollBeginDrag = useCallback(() =>
  {
    openSwipeableRef.current?.close()
  }, [])
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  })
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? '',
      savedConnectionsById,
      serverConfigs,
      matchesByKey,
      searchQuery: props.searchQuery,
    }),
    [props.selectedThreadKey, savedConnectionsById, serverConfigs, matchesByKey, props.searchQuery],
  )
  const sidebarItemsAreEqual = useCallback(
    (previous: SidebarListItem, item: SidebarListItem): boolean =>
    {
      if (previous.type === 'v2-thread' && item.type === 'v2-thread')
      {
        return (
          previous.key === item.key &&
          previous.item.thread === item.item.thread &&
          previous.item.variant === item.item.variant &&
          previous.item.showSettledDivider === item.item.showSettledDivider
        )
      }
      if (previous.type === 'v2-show-more' && item.type === 'v2-show-more')
      {
        return previous.hiddenCount === item.hiddenCount
      }
      if (previous.type === 'v2-pending-task' && item.type === 'v2-pending-task')
      {
        return previous.pendingTask === item.pendingTask && previous.isLast === item.isLast
      }
      if (
        previous.type === 'v2-thread' ||
        previous.type === 'v2-show-more' ||
        previous.type === 'v2-pending-task' ||
        item.type === 'v2-thread' ||
        item.type === 'v2-show-more' ||
        item.type === 'v2-pending-task'
      )
      {
        return false
      }
      return homeListItemsAreEqual(previous, item)
    },
    [],
  )
  const focusSearch = useCallback(() =>
  {
    const focus = () =>
    {
      searchBarRef.current?.focus()
    }
    if (!props.visible)
    {
      props.onRequestVisibility()
      setTimeout(focus, 240)
    }
    else
    {
      focus()
    }
    return true
  }, [props.onRequestVisibility, props.visible])
  useHardwareKeyboardCommand('focusSearch', focusSearch)
  const renderListItem = useCallback(
    ({ item }: { readonly item: SidebarListItem }) =>
    {
      switch (item.type)
      {
        case 'v2-pending-task':
          return (
            <PendingTaskListRow
              variant="sidebar"
              pendingTask={item.pendingTask}
              environmentLabel={
                savedConnectionsById[item.pendingTask.message.environmentId]?.environmentLabel ??
                null
              }
              isLast={item.isLast}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          )
        case 'v2-thread':
        {
          const thread = item.item.thread
          const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId)
          return (
            <ThreadListV2Row
              thread={thread}
              searchMatch={matchesByKey.get(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )}
              searchQuery={props.searchQuery}
              variant={item.item.variant}
              showSettledDivider={item.item.showSettledDivider}
              project={projectByKey.get(scopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(scopeKey)}
              providerDriver={
                serverConfigs
                  .get(thread.environmentId)
                  ?.providers.find(
                    (provider) =>
                      provider.instanceId ===
                      (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
                  )?.driver ?? null
              }
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                  : null
              }
              pane="sidebar"
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onSelectThread={handleSelectThread}
              onDeleteThread={confirmDeleteThread}
              onArchiveThread={archiveThread}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              onSettleThread={settleThread}
              onUnsettleThread={unsettleThread}
              onChangeRequestState={handleChangeRequestState}
              projectCwd={projectCwdByKey.get(scopeKey) ?? null}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          )
        }
        case 'v2-show-more':
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(item.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
              onPress={showMoreSettled}
              className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-xs font-sans-medium text-foreground-muted">
                Show more ({item.hiddenCount} settled hidden)
              </Text>
            </Pressable>
          )
        case 'header':
          return (
            <ThreadListGroupHeader
              variant="sidebar"
              collapsed={item.collapsed}
              isFirst={item.isFirst}
              groupKey={item.group.key}
              onGroupAction={updateGroupDisplay}
              // same gating as the compact Home list: aggregated groups have no
              // single target project, and pending-project groups hold a
              // placeholder shell rather than a real project.
              newThreadTarget={item.group.newThreadTarget}
              onNewThread={props.onNewThreadInProject}
              project={item.group.representative}
              threadCount={item.group.threads.length + item.group.pendingTasks.length}
              title={item.group.title}
            />
          )
        case 'pending-task':
          return (
            <PendingTaskListRow
              variant="sidebar"
              pendingTask={item.pendingTask}
              environmentLabel={
                savedConnectionsById[item.pendingTask.message.environmentId]?.environmentLabel ??
                null
              }
              isLast={item.isLast}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          )
        case 'thread':
        {
          const thread = item.thread
          return (
            <ThreadListRow
              variant="sidebar"
              thread={thread}
              searchMatch={matchesByKey.get(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )}
              searchQuery={props.searchQuery}
              environmentLabel={
                savedConnectionsById[thread.environmentId]?.environmentLabel ?? null
              }
              projectCwd={
                projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
                null
              }
              isLast={item.isLast}
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onArchiveThread={archiveThread}
              onDeleteThread={confirmDeleteThread}
              onSelectThread={handleSelectThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          )
        }
        case 'show-more':
          return (
            <ThreadListShowMoreRow
              variant="sidebar"
              hiddenCount={item.hiddenCount}
              canShowLess={item.canShowLess}
              groupKey={item.groupKey}
              onGroupAction={updateGroupDisplay}
            />
          )
      }
    },
    [
      archiveThread,
      confirmDeletePendingTask,
      confirmDeleteThread,
      handleChangeRequestState,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      matchesByKey,
      openPendingTask,
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey,
      props.onNewThreadInProject,
      props.selectedThreadKey,
      props.searchQuery,
      props.width,
      savedConnectionsById,
      serverConfigs,
      settleThread,
      settlementEnvironmentIds,
      showMoreSettled,
      sidebarScrollGesture,
      unsettleThread,
      updateGroupDisplay,
    ],
  )
  // v2 ignores the sort/group options, so only the environment filter can
  // light the "customized" state while the beta is on.
  const filterCustomized = threadListV2Enabled
    ? options.selectedEnvironmentId !== null || selectedProjectKey !== null
    : hasCustomHomeListOptions({ ...options, selectedProjectKey })
  const filterIcon = filterCustomized
    ? 'line.3.horizontal.decrease.circle.fill'
    : 'line.3.horizontal.decrease.circle'
  const filterMenu = useMemo(
    () =>
      buildHomeListFilterMenu({
        environments,
        projects: projectFilterOptions,
        selectedEnvironmentId: options.selectedEnvironmentId,
        selectedProjectKey,
        projectSortOrder: options.projectSortOrder,
        threadSortOrder: options.threadSortOrder,
        onEnvironmentChange: setSelectedEnvironmentId,
        onProjectChange: setSelectedProjectKey,
        onProjectSortOrderChange: setProjectSortOrder,
        onThreadSortOrderChange: setThreadSortOrder,
        listOrganization: !threadListV2Enabled,
      }),
    [
      environments,
      options,
      projectFilterOptions,
      selectedProjectKey,
      setProjectSortOrder,
      setSelectedEnvironmentId,
      setThreadSortOrder,
      threadListV2Enabled,
    ],
  )
  const nativeHeaderItems = useMemo(
    () =>
      createSidebarHeaderItems({
        filterIcon,
        filterMenu,
        onOpenSettings: props.onOpenSettings,
      }),
    [filterIcon, filterMenu, props.onOpenSettings],
  )
  // "No threads yet" over an inbox that is merely all-snoozed reads as
  // data loss; name the snoozed threads instead.
  const snoozedCount = threadListV2Layout.snoozedCount
  // snoozed matches passed the search filter, so do not report them as nonexistent
  const listEmpty = (
    <Text className="px-2 py-4 text-sm text-foreground-muted">
      {catalogState.isLoadingConnections
        ? 'Loading threads…'
        : props.searchQuery.trim().length > 0
          ? contentSearch.isLoading
            ? 'Searching conversations…'
            : snoozedCount > 0
              ? snoozedCount === 1
                ? '1 matching thread snoozed'
                : 'All matching threads snoozed'
              : 'No matching threads'
          : snoozedCount > 0
            ? snoozedCount === 1
              ? '1 thread snoozed'
              : `${snoozedCount} threads snoozed`
            : selectedProjectScope !== null
              ? `No threads in ${selectedProjectScope.title}`
              : 'No threads yet'}
    </Text>
  )

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={nativeHeaderItems}
        options={{
          headerSearchBarOptions: {
            ref: searchBarRef,
            autoCapitalize: 'none',
            hideNavigationBar: false,
            // keep the search bar pinned under the title — UIKit's default
            // hidesSearchBarWhenScrolling collapses it on scroll.
            hideWhenScrolling: false,
            obscureBackground: false,
            placeholder: 'Search',
            placement: 'stacked',
            onCancelButtonPress: () =>
            {
              props.onSearchQueryChange('')
            },
            onChangeText: (event) =>
            {
              props.onSearchQueryChange(event.nativeEvent.text)
            },
          },
          unstable_headerRightItems: () => nativeHeaderItems,
        }}
      />
      <View className="flex-1">
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={sidebarScrollGesture}>
            <LegendList
              data={listItems}
              drawDistance={500}
              estimatedItemSize={64}
              extraData={listExtraData}
              getItemType={(item) => item.type}
              itemsAreEqual={sidebarItemsAreEqual}
              keyExtractor={(item) => item.key}
              renderItem={renderListItem}
              automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
              contentInsetAdjustmentBehavior={NATIVE_LIQUID_GLASS_SUPPORTED ? 'automatic' : 'never'}
              contentContainerStyle={[
                styles.threadListContent,
                {
                  paddingBottom: Math.max(insets.bottom, 16) + 16,
                  paddingTop: 6,
                },
              ]}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              recycleItems
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.threadList}
              ListHeaderComponent={
                showsConnectionStatus ? (
                  <View className="px-1.5 pt-0.5 pb-2">
                    <WorkspaceConnectionStatus
                      onPress={props.onOpenEnvironmentSettings}
                      state={catalogState}
                      variant="sidebar"
                    />
                  </View>
                ) : null
              }
              ListEmptyComponent={listEmpty}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
})
