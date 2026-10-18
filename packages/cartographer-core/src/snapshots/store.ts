// packages/cartographer-core/src/snapshots/store.ts
// immutable per-task analysis snapshots: capture, publish, retain, and project views
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { diffGraphs } from "../analyze/diff.js";
import type { CartographerGraph } from "../contracts/types.js";
import type { MapFile } from "../map/build.js";
import { extractGraph } from "../map/extracted.js";
import { groupScopeMembership, ROOT_SCOPE } from "../map/group.js";
import type { MapScopeLayout } from "../map/layout.js";
import {
  overlayScopes,
  type OverlayChange,
  type OverlayLink,
  type ScopeOverlay,
} from "../map/overlay.js";
import {
  captureTree,
  digest,
  fingerprintTree,
  materialize,
  resolveCommit,
  git,
  safePath,
} from "./capture.js";

export interface Comparison {
  readonly kind: "working-tree" | "branch-range" | "refs";
  readonly baseRef: string;
  readonly headRef?: string;
}
export interface SnapshotRequest {
  readonly owner: string;
  readonly root: string;
  readonly comparison?: Comparison;
  readonly validateCapture?: () => Promise<void>;
}
export interface SnapshotManifest {
  readonly version: 1;
  readonly id: string;
  readonly owner: string;
  readonly root: string;
  readonly identity: string;
  // stat fingerprint of the working tree the target was captured from; absent for refs
  readonly fingerprint?: string;
  readonly head: string;
  readonly base: string | null;
  readonly createdAt: string;
  readonly comparison: Comparison | null;
  readonly changedFiles: readonly string[];
  readonly targetFiles: readonly string[];
  readonly baseFiles: readonly string[];
}
export interface SnapshotView {
  readonly id: string;
  readonly root: string;
  readonly identity: string;
  readonly head: string;
  readonly base: string | null;
  readonly createdAt: string;
  readonly stale: boolean;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly omittedNodes: number;
  readonly omittedEdges: number;
  readonly nodes: readonly {
    id: string;
    label: string;
    group: string;
    change: "added" | "removed" | "changed" | "unchanged";
  }[];
  readonly edges: readonly {
    id: string;
    from: string;
    to: string;
    symbols: readonly string[];
    typeOnly: boolean;
    change: "added" | "removed" | "unchanged";
  }[];
  readonly changedFiles: readonly string[];
  readonly omittedChangedFiles: number;
  readonly summary: string;
  readonly coverage: string;
}
// where the comparison lands on one scope: changed children with counts, and links that exist
// only on the head side (routed by the head layout) or only on the base side (unrouted)
export interface MapOverlay {
  readonly comparison: { readonly baseIdentity: string; readonly headIdentity: string };
  readonly changed: readonly OverlayChange[];
  readonly links: readonly OverlayLink[];
}
// one scope of the precomputed map, bound to the generation it was laid out for
export interface CartographerMapScope extends MapScopeLayout {
  readonly id: string;
  readonly root: string;
  readonly identity: string;
  readonly createdAt: string;
  // null for a generation without a base
  readonly overlay: MapOverlay | null;
}
// the analysis worker, run out of process so parsing and layout never block the server
export interface AnalysisWorker {
  // writes graph.json for a captured tree and, when a map path is given, map.json beside it
  readonly analyzeTree: (
    root: string,
    output: string,
    identity: string,
    map?: string,
  ) => Promise<void>;
  // lays out one deferred scope of map.json into output, written atomically
  readonly layoutScope: (map: string, scopeId: string, output: string) => Promise<void>;
}
const MAX_NODES = 250;
const MAX_EDGES = 600;
const MAX_RESULTS = 100;
const NO_ANALYSIS =
  "No completed analysis for this task and worktree. Open Repository Map or Analyze Impact to prepare it.";

// generations kept per pointer (owner+root+comparison) beyond those a pointer still references:
// the one just published and the previous last-good, so a client mid-view of the old id resolves
const RETAINED_GENERATIONS = 2;

