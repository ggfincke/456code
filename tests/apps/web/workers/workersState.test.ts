// tests/apps/web/workers/workersState.test.ts
// verifies worker run deep-links stay scoped to their owning thread

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRightPanelState } from "../../../../apps/web/src/rightPanelStore";
import { selectWorkersRunDeepLink } from "../../../../apps/web/src/state/workers";

const environmentId = "env-1" as EnvironmentId;
const ownerRef = scopeThreadRef(environmentId, ThreadId.make("thread-owner"));
const otherRef = scopeThreadRef(environmentId, ThreadId.make("thread-other"));

function workersPanelState(run?: string): ThreadRightPanelState {
  return {
    isOpen: true,
    activeSurfaceId: "workers",
    surfaces: [{ id: "workers", kind: "workers", ...(run === undefined ? {} : { run }) }],
  };
}

describe("selectWorkersRunDeepLink", () => {
  it("selects the run pinned by the owning thread regardless of insertion order", () => {
    const byThreadKey = {
      [scopedThreadKey(otherRef)]: workersPanelState("run-from-other-thread"),
      [scopedThreadKey(ownerRef)]: workersPanelState("run-from-owner"),
    };

    expect(selectWorkersRunDeepLink(byThreadKey, ownerRef)).toBe("run-from-owner");
  });

  it("returns null when the owning thread has no pinned run", () => {
    const byThreadKey = {
      [scopedThreadKey(otherRef)]: workersPanelState("run-from-other-thread"),
      [scopedThreadKey(ownerRef)]: workersPanelState(),
    };

    expect(selectWorkersRunDeepLink(byThreadKey, ownerRef)).toBeNull();
  });
});
