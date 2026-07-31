// tests/apps/server/workers/WorkerBrokerStore.test.ts
// verifies bounded and backward-compatible worker activity reads

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as WorkerBrokerStore from "../../../../apps/server/src/workers/WorkerBrokerStore.ts";

function activityLayer(stateDir: string) {
  return WorkerBrokerStore.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { WORKER_BROKER_HOME: stateDir })),
  );
}

describe("WorkerBrokerStore activity", () => {
  it.effect("returns empty history when old jobs have no activity artifact", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workers-activity-"));
    return Effect.gen(function* () {
      try {
        const store = yield* WorkerBrokerStore.WorkerBrokerStore;
        const snapshot = yield* store.readActivity({ jobId: "job-1" });
        assert.deepStrictEqual(snapshot.entries, []);
        assert.strictEqual(snapshot.skippedEntryCount, 0);
        assert.strictEqual(snapshot.truncated, false);
      } finally {
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(activityLayer(stateDir)));
  });

  it.effect("normalizes safe records while reporting malformed and unsupported lines", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workers-activity-"));
    return Effect.gen(function* () {
      const jobDir = NodePath.join(stateDir, "jobs", "job-1");
      NodeFS.mkdirSync(jobDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(jobDir, "activity.jsonl"),
        [
          JSON.stringify({
            schema_version: 1,
            sequence: 1,
            recorded_at: "2026-07-31T12:00:00Z",
            kind: "phase",
            phase: "working",
            status: "started",
          }),
          "not json",
          JSON.stringify({
            schema_version: 2,
            sequence: 2,
            recorded_at: "2026-07-31T12:00:01Z",
            kind: "message",
            summary: "hidden",
          }),
          JSON.stringify({
            schema_version: 1,
            sequence: 3,
            recorded_at: "2026-07-31T12:00:02Z",
            kind: "message",
            summary: "  safe\u0000summary  ",
          }),
          JSON.stringify({
            schema_version: 1,
            sequence: 4,
            recorded_at: "2026-07-31T12:00:03Z",
            kind: "action",
            status: "completed",
            command: "secret",
          }),
        ].join("\n"),
      );
      try {
        const store = yield* WorkerBrokerStore.WorkerBrokerStore;
        const snapshot = yield* store.readActivity({ jobId: "job-1" });
        assert.strictEqual(snapshot.entries.length, 3);
        assert.strictEqual(snapshot.skippedEntryCount, 2);
        assert.deepStrictEqual(snapshot.entries[1], {
          sequence: 3,
          recordedAt: "2026-07-31T12:00:02Z",
          kind: "message",
          summary: "safe summary",
        });
        assert.deepStrictEqual(snapshot.entries[2], {
          sequence: 4,
          recordedAt: "2026-07-31T12:00:03Z",
          kind: "action",
          status: "completed",
        });
      } finally {
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(activityLayer(stateDir)));
  });

  it.effect("bounds large activity artifacts and normalized entry history", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workers-activity-"));
    const jobDir = NodePath.join(stateDir, "jobs", "job-1");
    NodeFS.mkdirSync(jobDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(jobDir, "activity.jsonl"),
      Array.from({ length: 400 }, (_, index) =>
        JSON.stringify({
          schema_version: 1,
          sequence: index + 1,
          recorded_at: "2026-07-31T12:00:00Z",
          kind: "message",
          summary: "x".repeat(1000),
        }),
      ).join("\n"),
    );
    return Effect.gen(function* () {
      try {
        const store = yield* WorkerBrokerStore.WorkerBrokerStore;
        const snapshot = yield* store.readActivity({ jobId: "job-1" });
        assert.strictEqual(snapshot.entries.length, 200);
        assert.strictEqual(snapshot.truncated, true);
        assert.strictEqual(snapshot.entries[0]?.kind, "message");
      } finally {
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(activityLayer(stateDir)));
  });
});