export class SnapshotStore {
  private readonly running = new Map<string, Promise<SnapshotView>>();
  // ids whose directories are still being written; retention never touches them
  private readonly building = new Set<string>();
  readonly cache: string;
  // deferred scope layouts in flight, keyed by generation and scope
  private readonly layouts = new Map<string, Promise<MapScopeLayout>>();
  // overlay computations in flight, keyed by generation
  private readonly overlays = new Map<string, Promise<Record<string, ScopeOverlay>>>();
  // base commits whose cached graph a running build is about to reference; retention skips them
  private readonly basesInUse = new Set<string>();
  readonly worker: AnalysisWorker;
  // absolute directories kept out of every capture; the cache itself is always one of them
  readonly exclude: readonly string[];
  constructor(cache: string, worker: AnalysisWorker, exclude: readonly string[] = []) {
    this.cache = cache;
    this.worker = worker;
    this.exclude = [cache, ...exclude];
  }

  private directory(owner: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid analysis resource.");
    return NodePath.join(this.cache, digest(owner), id);
  }

  // a base commit's graph is the same for every generation that compares against it, so it
  // is kept once per owner under the resolved sha (a checkpoint ref is reused across runs, a
  // sha is not) and copied into each generation that needs it
  private baseGraph(owner: string, sha: string): string {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Invalid base commit.");
    return NodePath.join(this.cache, digest(owner), "bases", sha, "graph.json");
  }

  private pointer(request: SnapshotRequest): string {
    return NodePath.join(
      this.cache,
      digest(request.owner),
      `${digest(JSON.stringify([request.root, request.comparison ?? null]))}.json`,
    );
  }

  private async manifest(owner: string, root: string, id: string): Promise<SnapshotManifest> {
    const data = JSON.parse(
      await NodeFSP.readFile(NodePath.join(this.directory(owner, id), "manifest.json"), "utf8"),
    ) as SnapshotManifest;
    if (
      data.version !== 1 ||
      data.id !== id ||
      data.owner !== owner ||
      data.root !== (await NodeFSP.realpath(root))
    ) {
      throw new Error("This analysis belongs to a different task or worktree.");
    }
    return data;
  }

