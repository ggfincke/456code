// scripts/fincke-staged-update.test.ts
// verifies staged-update manifest validation and version ordering
import { describe, expect, it } from "@effect/vitest";

import { compareReleaseVersions, parseStagedUpdateManifest } from "./lib/fincke-staged-update.ts";

const COMMIT = "6194c9b29f276c54841ff28b536e90e2ef31148f";

const manifest = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    version: "0.1.4321",
    commit: COMMIT,
    builtAt: "2026-10-25T20:00:00.000Z",
    artifact: "456code-0.1.4321.AppImage",
    ...overrides,
  });

describe("parseStagedUpdateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(parseStagedUpdateManifest(manifest({}))).toEqual({
      version: "0.1.4321",
      commit: COMMIT,
      builtAt: "2026-10-25T20:00:00.000Z",
      artifact: "456code-0.1.4321.AppImage",
    });
  });

  // the installer moves the artifact over the running app, so it must stay in the staged dir
  it("rejects artifacts that escape the staged directory", () => {
    for (const artifact of ["../456code.AppImage", "nested/456code.AppImage", "..", ""]) {
      expect(parseStagedUpdateManifest(manifest({ artifact }))).toBeNull();
    }
  });

  it("rejects prerelease versions, short commits and invalid JSON", () => {
    expect(parseStagedUpdateManifest(manifest({ version: "0.1.4321-nightly" }))).toBeNull();
    expect(parseStagedUpdateManifest(manifest({ commit: "6194c9b29" }))).toBeNull();
    expect(parseStagedUpdateManifest("{")).toBeNull();
  });
});

describe("compareReleaseVersions", () => {
  it("orders by number rather than text", () => {
    expect(compareReleaseVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.1.4321", "0.1.0")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("never treats a prerelease as newer", () => {
    expect(compareReleaseVersions("0.2.0-nightly.1", "0.1.0")).toBe(0);
  });
});
