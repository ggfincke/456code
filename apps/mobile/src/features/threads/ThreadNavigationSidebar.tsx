// apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx
// shared sidebar thread navigation with native chrome
import { useActiveNewTask } from "../../state/active-new-task";
import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import {
  pickableProjectGroups,
  resolveScratchProjectScopeKey,
} from "@t3tools/client-runtime/state/project-grouping";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { FinckeListHeader } from "../../fincke/FinckeListHeader";
import {
  buildProjectSidebarItems,
  finckeSidebarItemsAreEqual,
  isFinckeProjectListItem,
  type FinckeProjectListItem,
} from "../../fincke/project-sidebar";
import { FinckeProjectHeaderRow, FinckeProjectMoreRow } from "../../fincke/ProjectSidebarRows";
import { SidebarRowButton, SidebarViewToggle } from "../../fincke/SidebarViewToggle";
import { useSidebarView } from "../../fincke/use-sidebar-view";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { THREAD_SIDEBAR_ROW_LAYOUT } from "./threadListAnimations";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects, useNavigationThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { useThreadListNow } from "./use-thread-list-now";
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import {
  useLaunchingThreads,
  usePendingNewTasks,
  type PendingNewTask,
} from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useThreadListV2 } from "./useThreadListV2";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { requestThreadMessageJump } from "./threadMessageJump";
import { useThreadListSearchMatches } from "./useThreadListSearchMatches";
import { useHomeListOptions } from "../home/home-list-options";
import { buildHomeListFilterMenuItems } from "../home/home-list-filter-menu";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import { useFabScroll } from "../home/FabScrollContext";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { workspaceListFilterIcon } from "../layout/workspace/WorkspaceListHeader.types";
import { Menu } from "../../components/ui/Menu";
import {
  findAppBarMenuItem,
  menuActionsFromAppBarItems,
} from "../../components/ui/menuActionItems";
import { WorkspaceSidebarColumn } from "../layout/workspace/WorkspaceSidebarColumn";
import {
  ThreadListV2NeedsYouHeader,
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
  ThreadListV2WorkingShelfHeader,
} from "./thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "./thread-provider-instance";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import { ThreadPrDemandProvider } from "../../state/thread-pr-demand";
import {
  isThreadListV2ListItem,
  threadListV2ListItemsAreEqual,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";

type SidebarListItem =
  | ThreadListV2ListItem
  | FinckeProjectListItem
  | {
      readonly type: "v2-show-more";
      readonly key: string;
      readonly hiddenCount: number;
      readonly state?: "loading" | "failed";
    };

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onAddProject: () => void;
  readonly onStartNewTask: () => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onOpenPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  return (
    <ThreadPrDemandProvider visible={props.visible}>
      <WorkspaceSidebarColumn width={props.width}>
        <ThreadNavigationSidebarPane {...props} />
      </WorkspaceSidebarColumn>
    </ThreadPrDemandProvider>
  );
}

