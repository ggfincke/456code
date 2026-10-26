// @effect-diagnostics nodeBuiltinImport:off - the install helper must outlive this process, which a scoped Effect child process cannot.
// apps/desktop/src/fincke/StagedUpdater.ts
// electron updater adapter that offers the locally staged build instead of a release feed
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { app } from "electron";

import {
  STAGED_UPDATE_MANIFEST,
  STAGED_UPDATES_DIR,
  compareReleaseVersions,
  parseStagedUpdateManifest,
  stagedUpdatePlatform,
  type StagedUpdateManifest,
} from "../../../../scripts/lib/fincke-staged-update.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  ElectronUpdater,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
} from "../electron/ElectronUpdater.ts";

// Like DesktopLifecycle's AppImage relaunch, the helper waits for stdin EOF, which only
// arrives once this process has exited and released the single-instance lock. Inherited
// descriptors are closed so the old AppImage mount can unmount before the file is replaced.
const INSTALL_SCRIPT = {
  linux: [
    "cat >/dev/null",
    'for fd in /proc/$$/fd/*; do n="${fd##*/}"; if [ "$n" -gt 2 ]; then eval "exec $n>&-"; fi; done 2>/dev/null',
    'mv -f "$1" "$2"',
    'exec "$2" </dev/null',
  ].join("\n"),
  mac: ["cat >/dev/null", 'rm -rf "$2"', 'mv "$1" "$2"', 'exec open "$2"'].join("\n"),
} as const;

type Listener = (...args: Array<unknown>) => void;

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = stagedUpdatePlatform(environment.platform);
  const platformDir =
    platform === null ? null : path.join(environment.baseDir, STAGED_UPDATES_DIR, platform);
  const listeners = new Map<string, Set<Listener>>();
  const emit = (eventName: string, ...args: Array<unknown>) => {
    for (const listener of listeners.get(eventName) ?? []) listener(...args);
  };
  let offered: StagedUpdateManifest | null = null;

  // a missing, malformed or not-newer manifest simply means there is no update
  const readNewerStagedBuild: Effect.Effect<StagedUpdateManifest | null> = Effect.gen(function* () {
    if (platformDir === null) return null;
    const manifest = parseStagedUpdateManifest(
      yield* fileSystem.readFileString(path.join(platformDir, STAGED_UPDATE_MANIFEST)),
    );
    if (manifest === null) return null;
    if (compareReleaseVersions(manifest.version, environment.appVersion) <= 0) return null;
    const artifactExists = yield* fileSystem.exists(path.join(platformDir, manifest.artifact));
    return artifactExists ? manifest : null;
  }).pipe(Effect.orElseSucceed(() => null));

  // the install target is the running app itself: the AppImage file or the .app bundle
  const resolveInstallTarget = (): string | null => {
    if (platform === "linux") {
      const appImage = process.env.APPIMAGE;
      return appImage && path.isAbsolute(appImage) ? appImage : null;
    }
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    return platform === "mac" && bundle.endsWith(".app") ? bundle : null;
  };

  return ElectronUpdater.of({
    // the feed is fixed to the staged folder, so feed & channel settings have nothing to change
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: () => Effect.void,
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates: Effect.gen(function* () {
      emit("checking-for-update");
      offered = yield* readNewerStagedBuild;
      if (offered === null) emit("update-not-available");
      else emit("update-available", { version: offered.version });
    }),
    // the build is already on disk, so "downloading" only confirms it is still there
    downloadUpdate: Effect.gen(function* () {
      const staged = yield* readNewerStagedBuild;
      if (staged === null || staged.version !== offered?.version) {
        return yield* new ElectronUpdaterDownloadUpdateError({
          channel: null,
          cause: new Error("The staged build is gone or was replaced; check for updates again."),
        });
      }
      emit("download-progress", { percent: 100 });
      emit("update-downloaded", { version: staged.version });
    }),
    quitAndInstall: Effect.fn("StagedUpdater.quitAndInstall")(function* ({
      isSilent,
      isForceRunAfter,
    }) {
      const staged = yield* readNewerStagedBuild;
      const target = resolveInstallTarget();
      yield* Effect.try({
        try: () => {
          if (platform === null || platformDir === null || staged === null || target === null) {
            throw new Error("No staged build or install target is available.");
          }
          const child = NodeChildProcess.spawn(
            "bash",
            [
              "-c",
              INSTALL_SCRIPT[platform],
              "456code-staged-install",
              path.join(platformDir, staged.artifact),
              target,
            ],
            { detached: true, stdio: ["pipe", "ignore", "ignore"] },
          );
          // this process exits right after, so a failed spawn has no one left to recover it
          child.on("error", () => {});
          child.unref();
          app.quit();
        },
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel: null,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
    on: (eventName, listener) => {
      const untypedListener = listener as unknown as Listener;
      return Effect.acquireRelease(
        Effect.sync(() => {
          const set = listeners.get(eventName) ?? new Set<Listener>();
          set.add(untypedListener);
          listeners.set(eventName, set);
        }),
        () =>
          Effect.sync(() => {
            listeners.get(eventName)?.delete(untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });
});

export const layer = Layer.effect(ElectronUpdater, make);
