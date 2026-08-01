// tests/apps/server/workers/WorkerBrokerStore.test.ts
// verifies bounded and backward-compatible worker activity reads

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkerBrokerStore from "../../../../apps/server/src/workers/WorkerBrokerStore.ts";

function activityLayer(stateDir: string) {
  return WorkerBrokerStore.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { WORKER_BROKER_HOME: stateDir })),
  );
}

// fixtures are arbitrary broker records, so they encode through the unknown
// JSON codec rather than JSON.stringify
const encodeActivityLine = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// the temp state dir is scoped, so each case is cleaned up on release instead
// of through a try/finally around the assertions
const withActivityStore = <A, E>(
  run: (
    write: (lines: ReadonlyArray<string>) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, WorkerBrokerStore.WorkerBrokerStore>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "workers-activity-" });
    const jobDir = path.join(stateDir, "jobs", "job-1");

    const write = (lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(jobDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(jobDir, "activity.jsonl"), lines.join("\n"));
      }).pipe(Effect.orDie);

    return yield* run(write).pipe(Effect.provide(activityLayer(stateDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("WorkerBrokerStore activity", () => {
  it.effect("returns empty history when old jobs have no activity artifact", () =>
    withActivityStore(() =>
      Effect.gen(function* () {
        const store = yield* WorkerBrokerStore.WorkerBrokerStore;
        const snapshot = yield* store.readActivity({ jobId: "job-1" });
        assert.deepStrictEqual(snapshot.entries, []);
        assert.strictEqual(snapshot.skippedEntryCount, 0);
        assert.strictEqual(snapshot.truncated, false);
      }),
    ),
  );

  it.effect("normalizes safe records while reporting malformed and unsupported lines", () =>
    withActivityStore((write) =>
      Effect.gen(function* () {
        yield* write([
          encodeActivityLine({
            schema_version: 1,
            sequence: 1,
            recorded_at: "2026-07-31T12:00:00Z",
            kind: "phase",
            phase: "working",
            status: "started",
          }),
          "not json",
          encodeActivityLine({
            schema_version: 2,
            sequence: 2,
            recorded_at: "2026-07-31T12:00:01Z",
            kind: "message",
            summary: "hidden",
          }),
          encodeActivityLine({
            schema_version: 1,
            sequence: 3,
            recorded_at: "2026-07-31T12:00:02Z",
            kind: "message",
            summary: "  safe\u0000summary  ",
          }),
          encodeActivityLine({
            schema_version: 1,
            sequence: 4,
            recorded_at: "2026-07-31T12:00:03Z",
            kind: "action",
            status: "completed",
            command: "secret",
          }),
        ]);

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
      }),
    ),
  );

  it.effect("bounds large activity artifacts and normalized entry history", () =>
    withActivityStore((write) =>
      Effect.gen(function* () {
        yield* write(
          Array.from({ length: 400 }, (_, index) =>
            encodeActivityLine({
              schema_version: 1,
              sequence: index + 1,
              recorded_at: "2026-07-31T12:00:00Z",
              kind: "message",
              summary: "x".repeat(1000),
            }),
          ),
        );

        const store = yield* WorkerBrokerStore.WorkerBrokerStore;
        const snapshot = yield* store.readActivity({ jobId: "job-1" });
        assert.strictEqual(snapshot.entries.length, 200);
        assert.strictEqual(snapshot.truncated, true);
        assert.strictEqual(snapshot.entries[0]?.kind, "message");
      }),
    ),
  );
});
