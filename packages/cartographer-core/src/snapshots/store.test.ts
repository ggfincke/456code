// packages/cartographer-core/src/snapshots/store.test.ts
// snapshot store behavior: immutability, last-good pointers, exclusion, and retention
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildGraph } from "../analyze/graph.js";
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
  const store = new SnapshotStore(
    NodePath.join(directory, options.cache ?? "cache"),
    async (source, output, identity) => {
      if (fail) throw new Error("fixture analysis failure");
      const graph = await buildGraph({
        root: source,
        scope: ".",
        staticTree: { gitRef: identity },
      });
      await NodeFSP.writeFile(output, JSON.stringify(graph));
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
