// apps/web/src/state/workers.ts
// web-side binding for the worker-broker environment atoms

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createWorkersEnvironmentAtoms } from "@t3tools/client-runtime/state/workers";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  selectActiveRightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { resolveThreadRouteTarget } from "../threadRoutes";

export const workersEnvironment = createWorkersEnvironmentAtoms(connectionAtomRuntime);
export const workersActivityEnvironment = workersEnvironment.activity;

export function selectWorkersRunDeepLink(
  byThreadKey: Readonly<Record<string, ThreadRightPanelState>>,
  threadRef: ScopedThreadRef | null,
): string | null {
  if (threadRef === null) return null;
  const surface = selectActiveRightPanelSurface(byThreadKey, threadRef);
  if (surface?.kind !== "workers") return null;
  const run = surface.run;
  return typeof run === "string" && run.length > 0 ? run : null;
}

export interface WorkersRunDeepLink {
  readonly threadKey: string | null;
  readonly runId: string | null;
}

export function useWorkersRunDeepLink(environmentId: EnvironmentId): WorkersRunDeepLink {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftThread = useComposerDraftStore((state) =>
    routeTarget?.kind === "draft" ? state.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef =
    routeTarget?.kind === "server"
      ? routeTarget.threadRef
      : draftThread === null
        ? null
        : scopeThreadRef(draftThread.environmentId, draftThread.threadId);
  const threadRef = routeThreadRef?.environmentId === environmentId ? routeThreadRef : null;
  const runId = useRightPanelStore((state) =>
    selectWorkersRunDeepLink(state.byThreadKey, threadRef),
  );
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  return useMemo(() => ({ threadKey, runId }), [runId, threadKey]);
}