  async latest(request: SnapshotRequest): Promise<SnapshotManifest | null> {
    try {
      const id = JSON.parse(await NodeFSP.readFile(this.pointer(request), "utf8")) as string;
      return await this.manifest(request.owner, request.root, id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async latestForKind(
    owner: string,
    root: string,
    mode: "map" | "impact",
  ): Promise<SnapshotManifest | null> {
    try {
      const id = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(this.cache, digest(owner), `${digest(root)}-${mode}.json`),
          "utf8",
        ),
      ) as string;
      return await this.manifest(owner, root, id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  analyze(request: SnapshotRequest): Promise<SnapshotView> {
    const key = this.pointer(request);
    const existing = this.running.get(key);
    if (existing) return existing;
    if (this.running.size >= 2)
      return Promise.reject(
        new Error("Two analyses are already running. Try again when one finishes."),
      );
    const promise = this.build(request).finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }

  private async build(request: SnapshotRequest): Promise<SnapshotView> {
    const comparison = request.comparison;
    // resolve moving refs before copying either side; no source is read from HEAD later. only
    // a turn checkpoint (refs) names its own head commit. branch-range's headRef is the branch
    // name for display, and rev-parse prefers a same-named tag over a branch, which would trip
    // the head guard below, so every other kind pins HEAD itself
    const head = await resolveCommit(
      request.root,
      comparison?.kind === "refs" ? (comparison.headRef ?? "HEAD") : "HEAD",
    );
    const base = comparison
      ? comparison.kind === "branch-range"
        ? (
            await git(request.root, [
              "merge-base",
              await resolveCommit(request.root, comparison.baseRef),
              head,
            ])
          ).trim()
        : await resolveCommit(request.root, comparison.baseRef)
      : null;
    // only refs captures a commit tree. branch-range analyzes the working tree because the
    // displayed Changes diff is merge-base -> working tree, so uncommitted edits must be in
    // the impact map too. the fingerprint is taken before the capture so an edit landing in
    // between makes the snapshot read stale instead of silently current
    const fingerprint =
      comparison?.kind === "refs" ? undefined : await fingerprintTree(request.root, this.exclude);
    const target = await captureTree(
      request.root,
      comparison?.kind === "refs" ? head : undefined,
      this.exclude,
    );
    if (target.head !== head)
      throw new Error("HEAD changed during analysis capture. Refresh the comparison.");
    const before = base ? await captureTree(request.root, base, this.exclude) : null;
    const id = NodeCrypto.randomUUID();
    const directory = this.directory(request.owner, id);
    await NodeFSP.mkdir(directory, { recursive: true });
    this.building.add(id);
    if (base) this.basesInUse.add(base);
    let view: SnapshotView;
    try {
      const targetRoot = NodePath.join(directory, "target");
      await NodeFSP.mkdir(targetRoot);
      await materialize(target, targetRoot);
      await request.validateCapture?.();
      // only the target side is drawn; the base graph exists for diffing
      await this.worker.analyzeTree(
        targetRoot,
        NodePath.join(directory, "graph.json"),
        target.identity,
        NodePath.join(directory, "map.json"),
      );
      if (before) {
        // the base source is still materialized because the old source RPC reads it; only
        // the analysis is skipped when this base commit's graph is already cached
        const baseRoot = NodePath.join(directory, "base");
        await NodeFSP.mkdir(baseRoot);
        await materialize(before, baseRoot);
        const baseGraph = NodePath.join(directory, "base-graph.json");
        const cached = this.baseGraph(request.owner, base!);
        try {
          await NodeFSP.copyFile(cached, baseGraph);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await this.worker.analyzeTree(baseRoot, baseGraph, base!);
          await NodeFSP.mkdir(NodePath.dirname(cached), { recursive: true });
          await NodeFSP.copyFile(baseGraph, `${cached}.${id}.tmp`);
          await NodeFSP.rename(`${cached}.${id}.tmp`, cached);
        }
      }
      const changedFiles = before
        ? [...new Set([...Object.keys(before.files), ...Object.keys(target.files)])]
            .filter((name) => before.files[name] !== target.files[name])
            .sort()
        : [];
      const manifest: SnapshotManifest = {
        version: 1,
        id,
        owner: request.owner,
        root: target.root,
        identity: target.identity,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        head,
        base,
        createdAt: new Date().toISOString(),
        comparison: comparison ?? null,
        changedFiles,
        targetFiles: Object.keys(target.files),
        baseFiles: Object.keys(before?.files ?? {}),
      };
      await NodeFSP.writeFile(NodePath.join(directory, "manifest.json"), JSON.stringify(manifest), {
        flag: "wx",
      });
      view = await this.view(request.owner, request.root, id);
      // Publish only complete artifacts. A failed rebuild leaves the last-good pointer intact.
      await request.validateCapture?.();
      const pointer = this.pointer(request);
      const temporary = `${pointer}.${id}.tmp`;
      await NodeFSP.writeFile(temporary, JSON.stringify(id), { flag: "wx" });
      await NodeFSP.rename(temporary, pointer);
      const latest = NodePath.join(
        this.cache,
        digest(request.owner),
        `${digest(request.root)}-${comparison ? "impact" : "map"}.json`,
      );
      await NodeFSP.writeFile(`${latest}.${id}.tmp`, JSON.stringify(id), { flag: "wx" });
      await NodeFSP.rename(`${latest}.${id}.tmp`, latest);
    } catch (error) {
      await NodeFSP.rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.building.delete(id);
      if (base) this.basesInUse.delete(base);
    }
    // the build is already published, so retention is best effort: it runs outside the try so
    // it cannot roll the build back, and any failure (unreadable owner dir, a stray non-uuid
    // directory, rm racing another process) must not turn a successful analysis into a rejection
    await this.prune(request.owner, JSON.stringify([target.root, comparison ?? null])).catch(
      () => undefined,
    );
    return view;
  }

  // removes older generations sharing this pointer key (root + comparison, as `pointer` hashes
  // it). kept: the newest RETAINED_GENERATIONS, anything a pointer file still names, and
  // in-flight builds (no manifest yet or still building). a cached base graph goes once no
  // remaining generation of this owner names its commit
  private async prune(owner: string, key: string): Promise<void> {
    const ownerDirectory = NodePath.join(this.cache, digest(owner));
    const referenced = new Set<string>();
    const generations: { id: string; createdAt: string; key: string; base: string | null }[] = [];
    for (const entry of await NodeFSP.readdir(ownerDirectory, { withFileTypes: true })) {
      try {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const id = JSON.parse(
            await NodeFSP.readFile(NodePath.join(ownerDirectory, entry.name), "utf8"),
          ) as unknown;
          if (typeof id === "string") referenced.add(id);
        } else if (entry.isDirectory() && !this.building.has(entry.name)) {
          const manifest = JSON.parse(
            await NodeFSP.readFile(
              NodePath.join(ownerDirectory, entry.name, "manifest.json"),
              "utf8",
            ),
          ) as SnapshotManifest;
          if (manifest.id === entry.name)
            generations.push({
              id: entry.name,
              createdAt: manifest.createdAt,
              key: JSON.stringify([manifest.root, manifest.comparison]),
              base: manifest.base,
            });
        }
      } catch {
        // an entry that cannot be read or parsed (half-written pointer, corrupt or missing
        // manifest, foreign file) is simply not a retention candidate; skipping keeps it intact
      }
    }
    const candidates = generations
      .filter((generation) => generation.key === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const removed = new Set<string>();
    for (const { id } of candidates.slice(RETAINED_GENERATIONS)) {
      if (referenced.has(id)) continue;
      await NodeFSP.rm(this.directory(owner, id), { recursive: true, force: true });
      removed.add(id);
    }
    const bases = new Set(this.basesInUse);
    for (const generation of generations)
      if (generation.base && !removed.has(generation.id)) bases.add(generation.base);
    const basesDirectory = NodePath.join(ownerDirectory, "bases");
    let cached: string[];
    try {
      cached = await NodeFSP.readdir(basesDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const sha of cached)
      if (!bases.has(sha))
        await NodeFSP.rm(NodePath.join(basesDirectory, sha), { recursive: true, force: true });
  }

  async freshness(owner: string, root: string, id: string): Promise<boolean> {
    const manifest = await this.manifest(owner, root, id);
    const comparison = manifest.comparison;
    if (comparison?.kind === "refs") {
      const head = await resolveCommit(root, comparison.headRef ?? "HEAD");
      return (
        head !== manifest.head || (await resolveCommit(root, comparison.baseRef)) !== manifest.base
      );
    }
    if (comparison?.kind === "branch-range") {
      const head = await resolveCommit(root, "HEAD");
      if (head !== manifest.head) return true;
      const base = await resolveCommit(root, comparison.baseRef);
      if ((await git(root, ["merge-base", base, head])).trim() !== manifest.base) return true;
    }
    // a manifest written before fingerprints existed has nothing to compare, so it reads stale
    // once and the rebuild writes one
    return (
      manifest.fingerprint === undefined ||
      (await fingerprintTree(root, this.exclude)) !== manifest.fingerprint
    );
  }

  async view(
    owner: string,
    root: string,
    id: string,
    checkFreshness = true,
    query = "",
  ): Promise<SnapshotView> {
    const manifest = await this.manifest(owner, root, id);
    const directory = this.directory(owner, id);
    const graph = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "graph.json"), "utf8"),
    ) as CartographerGraph;
    const base = manifest.base
      ? (JSON.parse(
          await NodeFSP.readFile(NodePath.join(directory, "base-graph.json"), "utf8"),
        ) as CartographerGraph)
      : null;
    const diff = base ? diffGraphs(base, graph) : null;
    const added = new Set(diff?.addedNodes);
    const removed = new Set(diff?.removedNodes);
    const changed = new Set(manifest.changedFiles);
    const allNodes = [
      ...graph.nodes,
      ...(base?.nodes.filter((node) => removed.has(node.id)) ?? []),
    ];
    const selectedNodes = allNodes
      .filter((node) => node.id.toLowerCase().includes(query.toLowerCase().slice(0, 200)))
      .sort(
        (a, b) => Number(changed.has(b.id)) - Number(changed.has(a.id)) || a.id.localeCompare(b.id),
      )
      .slice(0, MAX_NODES);
    const ids = new Set(selectedNodes.map((node) => node.id));
    const edgeKey = (edge: { from: string; to: string }) => JSON.stringify([edge.from, edge.to]);
    const addedEdges = new Set(diff?.addedEdges.map(edgeKey));
    const removedEdges = new Set(diff?.removedEdges.map(edgeKey));
    const allEdges = [
      ...graph.edges,
      ...(base?.edges.filter((edge) => removedEdges.has(edgeKey(edge))) ?? []),
    ];
    const edges = allEdges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .slice(0, MAX_EDGES);
    return {
      id,
      root: manifest.root,
      identity: manifest.identity,
      head: manifest.head,
      base: manifest.base,
      createdAt: manifest.createdAt,
      // the snapshot itself is immutable and already validated by manifest() above, so a live
      // check that fails (the worktree grew past the file cap, a checkpoint ref was garbage
      // collected) marks it stale instead of turning a read into an RPC error
      stale: checkFreshness ? await this.freshness(owner, root, id).catch(() => true) : false,
      nodeCount: allNodes.length,
      edgeCount: allEdges.length,
      omittedNodes: allNodes.length - selectedNodes.length,
      omittedEdges: allEdges.length - edges.length,
      nodes: selectedNodes.map((node) => ({
        id: node.id,
        label: node.label,
        group: node.group,
        change: added.has(node.id)
          ? "added"
          : removed.has(node.id)
            ? "removed"
            : changed.has(node.id)
              ? "changed"
              : "unchanged",
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        symbols: (edge.symbols ?? []).slice(0, 30),
        typeOnly: edge.typeOnly ?? false,
        change: addedEdges.has(edgeKey(edge))
          ? "added"
          : removedEdges.has(edgeKey(edge))
            ? "removed"
            : "unchanged",
      })),
      changedFiles: manifest.changedFiles.slice(0, MAX_RESULTS),
      omittedChangedFiles: Math.max(0, manifest.changedFiles.length - MAX_RESULTS),
      summary: diff
        ? `${diff.addedNodes.length} added files, ${diff.removedNodes.length} removed files, ${diff.addedEdges.length} added imports, ${diff.removedEdges.length} removed imports, ${diff.apiChanges.length} public API changes.`
        : `${graph.nodes.length} files and ${graph.edges.length} imports.`,
      coverage:
        "Static JavaScript and TypeScript imports. Runtime calls and other languages are not inferred.",
    };
  }

  async mapScope(
    owner: string,
    root: string,
    id: string,
    scopeId = ROOT_SCOPE,
  ): Promise<CartographerMapScope> {
    const manifest = await this.manifest(owner, root, id);
    const directory = this.directory(owner, id);
    const mapPath = NodePath.join(directory, "map.json");
    const map = JSON.parse(await NodeFSP.readFile(mapPath, "utf8")) as MapFile;
    const bound = async (layout: MapScopeLayout): Promise<CartographerMapScope> => ({
      id,
      root: manifest.root,
      identity: manifest.identity,
      createdAt: manifest.createdAt,
      ...layout,
      overlay: manifest.base ? await this.overlay(directory, manifest, layout) : null,
    });
    if (Object.hasOwn(map.scopes, scopeId)) return bound(map.scopes[scopeId]!);
    if (!Object.hasOwn(map.deferred, scopeId)) throw new Error("This scope is not on the map.");
    // a deferred scope is laid out once per generation and kept beside map.json, so a later
    // request (or a restarted server) reads it back instead of paying for the layout again
    const output = NodePath.join(directory, "layouts", `${digest(scopeId)}.json`);
    const key = `${id}\0${scopeId}`;
    let pending = this.layouts.get(key);
    if (!pending) {
      pending = NodeFSP.readFile(output, "utf8")
        .catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
          await this.worker.layoutScope(mapPath, scopeId, output);
          return NodeFSP.readFile(output, "utf8");
        })
        .then((text) => JSON.parse(text) as MapScopeLayout)
        .finally(() => this.layouts.delete(key));
      this.layouts.set(key, pending);
    }
    return bound(await pending);
  }

