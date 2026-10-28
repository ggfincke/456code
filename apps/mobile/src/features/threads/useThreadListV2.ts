import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState, useSyncExternalStore } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  threadListInboxReturns,
  type ThreadListV2NeedsYouTier,
} from "./threadListV2";
import { computeThreadMoveAvailability } from "./threadOrder";

/**
 * Screens' select handlers read the content-only key set; a fresh one per list rebuild gave
 * every row a new handler whenever any thread shell changed. Keyed by a string, the set keeps
 * its identity until its keys change.
 */
function useKeySet(newlineSeparatedKeys: string): ReadonlySet<string> {
  return useMemo(
    () => new Set(newlineSeparatedKeys.length === 0 ? [] : newlineSeparatedKeys.split("\n")),
    [newlineSeparatedKeys],
  );
}

type LayoutInput = Parameters<typeof buildThreadListV2Items>[0];

/**
 * Home's and the thread sidebar's thread list. Its result is one value a screen only reads:
 * built inline, the list's inputs stayed open to mutation across the screen's other hooks, so
 * the React Compiler cached none of it and every render of the screen re-rendered every row.
 */
export function useThreadListV2(input: {
  readonly threads: LayoutInput["threads"];
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly searchQuery: string;
  /** Threads that match the search by content, keyed like `threadSearchMatchKey`. */
  readonly searchMatches: ReadonlyMap<string, unknown>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly settledLimit: number;
  readonly now: string;
  readonly pendingOrder: LayoutInput["pendingOrder"];
  readonly shelfPreferencesLoaded: boolean;
  readonly workingShelfEnabled: boolean;
  readonly workingShelfExpanded: boolean;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  readonly selectedThreadKey: string | null;
  // fincke: compact sidebar rows show the time beside a status glyph instead of a label
  readonly timeOnStatusRows?: boolean;
}) {
  const { threads, workingShelfEnabled } = input;
  // Opening a thread marks it read; it keeps the Needs you tier it opened with until deselected.
  const [needsYouHold, setNeedsYouHold] = useState<{
    readonly threadKey: string | null;
    readonly tier: ThreadListV2NeedsYouTier | null;
  } | null>(null);
  // A thread can stop working when the threads change, or when its exit grace expires.
  const inboxVersion = useSyncExternalStore(
    threadListInboxReturns.subscribe,
    threadListInboxReturns.getSnapshot,
  );
  const inbox = useMemo(
    () => threadListInboxReturns.observe(workingShelfEnabled ? threads : null),
    // oxlint-disable-next-line react/memo-dependencies -- the version signals an expired grace
    [threads, workingShelfEnabled, inboxVersion],
  );
  // Up/down menu availability for every card, computed once per rebuild (see
  // computeThreadMoveAvailability). fincke: active threads sort by last activity, so only
  // pinned threads keep a manual order to move through.
  const moveAvailability = new Map(
    computeThreadMoveAvailability({
      allThreads: threads,
      section: "pinned",
      pendingOrder: input.pendingOrder,
      reorderableEnvironmentIds: input.pinReorderEnvironmentIds,
      ordered: getThreadListV2OrderedSection({
        threads,
        section: "pinned",
        pendingOrder: input.pendingOrder,
        now: input.now,
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
      }),
    }),
  );
  // Older settled threads load in pages; the shelf lists them only as far as they are loaded.
  const scopes = olderSettledScopes(input);
  const olderSettledShelf = useOlderSettledShelf({
    scopes,
    expanded: input.settledShelfExpanded,
    // A search lists only matches, so the shelf would page forever; loaded pages stay.
    visibleCount: input.searchQuery.trim().length === 0 ? input.settledLimit : 0,
  });
  const layoutInput: LayoutInput = {
    pendingOrder: input.pendingOrder,
    threads: threads.filter((thread) => thread.archivedAt === null),
    environmentId: input.environmentId,
    projectRefs: input.projectRefs,
    searchQuery: input.searchQuery,
    matchedThreadKeys: new Set(input.searchMatches.keys()),
    settlementEnvironmentIds: input.settlementEnvironmentIds,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    settledLimit: input.settledLimit,
    now: input.now,
    workingShelfEnabled,
    workingShelfExpanded: input.workingShelfExpanded,
    inboxReturnAt: inbox.returnedAt,
    isWorking: inbox.isWorking,
    snoozedShelfExpanded: input.snoozedShelfExpanded,
    settledShelfExpanded: input.settledShelfExpanded,
    selectedThreadKey: input.selectedThreadKey,
    selectedNeedsYouHold:
      needsYouHold?.threadKey === input.selectedThreadKey ? needsYouHold.tier : null,
    isListedSettled: olderSettledShelf.isListed,
    unloadedSettledCount: olderSettledShelf.unloadedCount(
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          scopes.some(
            (scope) =>
              scope.environmentId === thread.environmentId &&
              (scope.projectIds === null || scope.projectIds.includes(thread.projectId)),
          ),
      ),
    ),
  };
  const layout = buildThreadListV2Items(layoutInput);
  // a search lists matches only, so it neither takes nor drops the hold
  if (
    input.searchQuery.trim().length === 0 &&
    (needsYouHold === null ||
      needsYouHold.threadKey !== input.selectedThreadKey ||
      (needsYouHold.tier !== null && needsYouHold.tier !== layout.selectedNeedsYouTier))
  ) {
    setNeedsYouHold({ threadKey: input.selectedThreadKey, tier: layout.selectedNeedsYouTier });
  }
  useOlderSettledShelfGrowth(olderSettledShelf, layout.listedSettledThreads);
  const contentOnlyThreadKeys = useKeySet([...layout.contentOnlyThreadKeys].sort().join("\n"));
  const scopedProjectKeys =
    input.projectRefs == null
      ? null
      : new Set(input.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)));
  const searchQuery = input.searchQuery.trim().toLocaleLowerCase();
  const pendingTasks = input.pendingTasks.filter(
    (pendingTask) =>
      (input.environmentId === null || pendingTask.environmentId === input.environmentId) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(
          scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
        )) &&
      (searchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(searchQuery)),
  );
  const items = buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks,
    needsYouCount: layout.needsYouCount,
    needsYouHeaderIndex: layout.needsYouHeaderIndex,
    workingCount: layout.workingCount,
    workingShelfExpanded: input.workingShelfExpanded,
    workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
    workingShelfEndIndex: layout.workingShelfEndIndex,
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded: input.snoozedShelfExpanded,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfExpanded: input.settledShelfExpanded,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    snoozeLabelNow: `${input.now.slice(0, 16)}:00.000Z`,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    moveAvailability,
    shelfPreferencesLoading: !input.shelfPreferencesLoaded,
    timeOnStatusRows: input.timeOnStatusRows === true,
  });
  // fincke: layoutInput & pendingTasks feed the sidebar's projects view (project-sidebar.ts)
  return { layout, layoutInput, items, pendingTasks, contentOnlyThreadKeys, olderSettledShelf };
}

/** The list's scope per environment: its projects there, or every project. */
function olderSettledScopes(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<OlderSettledScope> {
  const environmentIds =
    input.environmentId === null ? [...input.settlementEnvironmentIds] : [input.environmentId];
  return environmentIds.flatMap((environmentId): ReadonlyArray<OlderSettledScope> => {
    if (input.projectRefs == null) return [{ environmentId, projectIds: null }];
    const projectIds = input.projectRefs.flatMap((ref) =>
      ref.environmentId === environmentId ? [ref.projectId] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}
