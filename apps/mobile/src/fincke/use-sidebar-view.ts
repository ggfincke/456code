// apps/mobile/src/fincke/use-sidebar-view.ts
// projects/activity sidebar view, collapsed projects & per-project "show more" state

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";

export function useSidebarView() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  // projects is the default, matching desktop's sidebar
  const projectsView = !loaded || preferencesResult.value.sidebarProjectsView !== false;
  const collapsedProjectKeys = new Set(
    loaded ? (preferencesResult.value.collapsedProjectGroups ?? []) : [],
  );
  // "show more" is session-only, like desktop's
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const setProjectsView = (value: boolean) => {
    if (!loaded) return;
    savePreferences({ sidebarProjectsView: value });
  };
  // transforms read the optimistic value so two quick taps still toggle twice
  const toggleProjectCollapsed = (scopeKey: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = new Set(current.collapsedProjectGroups ?? []);
        if (!collapsed.delete(scopeKey)) collapsed.add(scopeKey);
        return { collapsedProjectGroups: [...collapsed] };
      },
    });
  };
  const toggleProjectExpanded = (scopeKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      if (!next.delete(scopeKey)) next.add(scopeKey);
      return next;
    });
  };

  return {
    projectsView,
    setProjectsView,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    expandedProjectKeys,
    toggleProjectExpanded,
  } as const;
}
