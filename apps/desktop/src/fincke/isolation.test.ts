import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

vi.mock("./build.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./build.ts")>()),
  isFinckeDesktop: true,
}));

import { DesktopEnvironment, layer } from "../app/DesktopEnvironment.ts";
import { layerTest } from "../app/DesktopConfig.ts";
import { resolveDesktopBaseDir } from "../app/DesktopStatePaths.ts";
import { resolveEarlyLinuxElectronOptions } from "../app/DesktopEarlyElectronStartup.ts";

describe("personal desktop isolation", () => {
  it.effect("cannot select the old backend home through inherited T3CODE_HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      for (const configured of [
        Option.none<string>(),
        Option.some("/home/user/.t3"),
        Option.some("/home/user/.456code"),
      ]) {
        const base = resolveDesktopBaseDir({
          homeDirectory: "/home/user",
          joinPath: path.join,
          t3Home: configured,
        });
        expect(base).toBe(
          Option.isSome(configured)
            ? `${configured.value}/456code-thin`
            : "/home/user/.456code-thin",
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the same isolated paths before Electron readiness and during startup", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const env = {
        T3CODE_HOME: "/old/home",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        T3CODE_DESKTOP_APP_USER_MODEL_ID: "com.t3tools.t3code",
      };
      const reads: string[] = [];
      const early = resolveEarlyLinuxElectronOptions({
        env,
        homeDirectory: "/home/user",
        joinPath: path.join,
        readFileString: (path) => {
          reads.push(path);
          return "{}";
        },
      });
      const runtime = yield* DesktopEnvironment.pipe(
        Effect.provide(
          layer({
            dirname: "/repo/apps/desktop/dist-electron",
            homeDirectory: "/home/user",
            platform: "linux",
            processArch: "x64",
            appVersion: "0.0.40",
            appPath: "/repo",
            isPackaged: false,
            resourcesPath: "/repo",
            runningUnderArm64Translation: false,
          }).pipe(Layer.provide(layerTest(env))),
        ),
      );
      expect(reads).toEqual([runtime.desktopSettingsPath]);
      expect(runtime.stateDir).toBe("/old/home/456code-thin/userdata");
      expect(runtime.userDataDirName).toBe("456code-thin-dev");
      expect(runtime.legacyUserDataDirName).toBe(runtime.userDataDirName);
      expect(runtime.appUserModelId).toBe("com.ggfincke.456code.thin.dev");
      expect(early.linuxDesktopEntryName).toBe(runtime.linuxDesktopEntryName);
      expect(early.linuxWmClass).toBe(runtime.linuxWmClass);
      expect(runtime.displayName).toBe("456code (Dev)");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
