// packages/cartographer-core/src/map/group.test.ts
// scope grouping: package roots, src skip, chain compression, the child cap, edge aggregation
import { describe, expect, it } from "vite-plus/test";
import type { ExtractedGraph } from "./extracted.js";
import { groupScopes, MAX_CHILDREN, ROOT_SCOPE } from "./group.js";

const file = (path: string, packageRoot?: string) =>
  packageRoot ? { path, packageRoot } : { path };
const edge = (from: string, to: string, typeOnly = false) => ({ from, to, typeOnly });
const byId = (graph: ExtractedGraph) => new Map(groupScopes(graph).map((s) => [s.id, s]));
const summary = (scopeNodes: readonly { kind: string; id: string; label: string }[]) =>
  scopeNodes.map((node) => `${node.kind}:${node.id}:${node.label}`);

describe("groupScopes", () => {
  it("puts packages, top-level folders and root files at the top level", () => {
    const scopes = byId({
      files: [
        file("apps/web/src/index.ts", "apps/web"),
        file("packages/core/src/a.ts", "packages/core"),
        file("scripts/build.ts"),
        file("scripts/release.ts"),
        file("vite.config.ts"),
      ],
      edges: [edge("apps/web/src/index.ts", "packages/core/src/a.ts")],
    });
    const root = scopes.get(ROOT_SCOPE)!;
    expect(summary(root.nodes)).toEqual([
      "package:apps/web:web",
      "package:packages/core:core",
      "folder:scripts:scripts",
      "file:vite.config.ts:vite.config.ts",
    ]);
    expect(root.nodes.map((node) => node.drillable)).toEqual([true, true, true, false]);
    expect(root.edges).toEqual([
      { from: "apps/web", to: "packages/core", weight: 1, typeOnly: false },
    ]);
    expect(root.totals).toEqual({ children: 4, files: 5, edges: 1 });
    expect(scopes.get("scripts")?.breadcrumb).toEqual([{ id: ROOT_SCOPE, label: ROOT_SCOPE }]);
  });

  it("opens a single-package repo on that package's folders", () => {
    const scopes = byId({
      files: [
        file("packages/only/src/lib/a.ts", "packages/only"),
        file("packages/only/src/lib/b.ts", "packages/only"),
        file("packages/only/src/main.ts", "packages/only"),
      ],
      edges: [],
    });
    expect(summary(scopes.get(ROOT_SCOPE)!.nodes)).toEqual([
      "folder:packages/only/src/lib:lib",
      "file:packages/only/src/main.ts:main.ts",
    ]);
    expect(scopes.has("packages/only")).toBe(false);
  });

  it("keeps a package nested in another package inside it", () => {
    const scopes = byId({
      files: [
        file("apps/mobile/src/app.tsx", "apps/mobile"),
        file("apps/mobile/modules/t3-terminal/index.ts", "apps/mobile/modules/t3-terminal"),
        file("apps/mobile/modules/t3-terminal/src/view.ts", "apps/mobile/modules/t3-terminal"),
        file("packages/core/src/a.ts", "packages/core"),
      ],
      edges: [],
    });
    expect(summary(scopes.get(ROOT_SCOPE)!.nodes)).toEqual([
      "package:apps/mobile:mobile",
      "package:packages/core:core",
    ]);
    const mobile = scopes.get("apps/mobile")!;
    expect(summary(mobile.nodes)).toEqual([
      "package:apps/mobile/modules/t3-terminal:t3-terminal",
      "file:apps/mobile/src/app.tsx:app.tsx",
    ]);
    expect(mobile.nodes[0]?.drillable).toBe(true);
    expect(scopes.get("apps/mobile/modules/t3-terminal")?.breadcrumb).toEqual([
      { id: ROOT_SCOPE, label: ROOT_SCOPE },
      { id: "apps/mobile", label: "mobile" },
    ]);
  });

  it("skips a leading src/ and compresses single-child folder chains", () => {
    const scopes = byId({
      files: [
        file("apps/web/src/components/a.tsx", "apps/web"),
        file("apps/web/src/components/b.tsx", "apps/web"),
        file("apps/web/src/main.tsx", "apps/web"),
        file("apps/web/vite.config.ts", "apps/web"),
        file("packages/core/src/a/b/c/one.ts", "packages/core"),
        file("packages/core/src/a/b/c/two.ts", "packages/core"),
        file("packages/core/src/lone/only.ts", "packages/core"),
      ],
      edges: [],
    });
    expect(summary(scopes.get("apps/web")!.nodes)).toEqual([
      "folder:apps/web/src/components:components",
      "file:apps/web/src/main.tsx:main.tsx",
      "file:apps/web/vite.config.ts:vite.config.ts",
    ]);
    const core = scopes.get("packages/core")!;
    expect(summary(core.nodes)).toEqual([
      "folder:packages/core/src/a/b/c:a/b/c",
      "file:packages/core/src/lone/only.ts:lone/only.ts",
    ]);
    expect(core.nodes[0]?.fileCount).toBe(2);
    expect(scopes.get("packages/core/src/a/b/c")?.breadcrumb).toEqual([
      { id: ROOT_SCOPE, label: ROOT_SCOPE },
      { id: "packages/core", label: "core" },
    ]);
    expect(scopes.has("packages/core/src/a")).toBe(false);
    expect(scopes.has("packages/core/src/lone")).toBe(false);
  });

  it("collapses extra files into one node and reports totals before the cap", () => {
    const files = Array.from({ length: MAX_CHILDREN + 10 }, (_, index) =>
      file(`file-${String(index).padStart(3, "0")}.ts`),
    );
    const scopes = byId({
      files: [file("dir/inner.ts"), file("dir/other.ts"), ...files],
      edges: files.map((entry) => edge(entry.path, "dir/inner.ts")),
    });
    const root = scopes.get(ROOT_SCOPE)!;
    expect(root.nodes).toHaveLength(MAX_CHILDREN);
    expect(root.nodes[0]).toMatchObject({ id: "dir", kind: "folder", fileCount: 2 });
    expect(root.nodes.at(-1)).toEqual({
      id: `${ROOT_SCOPE}#more`,
      label: "+12 files",
      kind: "more",
      fileCount: 12,
      drillable: false,
    });
    expect(root.nodes.map((node) => node.id)).not.toContain("file-129.ts");
    expect(root.totals).toEqual({
      children: MAX_CHILDREN + 11,
      files: MAX_CHILDREN + 12,
      edges: MAX_CHILDREN + 10,
    });
    expect(root.edges).toHaveLength(MAX_CHILDREN - 1);
    expect(root.edges.find((entry) => entry.from === `${ROOT_SCOPE}#more`)).toEqual({
      from: `${ROOT_SCOPE}#more`,
      to: "dir",
      weight: 12,
      typeOnly: false,
    });
  });

  it("aggregates imports per child pair, drops self-loops and keeps typeOnly only when all are", () => {
    const scopes = byId({
      files: [file("a/x.ts"), file("a/z.ts"), file("b/y.ts"), file("b/w.ts")],
      edges: [
        edge("a/x.ts", "b/y.ts", true),
        edge("a/z.ts", "b/y.ts", true),
        edge("a/x.ts", "b/w.ts"),
        edge("a/x.ts", "a/z.ts", true),
        edge("b/w.ts", "a/z.ts", true),
      ],
    });
    expect(scopes.get(ROOT_SCOPE)!.edges).toEqual([
      { from: "a", to: "b", weight: 3, typeOnly: false },
      { from: "b", to: "a", weight: 1, typeOnly: true },
    ]);
    expect(scopes.get("a")!.edges).toEqual([
      { from: "a/x.ts", to: "a/z.ts", weight: 1, typeOnly: true },
    ]);
    expect(scopes.get("a")!.totals.edges).toBe(1);
  });
});
