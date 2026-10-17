// packages/cartographer-core/src/map/overlay.test.ts
// per-scope overlay: change counts per child, added and removed links, base-only children, nesting
import { describe, expect, it } from "vite-plus/test";
import type { ExtractedGraph } from "./extracted.js";
import { groupScopeMembership, ROOT_SCOPE } from "./group.js";
import { overlayScopes } from "./overlay.js";

const file = (path: string) => ({ path });
const edge = (from: string, to: string) => ({ from, to, typeOnly: false });

const base: ExtractedGraph = {
  files: [
    file("app/main.ts"),
    file("app/util.ts"),
    file("lib/a/one.ts"),
    file("lib/a/two.ts"),
    file("lib/b/keep.ts"),
    file("lib/b/keep2.ts"),
    file("lib/b/old.ts"),
    file("lib/c/gone.ts"),
    file("lib/c/gone2.ts"),
    file("tools/run.ts"),
    file("tools/lint.ts"),
  ],
  edges: [
    edge("app/main.ts", "lib/a/one.ts"),
    edge("app/main.ts", "lib/c/gone.ts"),
    edge("lib/a/one.ts", "lib/c/gone.ts"),
    edge("lib/a/two.ts", "lib/a/one.ts"),
    edge("tools/run.ts", "app/main.ts"),
  ],
};
const head: ExtractedGraph = {
  files: [
    file("app/main.ts"),
    file("app/util.ts"),
    file("app/new.ts"),
    file("lib/a/one.ts"),
    file("lib/a/two.ts"),
    file("lib/a/three.ts"),
    file("lib/b/keep.ts"),
    file("lib/b/keep2.ts"),
    file("tools/run.ts"),
    file("tools/lint.ts"),
  ],
  edges: [
    edge("app/main.ts", "lib/a/one.ts"),
    edge("lib/a/three.ts", "app/util.ts"),
    edge("lib/a/three.ts", "lib/a/two.ts"),
    edge("lib/a/two.ts", "lib/a/one.ts"),
    edge("lib/b/keep.ts", "lib/a/one.ts"),
  ],
};
// path-level union diff, as the manifest records it
const changedFiles = [
  "app/main.ts",
  "app/new.ts",
  "lib/a/three.ts",
  "lib/a/two.ts",
  "lib/b/old.ts",
  "lib/c/gone.ts",
  "lib/c/gone2.ts",
];
const overlays = overlayScopes(
  groupScopeMembership(head),
  groupScopeMembership(base),
  changedFiles,
);

describe("overlayScopes", () => {
  it("counts added, modified and removed files per child and routes nothing itself", () => {
    expect(overlays[ROOT_SCOPE]?.changed).toEqual([
      { nodeId: "app", added: 1, modified: 1, removed: 0 },
      { nodeId: "lib", added: 1, modified: 1, removed: 3 },
    ]);
    expect(overlays[ROOT_SCOPE]?.links).toEqual([
      { from: "lib", to: "app", change: "added" },
      { from: "tools", to: "app", change: "removed" },
    ]);
  });

  it("drops a child that exists only in base along with its links", () => {
    expect(overlays.lib).toEqual({
      changed: [
        { nodeId: "lib/a", added: 1, modified: 1, removed: 0 },
        { nodeId: "lib/b", added: 0, modified: 0, removed: 1 },
      ],
      links: [{ from: "lib/b", to: "lib/a", change: "added" }],
    });
  });

  it("overlays nested scopes and skips scopes with nothing to show", () => {
    expect(overlays["lib/a"]).toEqual({
      changed: [
        { nodeId: "lib/a/three.ts", added: 1, modified: 0, removed: 0 },
        { nodeId: "lib/a/two.ts", added: 0, modified: 1, removed: 0 },
      ],
      links: [{ from: "lib/a/three.ts", to: "lib/a/two.ts", change: "added" }],
    });
    expect(Object.keys(overlays).sort()).toEqual([ROOT_SCOPE, "app", "lib", "lib/a"]);
  });
});
