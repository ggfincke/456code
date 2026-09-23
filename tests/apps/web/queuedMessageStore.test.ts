// tests/apps/web/queuedMessageStore.test.ts
// keeps coral queues behind completed turns without changing other providers

import { ProviderDriverKind } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";
import {
  isQueuedMessageDue,
  useQueuedMessageStore,
} from "../../../apps/web/src/queuedMessageStore";

beforeEach(() => useQueuedMessageStore.setState({ queuesByThreadKey: {}, drainGeneration: 0 }));

it("holds Coral through tool boundaries and disconnects, then hands off once when ready", () => {
  const store = useQueuedMessageStore.getState();
  const message = store.enqueue("coral-thread", {
    prompt: "next turn",
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    queuedAfterToolActivityId: "tool-1",
    createdAt: "2026-09-23T00:00:00Z",
  });
  for (const phase of ["running", "connecting", "disconnected"] as const) {
    expect(
      isQueuedMessageDue({
        message,
        phase,
        latestToolActivityId: "tool-2",
        provider: ProviderDriverKind.make("coral"),
      }),
    ).toBe(false);
  }
  expect(useQueuedMessageStore.getState().queuesByThreadKey["coral-thread"]).toEqual([message]);
  expect(
    isQueuedMessageDue({
      message,
      phase: "ready",
      latestToolActivityId: "tool-2",
      provider: ProviderDriverKind.make("coral"),
    }),
  ).toBe(true);
  expect(store.take("coral-thread", message.id, "tool-2")).toEqual(message);
  expect(store.take("coral-thread", message.id, "tool-2")).toBeNull();
});

it("retains supported mid-turn sends and explicit holds", () => {
  const message = { queuedAfterToolActivityId: "tool-1" };
  expect(
    isQueuedMessageDue({
      message,
      phase: "running",
      latestToolActivityId: "tool-2",
      provider: ProviderDriverKind.make("codex"),
    }),
  ).toBe(true);
  expect(
    isQueuedMessageDue({
      message: { ...message, holdUntilUserAction: true },
      phase: "ready",
      latestToolActivityId: "tool-2",
      provider: ProviderDriverKind.make("coral"),
    }),
  ).toBe(false);
});
