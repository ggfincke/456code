// apps/desktop/src/fincke/StagedUpdater.test.ts
// verifies the desktop updater only offers a newer staged build that is still on disk
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { ElectronUpdater } from "../electron/ElectronUpdater.ts";
import * as StagedUpdater from "./StagedUpdater.ts";

const COMMIT = "6194c9b29f276c54841ff28b536e90e2ef31148f";
const home = `/tmp/456code-staged-updater-test-${process.pid}`;

const layerTest = (testHome: string) =>
  StagedUpdater.layer.pipe(
    Layer.provideMerge(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: testHome,
        platform: "linux",
        processArch: "x64",
        appVersion: "0.1.4300",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: testHome })),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

// stages a manifest (and optionally its artifact) the way the stager leaves them
const stage = Effect.fn(function* (version: string, withArtifact: boolean) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dir = path.join(environment.baseDir, "updates", "linux");
  yield* fileSystem.remove(dir, { recursive: true, force: true });
  yield* fileSystem.makeDirectory(dir, { recursive: true });
  const artifact = `456code-${version}.AppImage`;
  if (withArtifact) yield* fileSystem.writeFileString(path.join(dir, artifact), "appimage");
  yield* fileSystem.writeFileString(
    path.join(dir, "manifest.json"),
    JSON.stringify({ version, commit: COMMIT, builtAt: "2026-10-25T20:00:00.000Z", artifact }),
  );
});

// runs one check and returns the events the updater emitted
const check = Effect.fn(function* () {
  const updater = yield* ElectronUpdater;
  const events: Array<{ readonly event: string; readonly payload: unknown }> = [];
  for (const event of ["update-available", "update-not-available", "update-downloaded"]) {
    yield* updater.on(event, (payload: unknown) => events.push({ event, payload }));
  }
  yield* updater.checkForUpdates;
  return { updater, events };
});

describe("StagedUpdater", () => {
  it.effect("offers a newer staged build and confirms it on download", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stage("0.1.4321", true);
        const { updater, events } = yield* check();
        expect(events).toEqual([{ event: "update-available", payload: { version: "0.1.4321" } }]);
        yield* updater.downloadUpdate;
        expect(events.at(-1)).toEqual({
          event: "update-downloaded",
          payload: { version: "0.1.4321" },
        });
      }),
    ).pipe(Effect.provide(layerTest(`${home}-newer`))),
  );

  it.effect("ignores a build that is not newer or whose artifact is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stage("0.1.4300", true);
        expect((yield* check()).events.map((entry) => entry.event)).toEqual([
          "update-not-available",
        ]);
        yield* stage("0.1.4321", false);
        expect((yield* check()).events.map((entry) => entry.event)).toEqual([
          "update-not-available",
        ]);
      }),
    ).pipe(Effect.provide(layerTest(`${home}-stale`))),
  );
});
