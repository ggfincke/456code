// apps/mobile/src/fincke/project-sidebar.ts
// groups the sidebar's thread rows under their projects, like desktop's projects view

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";

import type { HomeProjectScope } from "../features/home/homeThreadList";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  resolveThreadListV2Status,
  threadHasUnseenCompletion,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
  type ThreadListV2PendingListItem,
  type ThreadListV2ThreadListItem,
} from "../features/threads/threadListV2";
import { scopedProjectKey } from "../lib/scopedEntities";
import type { PendingNewTask } from "../state/use-pending-new-tasks";
import {
  mostUrgentSidebarStatus,
  resolveSidebarStatus,
  type SidebarStatus,
} from "./SidebarStatusGlyph";

// desktop's default sidebarThreadPreviewCount
const PROJECT_THREAD_PREVIEW_COUNT = 6;

export interface FinckeProjectHeaderItem {
  readonly type: "fincke-project";
  readonly key: string;
  readonly scopeKey: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  readonly collapsed: boolean;
  // shown on a collapsed project in place of its hidden threads
  readonly status: SidebarStatus | null;
}

export interface FinckeProjectMoreItem {
  readonly type: "fincke-project-more";
  readonly key: string;
  readonly scopeKey: string;
  readonly hiddenCount: number;
  readonly expanded: boolean;
}

type ProjectChildItem = ThreadListV2ThreadListItem | ThreadListV2PendingListItem;
export type FinckeProjectListItem = FinckeProjectHeaderItem | FinckeProjectMoreItem;
export type FinckeSidebarListItem = ThreadListV2ListItem | FinckeProjectListItem;

export function isFinckeProjectListItem(item: {
  readonly type: string;
}): item is FinckeProjectListItem {
  return item.type === "fincke-project" || item.type === "fincke-project-more";
}

export function finckeSidebarItemsAreEqual(
  previous: FinckeSidebarListItem,
  item: FinckeSidebarListItem,
): boolean {
  if (item.type === "fincke-project") {
    return (
      previous.type === "fincke-project" &&
      previous.key === item.key &&
      previous.title === item.title &&
      previous.project === item.project &&
      previous.collapsed === item.collapsed &&
      previous.status?.tone === item.status?.tone
    );
  }
  if (item.type === "fincke-project-more") {
    return (
      previous.type === "fincke-project-more" &&
      previous.key === item.key &&
      previous.hiddenCount === item.hiddenCount &&
      previous.expanded === item.expanded
    );
  }
  return !isFinckeProjectListItem(previous) && threadListV2ListItemsAreEqual(previous, item);
}

export function buildProjectSidebarItems(input: {
  // the activity view's own inputs; shelves & paging are flattened here
  readonly layoutInput: Parameters<typeof buildThreadListV2Items>[0];
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly snoozeLabelNow: string;
  readonly snoozeEnvironmentIds: Parameters<
    typeof buildThreadListV2ListItems
  >[0]["snoozeEnvironmentIds"];
  readonly queuedThreadKeys: ReadonlySet<string>;
  // already filtered & sorted for the sidebar
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly collapsedScopeKeys: ReadonlySet<string>;
  readonly expandedScopeKeys: ReadonlySet<string>;
  readonly selectedThreadKey: string | null;
  readonly selectedPendingKey: string | null;
}): FinckeSidebarListItem[] {
  const layout = buildThreadListV2Items({
    ...input.layoutInput,
    workingShelfEnabled: false,
    snoozedShelfExpanded: true,
    settledShelfExpanded: true,
    settledLimit: Number.POSITIVE_INFINITY,
  });
  const listItems = buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks: input.pendingTasks,
    snoozeLabelNow: input.snoozeLabelNow,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    timeOnStatusRows: true,
  });

  const scopeKeyByProjectKey = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (ref) => [scopedProjectKey(ref.environmentId, ref.projectId), scope.key] as const,
      ),
    ),
  );
  const childrenByScope = new Map<string, ProjectChildItem[]>();
  for (const item of listItems) {
    if (item.type !== "v2-thread" && item.type !== "v2-pending") continue;
    const ref = item.type === "v2-thread" ? item.item.thread : item.pendingTask;
    const scopeKey = scopeKeyByProjectKey.get(scopedProjectKey(ref.environmentId, ref.projectId));
    if (scopeKey === undefined) continue;
    // drafts sit inside their project, so the activity view's "Unsent" divider does not apply
    const child = item.type === "v2-pending" ? { ...item, showPendingDivider: false } : item;
    const children = childrenByScope.get(scopeKey);
    if (children) children.push(child);
    else childrenByScope.set(scopeKey, [child]);
  }

  const searching = input.layoutInput.searchQuery.trim().length > 0;
  const result: FinckeSidebarListItem[] = [];
  for (const scope of input.scopes) {
    const children = sortProjectChildren(childrenByScope.get(scope.key) ?? []);
    // empty projects stay listed (so they can start a thread) unless a search hides them
    if (searching && children.length === 0) continue;
    const collapsed = input.collapsedScopeKeys.has(scope.key);
    const isSelected = (child: ProjectChildItem) =>
      child.type === "v2-thread"
        ? `${child.item.thread.environmentId}:${child.item.thread.id}` === input.selectedThreadKey
        : child.pendingTask.key === input.selectedPendingKey;
    result.push({
      type: "fincke-project",
      key: `fincke-project:${scope.key}`,
      scopeKey: scope.key,
      title: scope.title,
      project: scope.representative,
      collapsed,
      status: collapsed
        ? mostUrgentSidebarStatus(
            children.map((child) =>
              child.type === "v2-thread"
                ? resolveSidebarStatus(
                    resolveThreadListV2Status(child.item.thread),
                    threadHasUnseenCompletion(child.item.thread),
                  )
                : null,
            ),
          )
        : null,
    });
    // a collapsed project keeps only the open thread, as on desktop
    if (collapsed) {
      result.push(...children.filter(isSelected));
      continue;
    }
    const expanded = input.expandedScopeKeys.has(scope.key) || searching;
    if (expanded || children.length <= PROJECT_THREAD_PREVIEW_COUNT) {
      result.push(...children);
      if (expanded && !searching && children.length > PROJECT_THREAD_PREVIEW_COUNT) {
        result.push(moreItem(scope.key, 0, true));
      }
      continue;
    }
    const preview = children.slice(0, PROJECT_THREAD_PREVIEW_COUNT);
    // the open thread stays listed past the preview cut
    const selectedBeyond = children.slice(PROJECT_THREAD_PREVIEW_COUNT).filter(isSelected);
    result.push(...preview, ...selectedBeyond);
    const hiddenCount = children.length - preview.length - selectedBeyond.length;
    if (hiddenCount > 0) result.push(moreItem(scope.key, hiddenCount, false));
  }
  return result;
}

function moreItem(scopeKey: string, hiddenCount: number, expanded: boolean): FinckeProjectMoreItem {
  return {
    type: "fincke-project-more",
    key: `fincke-project-more:${scopeKey}`,
    scopeKey,
    hiddenCount,
    expanded,
  };
}

// drafts first, then threads by latest activity (desktop's updated_at order)
function sortProjectChildren(children: ProjectChildItem[]): ProjectChildItem[] {
  const timestamp = (child: ProjectChildItem) =>
    child.type === "v2-thread"
      ? getThreadSortTimestamp(child.item.thread, "updated_at")
      : Number.POSITIVE_INFINITY;
  return children
    .map((child) => ({ child, at: timestamp(child) }))
    .sort((left, right) => (right.at === left.at ? 0 : right.at > left.at ? 1 : -1))
    .map(({ child }) => child);
}
