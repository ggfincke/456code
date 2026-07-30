// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { expandHomePath } from "../../../apps/server/src/pathExpansion.ts";

describe("expandHomePath", () => {
  it("leaves empty and non-tilde paths unchanged", () => {
    expect(expandHomePath("")).toBe("");
    expect(expandHomePath("/absolute/path")).toBe("/absolute/path");
    expect(expandHomePath("relative/path")).toBe("relative/path");
  });

  it("expands ~/ and ~\\ home prefixes", () => {
    expect(expandHomePath("~")).toBe(NodeOS.homedir());
    expect(expandHomePath("~/.codex-work")).toBe(NodePath.join(NodeOS.homedir(), ".codex-work"));
    expect(expandHomePath("~\\.codex")).toBe(NodePath.join(NodeOS.homedir(), ".codex"));
  });

  it("does not expand ~user paths", () => {
    expect(expandHomePath("~alice/foo")).toBe("~alice/foo");
  });
});
