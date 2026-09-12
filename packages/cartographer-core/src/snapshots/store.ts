import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { diffGraphs } from "../analyze/diff.js";
import type { CartographerGraph } from "../contracts/types.js";
import { captureTree, digest, materialize, resolveCommit, git, safePath } from "./capture.js";

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
const MAX_NODES = 250;
const MAX_EDGES = 600;
const MAX_RESULTS = 100;
const NO_ANALYSIS =
  "No completed analysis for this task and worktree. Open Repository Map or Analyze Impact to prepare it.";

export class SnapshotStore {
  private readonly running = new Map<string, Promise<SnapshotView>>();
  readonly cache: string;
  readonly analyzeTree: (root: string, output: string, identity: string) => Promise<void>;
  constructor(
    cache: string,
    analyzeTree: (root: string, output: string, identity: string) => Promise<void>,
  ) {
    this.cache = cache;
    this.analyzeTree = analyzeTree;
  }

  private directory(owner: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid analysis resource.");
    return NodePath.join(this.cache, digest(owner), id);
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
    // Resolve moving refs before copying either side. No source is read from HEAD later.
    const head = await resolveCommit(request.root, comparison?.headRef ?? "HEAD");
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
    const target = await captureTree(
      request.root,
      !comparison || comparison.kind === "working-tree" ? undefined : head,
    );
    if (target.head !== head)
      throw new Error("HEAD changed during analysis capture. Refresh the comparison.");
    const before = base ? await captureTree(request.root, base) : null;
    const id = NodeCrypto.randomUUID();
    const directory = this.directory(request.owner, id);
    await NodeFSP.mkdir(directory, { recursive: true });
    try {
      const targetRoot = NodePath.join(directory, "target");
      await NodeFSP.mkdir(targetRoot);
      await materialize(target, targetRoot);
      await request.validateCapture?.();
      await this.analyzeTree(targetRoot, NodePath.join(directory, "graph.json"), target.identity);
      if (before) {
        const baseRoot = NodePath.join(directory, "base");
        await NodeFSP.mkdir(baseRoot);
        await materialize(before, baseRoot);
        await this.analyzeTree(baseRoot, NodePath.join(directory, "base-graph.json"), base!);
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
      const view = await this.view(request.owner, request.root, id);
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
      return view;
    } catch (error) {
      await NodeFSP.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async freshness(owner: string, root: string, id: string): Promise<boolean> {
    const manifest = await this.manifest(owner, root, id);
    if (manifest.comparison && manifest.comparison.kind !== "working-tree") {
      const head = await resolveCommit(root, manifest.comparison.headRef ?? "HEAD");
      const base = await resolveCommit(root, manifest.comparison.baseRef);
      const resolvedBase =
        manifest.comparison.kind === "branch-range"
          ? (await git(root, ["merge-base", base, head])).trim()
          : base;
      return head !== manifest.head || resolvedBase !== manifest.base;
    }
    return (await captureTree(root)).identity !== manifest.identity;
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
      stale: checkFreshness ? await this.freshness(owner, root, id) : false,
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
