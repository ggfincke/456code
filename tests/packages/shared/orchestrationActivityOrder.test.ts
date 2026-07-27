// tests/packages/shared/orchestrationActivityOrder.test.ts
// verifies canonical imported and live orchestration activity ordering

import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { compareOrchestrationThreadActivities } from "@t3tools/shared/orchestrationActivityOrder";
import { describe, expect, it } from "vite-plus/test";

function makeActivity(
  id: string,
  kind: string,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: id,
    payload: {},
    turnId: TurnId.make("turn-native"),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("compareOrchestrationThreadActivities", () => {
  it("keeps lifecycle ties in start, progress, completion order", () => {
    const activities = [
      makeActivity("completed", "tool.completed", { sequence: 1 }),
      makeActivity("progress", "tool.updated", { sequence: 1 }),
      makeActivity("started", "tool.started", { sequence: 1 }),
    ];

    expect(activities.toSorted(compareOrchestrationThreadActivities).map(({ id }) => id)).toEqual([
      "started",
      "progress",
      "completed",
    ]);
  });
});
