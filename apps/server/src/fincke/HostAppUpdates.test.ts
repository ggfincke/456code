// apps/server/src/fincke/HostAppUpdates.test.ts
// verifies when a host announces its staged desktop build to remote clients
import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { resolveHostAppUpdate } from "./HostAppUpdates.ts";

const state = (overrides: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.1.4300",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  ...overrides,
});

describe("resolveHostAppUpdate", () => {
  it("announces a staged build newer than the running app", () => {
    expect(
      resolveHostAppUpdate(state({ status: "available", availableVersion: "0.1.4321" })),
    ).toEqual({ currentVersion: "0.1.4300", availableVersion: "0.1.4321" });
  });

  it("keeps announcing a build that is already confirmed on disk", () => {
    expect(
      resolveHostAppUpdate(
        state({ status: "downloaded", availableVersion: null, downloadedVersion: "0.1.4321" }),
      )?.availableVersion,
    ).toBe("0.1.4321");
  });

  it("stays quiet when updates are off or nothing newer is staged", () => {
    expect(resolveHostAppUpdate(state({ enabled: false, availableVersion: "0.1.4321" }))).toBe(
      null,
    );
    expect(resolveHostAppUpdate(state({ status: "up-to-date" }))).toBeNull();
    expect(resolveHostAppUpdate(state({ availableVersion: "0.1.4300" }))).toBeNull();
  });
});