function ThreadNavigationSidebarPane(props: ThreadNavigationSidebarProps) {
  const { themeId, themeVariables: materialTheme } = useAppearancePreferences();
  const ocean = themeId === "fincke-ocean";
  const sidebarView = useSidebarView();

  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const threads = useNavigationThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useNativeGesture();
  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const launchingThreads = useLaunchingThreads(threads);
  const activeNewTask = useActiveNewTask();
  const queuedThreadKeys = useQueuedThreadKeys();
  const selectDetail = useSelectWorkspaceDetail();
  const { confirmDeletePendingTask } = usePendingTaskListActions((params) =>
    selectDetail({ name: "Thread", params }),
  );
  const environments = Object.values(savedConnectionsById)
    .map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const availableEnvironmentIds = new Set(
    environments.map((environment) => environment.environmentId),
  );
  const { options, setSelectedEnvironmentId, setSelectedProjectKey } =
    useHomeListOptions(availableEnvironmentIds);
  const searchEnvironmentIds =
    options.selectedEnvironmentId === null
      ? workspaceEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId)
      : workspaceEnvironments.some(
            (environment) =>
              environment.environmentId === options.selectedEnvironmentId &&
              environment.connectionState === "connected",
          )
        ? [options.selectedEnvironmentId]
        : [];
  // A legacy per-environment scratch key resolves here on every render; the stored
  // value is only rewritten when the user picks a filter.
  const resolvedProjectKey = resolveScratchProjectScopeKey(options.selectedProjectKey, projects, {
    sidebarProjectGroupingMode: options.projectGroupingMode,
    sidebarProjectGroupingOverrides: {},
  });
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: options.selectedEnvironmentId,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [projects, options.selectedEnvironmentId, options.projectGroupingMode],
  );
  const projectFilterOptions = pickableProjectGroups(projectScopes).map((scope) => ({
    key: scope.key,
    label: scope.title,
  }));
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
  );
  // An archived project's filter reads as all projects, matching the filter menu.
  const selectedProjectScope =
    pickableProjectGroups(projectScopes).find((scope) => scope.key === resolvedProjectKey) ?? null;
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    props.searchQuery,
    selectedProjectScope === null
      ? {}
      : { projectIds: selectedProjectScope.projectRefs.map((ref) => ref.projectId) },
  );
  // This map reaches LegendList's extraData, which re-renders every row whenever it changes
  // identity; the hook keeps it stable.
  const threadSearchMatchByKey = useThreadListSearchMatches(threads, threadSearch);
  const selectedProjectKey = selectedProjectScope?.key ?? null;
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentId ?? "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
  const [lastSettledResetKey, setLastSettledResetKey] = useState(settledResetKey);
  if (lastSettledResetKey !== settledResetKey) {
    setLastSettledResetKey(settledResetKey);
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = () =>
    setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT);
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } = useThreadListV2ShelfPreferences();
  const now = useThreadListNow(threads);
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    snoozePresetsByEnvironmentId,
    pinningEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    pinReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = listEnvironments;
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const pendingOrder = usePendingThreadOrder();
  const {
    layout: threadListV2Layout,
    layoutInput: threadListV2LayoutInput,
    items: threadListV2Items,
    pendingTasks: v2PendingTasks,
    contentOnlyThreadKeys,
    olderSettledShelf,
  } = useThreadListV2({
    threads: launchingThreads,
    pendingTasks,
    environmentId: options.selectedEnvironmentId,
    projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
    searchQuery: props.searchQuery,
    searchMatches: threadSearchMatchByKey,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinReorderEnvironmentIds,
    queuedThreadKeys,
    settledLimit: settledVisibleCount,
    now,
    pendingOrder,
    shelfPreferencesLoaded,
    workingShelfEnabled,
    workingShelfExpanded,
    snoozedShelfExpanded,
    settledShelfExpanded,
    selectedThreadKey: props.selectedThreadKey ?? null,
    timeOnStatusRows: true,
  });
  // fincke: the projects view groups the same rows under their projects, like desktop
  const listItems: readonly SidebarListItem[] = sidebarView.projectsView
    ? buildProjectSidebarItems({
        layoutInput: threadListV2LayoutInput,
        pendingTasks: v2PendingTasks,
        snoozeLabelNow: now,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        scopes: sortHomeProjectScopes({
          scopes: selectedProjectScope === null ? projectScopes : [selectedProjectScope],
          threads,
          pendingTasks,
          projectSortOrder: options.projectSortOrder,
        }),
        collapsedScopeKeys: sidebarView.collapsedProjectKeys,
        expandedScopeKeys: sidebarView.expandedProjectKeys,
        selectedThreadKey: props.selectedThreadKey ?? null,
        selectedPendingKey: activeNewTask?.pendingKey ?? null,
      })
    : settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0
      ? [
          ...threadListV2Items,
          {
            type: "v2-show-more",
            key: "v2-show-more",
            hiddenCount: threadListV2Layout.hiddenSettledCount,
            ...(olderSettledShelf.loading
              ? { state: "loading" as const }
              : olderSettledShelf.failed
                ? { state: "failed" as const }
                : {}),
          },
        ]
      : threadListV2Items;

  const handleSwipeableWillOpen = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  };
  const handleSwipeableClose = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  };
  // Destructure callback props; capturing all props would invalidate these row-closing handlers on unrelated changes.
  const { onSelectThread, onOpenThreadPullRequests } = props;
  // A row listed for a message match opens the thread at that message, by
  // tap or by shortcut.
  const handleSelectThread = (thread: EnvironmentThreadShell) => {
    const key = threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });
    const messageId = contentOnlyThreadKeys.has(key)
      ? threadSearchMatchByKey.get(key)?.messageId
      : undefined;
    if (messageId) {
      requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.id), messageId);
    }
    onSelectThread(thread);
    openSwipeableRef.current?.close();
  };
  const handleOpenThreadPullRequests = (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => {
    onOpenThreadPullRequests(thread, pr);
    openSwipeableRef.current?.close();
  };
  const handleScrollBeginDrag = () => {
    openSwipeableRef.current?.close();
  };
  const onFabScroll = useFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Recycle equality needs project/search data for titles and favicons; keep the minute clock on items to limit updates.
  const listExtraData = {
    activeNewTask,
    selectedThreadKey: props.selectedThreadKey ?? "",
    projectByKey,
    projectTitleByProjectKey,
    savedConnectionsById,
    listEnvironments,
    threadSearchMatchByKey,
    workingShelfEnabled,
    // recycled rows compare equal across the two views, so the view must re-render them
    projectsView: sidebarView.projectsView,
  };
  useThreadJumpShortcuts(
    listItems.filter((item) => !isFinckeProjectListItem(item)),
    handleSelectThread,
  );
  const sidebarItemsAreEqual = (previous: SidebarListItem, item: SidebarListItem): boolean => {
    if (isThreadListV2ListItem(previous) && isThreadListV2ListItem(item)) {
      return threadListV2ListItemsAreEqual(previous, item);
    }
    if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
      return previous.hiddenCount === item.hiddenCount && previous.state === item.state;
    }
    if (isFinckeProjectListItem(previous) && isFinckeProjectListItem(item)) {
      return finckeSidebarItemsAreEqual(previous, item);
    }
    return false;
  };
  const sidebarLayout = sidebarView.projectsView ? "project" : "activity";
  const renderListItem = ({ item }: { readonly item: SidebarListItem }) => {
    switch (item.type) {
      case "fincke-project":
        return (
          <FinckeProjectHeaderRow
            item={item}
            ocean={ocean}
            theme={materialTheme}
            onToggle={sidebarView.toggleProjectCollapsed}
            onNewThread={props.onNewThreadInProject}
          />
        );
      case "fincke-project-more":
        return <FinckeProjectMoreRow item={item} onToggle={sidebarView.toggleProjectExpanded} />;
      case "v2-pending": {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.environmentId,
          item.pendingTask.projectId,
        );
        return (
          <ThreadListV2PendingRow
            sidebarLayout={sidebarLayout}
            pendingTask={item.pendingTask}
            selected={
              activeNewTask?.pendingKey === item.pendingTask.key ||
              (item.pendingTask.kind === "pending" &&
                scopedThreadKey(
                  item.pendingTask.environmentId,
                  item.pendingTask.message.threadId,
                ) === props.selectedThreadKey)
            }
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={projectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
            pane="sidebar"
            showPendingDivider={item.showPendingDivider}
            onSelectPendingTask={props.onOpenPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
            fullSwipeWidth={props.width - 20}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-thread": {
        const thread = item.item.thread;
        const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
        return (
          <ThreadListV2Row
            sidebarLayout={sidebarLayout}
            onNewThreadOnBranch={props.onNewThreadOnBranch}
            thread={thread}
            variant={item.item.variant}
            hasQueuedMessages={item.hasQueuedMessages}
            snoozed={item.item.snoozed}
            pinned={item.item.pinned}
            wokeAt={item.item.wokeAt}
            snoozePresetMinute={item.snoozePresetMinute ?? ""}
            snoozeWakeLabelText={item.snoozeWakeLabelText}
            timeLabel={item.timeLabel}
            project={projectByKey.get(scopeKey) ?? null}
            projectTitle={projectTitleByProjectKey.get(scopeKey)}
            providerInstance={resolveProviderInstance(thread)}
            providers={providersByEnvironmentId.get(thread.environmentId)}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
            searchMatch={
              // Only rows listed for their messages show one and open at it.
              contentOnlyThreadKeys.has(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )
                ? threadSearchMatchByKey.get(
                    threadSearchMatchKey({
                      environmentId: thread.environmentId,
                      threadId: thread.id,
                    }),
                  )
                : undefined
            }
            searchQuery={threadSearch.query}
            pane="sidebar"
            showActiveHeading={item.showActiveHeading}
            selected={
              !activeNewTask &&
              scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
            }
            fullSwipeWidth={props.width - 20}
            onSelectThread={handleSelectThread}
            onOpenThreadPullRequests={handleOpenThreadPullRequests}
            onDeleteThread={confirmDeleteThread}
            onArchiveThread={archiveThread}
            onRenameThread={renameThread}
            onRegenerateThreadTitle={regenerateThreadTitle}
            titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
            settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
            onSettleThread={settleThread}
            snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
            snoozePresets={snoozePresetsByEnvironmentId.get(thread.environmentId)}
            pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
            autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
            reorderSupported={
              item.item.pinned ? pinReorderEnvironmentIds.has(thread.environmentId) : false
            }
            canMoveUp={item.canMoveUp}
            canMoveDown={item.canMoveDown}
            onSnoozeThread={snoozeThread}
            onUnsnoozeThread={unsnoozeThread}
            onUnsettleThread={unsettleThread}
            onPinThread={pinThread}
            onUnpinThread={unpinThread}
            onSetThreadAutoSettle={setThreadAutoSettle}
            onMoveThread={moveThread}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-needs-you":
        return <ThreadListV2NeedsYouHeader count={item.count} pane="sidebar" />;
      case "v2-working-shelf":
        return (
          <ThreadListV2WorkingShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleWorkingShelf}
            pane="sidebar"
          />
        );
      case "v2-snoozed-shelf":
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
            pane="sidebar"
          />
        );
      case "v2-settled-shelf":
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
            pane="sidebar"
          />
        );
      case "v2-show-more":
        return (
          <ThreadListV2ShowMoreRow
            pane="sidebar"
            hiddenCount={item.hiddenCount}
            {...(item.state === undefined ? {} : { state: item.state })}
            onPress={() => {
              olderSettledShelf.retry();
              showMoreSettled();
            }}
          />
        );
    }
  };
  const filterCustomized = options.selectedEnvironmentId !== null || selectedProjectKey !== null;
  // fincke: the thread filter lives in the sidebar's button row under the search bar, like web
  const filterItems = buildHomeListFilterMenuItems({
    environments,
    projects: projectFilterOptions,
    selectedEnvironmentId: options.selectedEnvironmentId,
    selectedProjectKey,
    onEnvironmentChange: setSelectedEnvironmentId,
    onProjectChange: setSelectedProjectKey,
  });
  const header = (
    <WorkspaceListHeader
      accessibilityLabel="456code, Threads"
      onOpenEnvironments={props.onOpenEnvironmentSettings}
      onOpenSettings={props.onOpenSettings}
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search",
        accessibilityLabel: "Search threads",
      }}
      sidebar={{
        width: props.width,
        visible: props.visible,
        onRequestVisibility: props.onRequestVisibility,
      }}
    />
  );
  const listEmpty = (
    <Text
      className={
        Platform.OS === "android"
          ? "px-4 py-4 text-center text-sm text-drawer-foreground-muted"
          : "px-2 py-4 text-sm text-drawer-foreground-muted"
      }
    >
      {catalogState.isLoadingConnections
        ? "Loading threads…"
        : Platform.OS === "android" && !catalogState.hasConnections
          ? "No environments connected"
          : props.searchQuery.trim().length > 0
            ? threadSearch.isPending
              ? "Searching thread messages…"
              : "No matching threads"
            : selectedProjectScope !== null
              ? `No threads in ${selectedProjectScope.title}`
              : "No threads yet"}
    </Text>
  );

  const listHeader = (
    <FinckeListHeader
      bleedLeft={Platform.OS === "android" ? 0 : styles.threadListContent.paddingHorizontal}
      bleedRight={Platform.OS === "android" ? 0 : styles.threadListContent.paddingHorizontal}
      showBrand
    >
      {/* web's search-row buttons: filter, view, add project, new thread */}
      <View className="flex-row items-center justify-end gap-0.5 px-1 pb-1 pt-1.5">
        <Menu
          actions={menuActionsFromAppBarItems(filterItems)}
          onPressAction={({ nativeEvent }) =>
            findAppBarMenuItem(filterItems, nativeEvent.event)?.onPress()
          }
        >
          <SidebarRowButton
            icon={workspaceListFilterIcon(filterCustomized)}
            label="Filter threads"
          />
        </Menu>
        <SidebarViewToggle
          projectsView={sidebarView.projectsView}
          onChange={sidebarView.setProjectsView}
          ocean={ocean}
          theme={materialTheme}
        />
        <SidebarRowButton
          icon="folder.badge.plus"
          label="Add project"
          onPress={props.onAddProject}
        />
        <SidebarRowButton
          icon="square.and.pencil"
          label="New thread"
          onPress={props.onStartNewTask}
        />
      </View>
    </FinckeListHeader>
  );

  return (
    <>
      {header}
      <View className="flex-1">
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={sidebarScrollGesture}>
            <AnimatedLegendList
              renderScrollComponent={NativeScrollView}
              itemLayoutAnimation={THREAD_SIDEBAR_ROW_LAYOUT}
              data={listItems}
              drawDistance={500}
              estimatedItemSize={64}
              extraData={listExtraData}
              getItemType={(item) => item.type}
              itemsAreEqual={sidebarItemsAreEqual}
              keyExtractor={(item) => item.key}
              renderItem={renderListItem}
              automaticallyAdjustsScrollIndicatorInsets
              contentInsetAdjustmentBehavior="automatic"
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
              ListEmptyComponent={listEmpty}
              ListHeaderComponent={listHeader}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
        <ThreadUndoNotice visible={props.visible} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
