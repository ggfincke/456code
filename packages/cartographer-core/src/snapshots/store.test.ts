// packages/cartographer-core/src/snapshots/store.test.ts
// snapshot store behavior: immutability, last-good pointers, exclusion, retention, map overlays
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildGraph } from "../analyze/graph.js";
import { buildMap, layoutDeferredScope, type MapFile } from "../map/build.js";
import { captureTree, digest } from "./capture.js";
import { SnapshotStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const runGit = (root: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
// cache and exclude are relative to the fixture directory
async function fixture(options: { cache?: string; exclude?: readonly string[] } = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "thin-carto-"));
  roots.push(directory);
  const root = NodePath.join(directory, "repo");
  await NodeFSP.mkdir(root);
  runGit(root, "init", "-q");
  runGit(root, "config", "user.name", "Fixture");
  runGit(root, "config", "user.email", "fixture@example.invalid");
  await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const value = 1;\n");
  await NodeFSP.writeFile(
    NodePath.join(root, "b.ts"),
    'import { value } from "./a";\nexport const result = value;\n',
  );
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "fixture");
  let fail = false;
  let analyses = 0;
  const store = new SnapshotStore(
    NodePath.join(directory, options.cache ?? "cache"),
    {
      analyzeTree: async (source, output, identity, map) => {
        if (fail) throw new Error("fixture analysis failure");
        analyses += 1;
        const graph = await buildGraph({
          root: source,
          scope: ".",
          staticTree: { gitRef: identity },
        });
        await NodeFSP.writeFile(output, JSON.stringify(graph));
        if (map) await NodeFSP.writeFile(map, JSON.stringify(await buildMap(graph)));
      },
      layoutScope: async (map, scopeId, output) => {
        const file = JSON.parse(await NodeFSP.readFile(map, "utf8")) as MapFile;
        await NodeFSP.writeFile(output, JSON.stringify(await layoutDeferredScope(file, scopeId)));
      },
    },
    options.exclude?.map((entry) => NodePath.join(directory, entry)),
  );
  return {
    root,
    directory,
    store,
    request: { root, owner: "task-one" },
    fail: () => {
      fail = true;
    },
    analyses: () => analyses,
  };
}