  // the overlay for every scope is one diff of the two grouped trees, so it is computed once
  // per generation and kept beside the deferred layouts. added links take their route from the
  // head layout at read time; a removed link has no route and is left without points
  private async overlay(
    directory: string,
    manifest: SnapshotManifest,
    layout: MapScopeLayout,
  ): Promise<MapOverlay> {
    const output = NodePath.join(directory, "layouts", "overlay.json");
    let pending = this.overlays.get(manifest.id);
    if (!pending) {
      pending = NodeFSP.readFile(output, "utf8")
        .catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          const read = async (name: string) =>
            groupScopeMembership(
              extractGraph(
                JSON.parse(
                  await NodeFSP.readFile(NodePath.join(directory, name), "utf8"),
                ) as CartographerGraph,
              ),
            );
          const overlays = overlayScopes(
            await read("graph.json"),
            await read("base-graph.json"),
            manifest.changedFiles,
          );
          await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
          const temporary = `${output}.${process.pid}.tmp`;
          await NodeFSP.writeFile(temporary, JSON.stringify(overlays), { flag: "wx" });
          await NodeFSP.rename(temporary, output);
          return JSON.stringify(overlays);
        })
        .then((text) => JSON.parse(text) as Record<string, ScopeOverlay>)
        .finally(() => this.overlays.delete(manifest.id));
      this.overlays.set(manifest.id, pending);
    }
    const scoped = (await pending)[layout.scope.id] ?? { changed: [], links: [] };
    const routes = new Map(layout.edges.map((edge) => [`${edge.from}\0${edge.to}`, edge.points]));
    return {
      comparison: { baseIdentity: manifest.base!, headIdentity: manifest.identity },
      changed: scoped.changed,
      links: scoped.links.map((link) => {
        const points = link.change === "added" ? routes.get(`${link.from}\0${link.to}`) : undefined;
        return points ? { ...link, points } : link;
      }),
    };
  }

  async source(
    owner: string,
    root: string,
    id: string,
    file: string,
    side: "base" | "target",
  ): Promise<string> {
    const manifest = await this.manifest(owner, root, id);
    safePath(file);
    const files = side === "base" ? manifest.baseFiles : manifest.targetFiles;
    if (!files.includes(file))
      throw new Error("This file was not captured in the selected analysis side.");
    const directory = await NodeFSP.realpath(NodePath.join(this.directory(owner, id), side));
    const absolute = await NodeFSP.realpath(NodePath.join(directory, file));
    if (!absolute.startsWith(`${directory}${NodePath.sep}`))
      throw new Error("Source escaped the immutable snapshot.");
    const content = await NodeFSP.readFile(absolute, "utf8");
    if (Buffer.byteLength(content) > 128 * 1024)
      throw new Error("Source exceeds the 128 KiB display limit.");
    return content;
  }

  async dependencies(owner: string, root: string, id: string, file: string, depth = 1) {
    await this.manifest(owner, root, id);
    const graph = JSON.parse(
      await NodeFSP.readFile(NodePath.join(this.directory(owner, id), "graph.json"), "utf8"),
    ) as CartographerGraph;
    if (!graph.nodes.some((node) => node.id === file))
      throw new Error("File is absent from the analyzed target.");
    const seen = new Set([file]);
    let frontier = [file];
    for (let hop = 0; hop < Math.max(1, Math.min(5, depth)); hop++) {
      const current = new Set(frontier);
      frontier = [];
      for (const edge of graph.edges)
        if (current.has(edge.to) && !seen.has(edge.from)) {
          seen.add(edge.from);
          frontier.push(edge.from);
        }
    }
    const incoming = graph.edges.filter((edge) => edge.to === file);
    const outgoing = graph.edges.filter((edge) => edge.from === file);
    return {
      file,
      incoming: incoming.slice(0, MAX_RESULTS),
      outgoing: outgoing.slice(0, MAX_RESULTS),
      affected: [...seen].filter((name) => name !== file).slice(0, MAX_RESULTS),
      omitted:
        Math.max(0, incoming.length - MAX_RESULTS) +
        Math.max(0, outgoing.length - MAX_RESULTS) +
        Math.max(0, seen.size - 1 - MAX_RESULTS),
    };
  }
}
export { NO_ANALYSIS };
