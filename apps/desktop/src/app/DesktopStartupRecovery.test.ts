import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer staged build", () => {
    expect(
      resolveStartupRecoveryOffer(updateState({ status: "available", availableVersion: "0.1.4" })),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "checking" }))).toEqual({
      _tag: "Checking",
    });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
      ),
    ).toEqual({ _tag: "NoUpdate" });
  });

  it("offers nothing when no newer build is staged", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }))).toEqual({
      _tag: "NoUpdate",
    });
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }))).toEqual({
      _tag: "NoUpdate",
    });
  });
});
