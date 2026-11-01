// @effect-diagnostics nodeBuiltinImport:off - Injects a real file replacement during the native SQLite transaction.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "./processRunner.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerRuntimeState from "./serverRuntimeState.ts";

describe("server ownership", () => {
  const layerOwnership = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
  const makeState = ServerRuntimeState.makePersistedServerRuntimeState({
    config: { host: undefined, devUrl: undefined },
    port: 3773,
  });

  it.effect("lets only one of two racing starts own a state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-race-" });
      const statePath = path.join(root, "server-runtime.json");
      const attempts = yield* Effect.all(
        [
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter((result) => result._tag === "Success").length, 1);
      const refused = attempts.find((result) => result._tag === "Failure");
      assert.equal(refused?.failure._tag, "ServerAlreadyRunningError");
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("refuses a second owner without touching its record, then allows a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          const before = yield* fs.readFileString(statePath);
          const refused = yield* ServerOwnership.acquireServerOwnership(statePath).pipe(
            Effect.flip,
          );
          assert.equal(refused._tag, "ServerAlreadyRunningError");
          assert.include(refused.message, "do not delete it while a server is running");
          assert.equal(yield* fs.readFileString(statePath), before);
        }),
      );
      assert.isFalse(yield* fs.exists(statePath));
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("lock file checks", () => {
    it.effect.each([
      "unchanged",
      "unlink",
      "replace",
      "during acquisition",
      "first acquisition",
      // Root bypasses directory permissions, so chmod cannot force EACCES.
      ...(process.getuid?.() === 0 ? [] : (["stat error"] as const)),
    ] as const)("monitors ownership after %s", (operation) => {
      const messages: unknown[] = [];
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message, logLevel }) =>
        (logLevel === "Warn" ? warnings : messages).push(message),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-lost-" });
        const statePath = path.join(root, "server-runtime.json");
        const lockPath = path.join(root, "server-owner.sqlite");
        const replacement = path.join(root, "replacement.sqlite");
        if (operation === "during acquisition" || operation === "first acquisition") {
          if (operation === "during acquisition") yield* fs.writeFileString(lockPath, "");
          yield* fs.writeFileString(replacement, "");
          const exec = NodeSqlite.DatabaseSync.prototype.exec;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(NodeSqlite.DatabaseSync.prototype, "exec").mockImplementationOnce(function (
                this: NodeSqlite.DatabaseSync,
                sql: string,
              ) {
                exec.call(this, sql);
                NodeFS.renameSync(replacement, lockPath);
              }),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
        }
        yield* ServerOwnership.acquireServerOwnership(statePath);
        if (operation === "unlink") {
          yield* fs.remove(lockPath);
        } else if (operation === "replace") {
          yield* fs.writeFileString(replacement, "");
          yield* fs.rename(replacement, lockPath);
        }
        if (operation === "stat error") {
          yield* fs.chmod(root, 0);
          yield* TestClock.adjust("15 seconds").pipe(
            Effect.ensuring(fs.chmod(root, 0o700).pipe(Effect.orDie)),
          );
          assert.deepEqual(warnings, [
            [`Cannot check server ownership lock at ${lockPath} (EACCES).`],
          ]);
          yield* TestClock.adjust("5 seconds");
          assert.deepEqual(messages, []);
          yield* fs.remove(lockPath);
        }
        yield* TestClock.adjust("5 seconds");
        const expected =
          operation === "unchanged"
            ? []
            : [
                [
                  `Server ownership lock at ${lockPath} was deleted or replaced. Another server may now share this T3 home. Stop any other server using this home, then restart this server. Do not delete server-owner.sqlite while a server is running.`,
                ],
              ];
        assert.deepEqual(messages, expected);
        if (operation !== "unchanged") {
          yield* fs.remove(`${lockPath}-journal`, { force: true });
          yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
        }
        yield* TestClock.adjust("15 seconds");
        assert.deepEqual(messages, expected);
        assert.lengthOf(warnings, operation === "stat error" ? 1 : 0);
      }).pipe(
        Effect.provide(
          Layer.merge(layerOwnership, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    });
  });

  it.effect("refuses beside a live pre-lock server and ignores a stale record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-legacy-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        // Any record time after this process started proves the PID was not reused.
        state: { ...state, startedAt: "2100-01-01T00:00:00.000Z" },
      });
      const refused = yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath)).pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "ServerAlreadyRunningError");
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...state, pid: 0 },
      });
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("never removes a runtime record another server published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-cleanup-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          yield* ServerRuntimeState.persistServerRuntimeState({
            path: statePath,
            state: { ...state, ownerId: "other-owner" },
          });
        }),
      );
      const remaining = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.equal(Option.getOrThrow(remaining).ownerId, "other-owner");
    }).pipe(Effect.provide(layerOwnership)),
  );
});