describe("immutable task analysis", () => {
  it("detects repeated dirty edits and rejects access from another task or worktree", async () => {
    const { root, store, request, directory } = await fixture();
    const first = await store.analyze(request);
    await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const value = 2;\n");
    const dirty = await captureTree(root);
    await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const value = 3;\n");
    expect((await captureTree(root)).identity).not.toBe(dirty.identity);
    expect(await store.freshness(request.owner, root, first.id)).toBe(true);
    expect(await store.source(request.owner, root, first.id, "a.ts", "target")).toContain(
      "value = 1",
    );
    await expect(store.source("task-two", root, first.id, "a.ts", "target")).rejects.toThrow();
    const other = NodePath.join(directory, "other");
    runGit(root, "worktree", "add", "--detach", other, "HEAD");
    await expect(store.view(request.owner, other, first.id)).rejects.toThrow(
      "different task or worktree",
    );
    await expect(
      store.source(request.owner, root, first.id, "../repo/a.ts", "target"),
    ).rejects.toThrow();
  });

  it("captures both Git sides before analysis and preserves last-good after a failed refresh", async () => {
    const { root, store, request, fail } = await fixture();
    const base = runGit(root, "rev-parse", "HEAD");
    await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const replacement = 2;\n");
    const comparison = { kind: "working-tree" as const, baseRef: "HEAD" };
    const impact = await store.analyze({ ...request, comparison });
    expect(impact.base).toBe(base);
    expect(impact.changedFiles).toEqual(["a.ts"]);
    expect(impact.summary).toContain("1 public API changes");
    expect(await store.source(request.owner, root, impact.id, "a.ts", "base")).toContain(
      "value = 1",
    );
    await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const third = 3;\n");
    expect(await store.source(request.owner, root, impact.id, "a.ts", "target")).toContain(
      "replacement = 2",
    );
    fail();
    await expect(store.analyze({ ...request, comparison })).rejects.toThrow(
      "fixture analysis failure",
    );
    expect((await store.latest({ ...request, comparison }))?.id).toBe(impact.id);
    expect((await store.latestForKind(request.owner, root, "impact"))?.id).toBe(impact.id);
  });

  it("uses the branch merge base, reports dependency evidence, and bounds projections", async () => {
    const { root, store, request } = await fixture();
    const base = runGit(root, "rev-parse", "HEAD");
    await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const value = 4;\n");
    runGit(root, "add", ".");
    runGit(root, "commit", "-qm", "change");
    const impact = await store.analyze({
      ...request,
      comparison: { kind: "branch-range", baseRef: base, headRef: "HEAD" },
    });
    expect(impact.base).toBe(base);
    expect(impact.head).toBe(runGit(root, "rev-parse", "HEAD"));
    const evidence = await store.dependencies(request.owner, root, impact.id, "a.ts", 5);
    expect(evidence.affected).toEqual(["b.ts"]);
    expect(evidence.incoming[0]?.symbols).toContain("value");
    for (let i = 0; i < 270; i++)
      await NodeFSP.writeFile(NodePath.join(root, `file-${i}.ts`), "export const x = 1;\n");
    const map = await store.analyze(request);
    expect(map.nodes).toHaveLength(250);
    expect(map.omittedNodes).toBe(22);
    expect((await store.view(request.owner, root, map.id, false, "file-269")).nodes).toHaveLength(
      1,
    );
  });

  it("analyzes the working tree for branch-range and fingerprints same-size dirty edits", async () => {
    const { root, store, request } = await fixture();
    const base = runGit(root, "rev-parse", "HEAD");
    await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const value = 4;\n");
    runGit(root, "add", ".");
    runGit(root, "commit", "-qm", "change");
    await NodeFSP.writeFile(
      NodePath.join(root, "b.ts"),
      'import { value } from "./a";\nexport const result = value + 1;\n',
    );
    const impact = await store.analyze({
      ...request,
      comparison: { kind: "branch-range", baseRef: base, headRef: "HEAD" },
    });
    expect(impact.changedFiles).toEqual(["a.ts", "b.ts"]);
    expect(await store.source(request.owner, root, impact.id, "b.ts", "target")).toContain(
      "value + 1",
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "b.ts"),
      'import { value } from "./a";\nexport const result = value + 2;\n',
    );
    expect(await store.freshness(request.owner, root, impact.id)).toBe(true);
  });

  it("keeps the server state directory and its own cache out of working-tree captures", async () => {
    const { root, store, request } = await fixture({
      cache: "repo/.state/cartographer",
      exclude: ["repo/.state"],
    });
    const first = await store.analyze(request);
    await NodeFSP.writeFile(NodePath.join(root, ".state", "settings.json"), "{}\n");
    // git sees the untracked, unignored state dir, including the materialized copies
    const raw = Object.keys((await captureTree(root)).files);
    expect(raw).toContain(".state/settings.json");
    expect(raw.some((name) => /^\.state\/cartographer\/.*\/target\/a\.ts$/.test(name))).toBe(true);
    expect(
      Object.keys((await captureTree(root, undefined, [NodePath.join(root, ".state")])).files),
    ).toEqual(["a.ts", "b.ts"]);
    expect(await store.freshness(request.owner, root, first.id)).toBe(false);
    const second = await store.analyze(request);
    expect(second.nodeCount).toBe(2);
    expect((await store.latest(request))?.targetFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("removes generations older than the last two unless a pointer still names them", async () => {
    const { root, store, request } = await fixture();
    const generation = (id: string) =>
      NodeFSP.access(NodePath.join(store.cache, digest(request.owner), id)).then(
        () => true,
        () => false,
      );
    const comparison = { kind: "working-tree" as const, baseRef: "HEAD" };
    const firstMap = await store.analyze(request);
    const impact = await store.analyze({ ...request, comparison });
    const secondMap = await store.analyze(request);
    expect(await generation(firstMap.id)).toBe(true);
    const thirdMap = await store.analyze(request);
    expect(await generation(firstMap.id)).toBe(false);
    expect(await generation(secondMap.id)).toBe(true);
    expect(await generation(thirdMap.id)).toBe(true);
    // the impact pointer still names its generation, so age alone never removes it
    expect(await generation(impact.id)).toBe(true);
    expect((await store.latest({ ...request, comparison }))?.id).toBe(impact.id);
    expect((await store.latest(request))?.id).toBe(thirdMap.id);
    await expect(store.view(request.owner, root, firstMap.id)).rejects.toThrow();
  });

  it("writes map.json and serves the root eagerly and deeper scopes on first request", async () => {
    const { root, store, request } = await fixture();
    await NodeFSP.mkdir(NodePath.join(root, "lib", "a"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "lib", "b"));
    await NodeFSP.writeFile(NodePath.join(root, "lib", "a", "one.ts"), "export const one = 1;\n");
    await NodeFSP.writeFile(
      NodePath.join(root, "lib", "a", "two.ts"),
      'import { one } from "./one";\nexport const two = one + 1;\n',
    );
    await NodeFSP.writeFile(NodePath.join(root, "lib", "b", "one.ts"), "export const b = 1;\n");
    await NodeFSP.writeFile(NodePath.join(root, "lib", "b", "two.ts"), "export const c = 2;\n");
    const map = await store.analyze(request);
    const directory = NodePath.join(store.cache, digest(request.owner), map.id);
    const file = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "map.json"), "utf8"),
    ) as MapFile;
    expect(Object.keys(file.scopes).sort()).toEqual([".", "lib"]);
    expect(Object.keys(file.deferred).sort()).toEqual(["lib/a", "lib/b"]);
    const top = await store.mapScope(request.owner, root, map.id);
    expect(top).toMatchObject({
      id: map.id,
      identity: map.identity,
      scope: { id: ".", breadcrumb: [] },
    });
    expect(top.nodes.map((node) => node.id)).toEqual(["lib", "a.ts", "b.ts"]);
    expect(top.nodes.every((node) => node.width > 0 && node.height > 0)).toBe(true);
    expect(top.width).toBeGreaterThan(0);
    expect(top.edges).toHaveLength(1);
    expect(top.edges[0]).toMatchObject({ from: "b.ts", to: "a.ts", weight: 1, typeOnly: false });
    expect(top.edges[0]!.points.length).toBeGreaterThanOrEqual(2);
    expect(top.totals).toEqual({ children: 3, files: 6, edges: 1 });
    const deep = await store.mapScope(request.owner, root, map.id, "lib/a");
    expect(deep.scope.breadcrumb.map((crumb) => crumb.id)).toEqual([".", "lib"]);
    expect(deep.edges[0]).toMatchObject({ from: "lib/a/two.ts", to: "lib/a/one.ts" });
    expect(deep.edges[0]!.points.length).toBeGreaterThanOrEqual(2);
    expect(await NodeFSP.readdir(NodePath.join(directory, "layouts"))).toHaveLength(1);
    expect(await store.mapScope(request.owner, root, map.id, "lib/a")).toEqual(deep);
    await expect(store.mapScope(request.owner, root, map.id, "lib/zzz")).rejects.toThrow(
      "not on the map",
    );
  });

  it("overlays a comparison on the map and reuses the base graph cached by commit", async () => {
    const { root, store, request, analyses } = await fixture();
    const base = runGit(root, "rev-parse", "HEAD");
    await NodeFSP.writeFile(NodePath.join(root, "a.ts"), "export const value = 2;\n");
    await NodeFSP.writeFile(
      NodePath.join(root, "c.ts"),
      'import { result } from "./b";\nexport const c = result;\n',
    );
    const comparison = { kind: "working-tree" as const, baseRef: "HEAD" };
    const first = await store.analyze({ ...request, comparison });
    expect(analyses()).toBe(2);
    const top = await store.mapScope(request.owner, root, first.id);
    expect(top.overlay).toMatchObject({
      comparison: { baseIdentity: base, headIdentity: first.identity },
      changed: [
        { nodeId: "a.ts", added: 0, modified: 1, removed: 0 },
        { nodeId: "c.ts", added: 1, modified: 0, removed: 0 },
      ],
      links: [{ from: "c.ts", to: "b.ts", change: "added" }],
    });
    expect(top.overlay?.links[0]?.points?.length).toBeGreaterThanOrEqual(2);
    // the overlay is kept beside the deferred layouts and read back on the next request
    const owner = NodePath.join(store.cache, digest(request.owner));
    await expect(
      NodeFSP.access(NodePath.join(owner, first.id, "layouts", "overlay.json")),
    ).resolves.toBeUndefined();
    expect(await store.mapScope(request.owner, root, first.id)).toEqual(top);
    expect(
      (await store.mapScope(request.owner, root, (await store.analyze(request)).id)).overlay,
    ).toBeNull();

    // same base commit: the target is analyzed again, the base graph is copied from the cache
    const cached = NodePath.join(owner, "bases", base, "graph.json");
    await expect(NodeFSP.access(cached)).resolves.toBeUndefined();
    const second = await store.analyze({ ...request, comparison });
    expect(analyses()).toBe(4);
    expect(second.summary).toContain("1 added files");
    expect(await store.source(request.owner, root, second.id, "a.ts", "base")).toContain(
      "value = 1",
    );

    // the cached graph outlives the generations that name its commit by nothing: retention
    // keeps the newest two per comparison, so the old base goes with the second generation
    runGit(root, "add", ".");
    runGit(root, "commit", "-qm", "move the base");
    const third = await store.analyze({ ...request, comparison });
    expect(third.base).not.toBe(base);
    await expect(NodeFSP.access(cached)).resolves.toBeUndefined();
    await store.analyze({ ...request, comparison });
    await expect(NodeFSP.access(cached)).rejects.toThrow();
    await expect(
      NodeFSP.access(NodePath.join(owner, "bases", third.base!, "graph.json")),
    ).resolves.toBeUndefined();
  });

  it("publishes a build even when the owner directory holds a corrupt manifest", async () => {
    const { store, request } = await fixture();
    const owner = NodePath.join(store.cache, digest(request.owner));
    const first = await store.analyze(request);
    const junk = NodePath.join(owner, NodeCrypto.randomUUID());
    await NodeFSP.mkdir(junk);
    await NodeFSP.writeFile(NodePath.join(junk, "manifest.json"), "{not json");
    const second = await store.analyze(request);
    expect(second.id).not.toBe(first.id);
    expect((await store.latest(request))?.id).toBe(second.id);
    // the unreadable entry is skipped, not removed, and the previous generation survives
    expect(await NodeFSP.readFile(NodePath.join(junk, "manifest.json"), "utf8")).toBe("{not json");
    await expect(NodeFSP.access(NodePath.join(owner, first.id))).resolves.toBeUndefined();
  });
});
