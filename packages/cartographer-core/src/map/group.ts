// packages/cartographer-core/src/map/group.ts
// groups extracted files into drillable path-prefix scopes and aggregates their imports
import type { ExtractedEdge, ExtractedFile, ExtractedGraph } from "./extracted.js";

export const ROOT_SCOPE = ".";
export const MAX_CHILDREN = 120;

export type ScopeNodeKind = "package" | "folder" | "file" | "more";
export interface ScopeNode {
  readonly id: string;
  readonly label: string;
  readonly kind: ScopeNodeKind;
  readonly fileCount: number;
  readonly drillable: boolean;
}
export interface ScopeEdge {
  readonly from: string;
  readonly to: string;
  // underlying import count
  readonly weight: number;
  // true only when every underlying import is type-only
  readonly typeOnly: boolean;
}
export interface ScopeCrumb {
  readonly id: string;
  readonly label: string;
}
export interface GroupedScope {
  readonly id: string;
  readonly label: string;
  // ancestors from the root down to the parent; the scope itself is not included
  readonly breadcrumb: readonly ScopeCrumb[];
  readonly nodes: readonly ScopeNode[];
  readonly edges: readonly ScopeEdge[];
  // counts before the child cap collapsed anything
  readonly totals: { readonly children: number; readonly files: number; readonly edges: number };
}

interface Child {
  id: string;
  label: string;
  kind: ScopeNodeKind;
  files: ExtractedFile[];
}

const KIND_ORDER: Record<ScopeNodeKind, number> = { package: 0, folder: 1, file: 2, more: 3 };
const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// the top-level piece a file belongs to: the outermost package containing it (packageRoot
// names the deepest one, and a package nested in another belongs inside it on the map), else
// its top-level directory, else itself when it sits at the repo root
const pieceOf = (file: ExtractedFile, outermostFirst: readonly string[]) => {
  const outer = outermostFirst.find((root) => file.path.startsWith(`${root}/`));
  if (outer) return outer;
  if (file.packageRoot) return file.packageRoot;
  const slash = file.path.indexOf("/");
  return slash === -1 ? file.path : file.path.slice(0, slash);
};

// the immediate children below a path prefix. a leading src/ is skipped so a package opens
// on its real structure, and the child id stays the on-disk path so any id is also a prefix.
// a child folder that is itself a package root shows and drills as a package
function childrenBelow(
  prefix: string,
  files: readonly ExtractedFile[],
  packageRoots: ReadonlySet<string>,
): Child[] {
  const children = new Map<string, Child>();
  for (const file of files) {
    const remainder = file.path.slice(prefix.length + 1);
    const skipped = remainder.startsWith("src/") && remainder.length > 4;
    const rest = skipped ? remainder.slice(4) : remainder;
    const slash = rest.indexOf("/");
    const base = skipped ? `${prefix}/src` : prefix;
    const id = slash === -1 ? file.path : `${base}/${rest.slice(0, slash)}`;
    const child = children.get(id);
    if (child) child.files.push(file);
    else
      children.set(id, {
        id,
        label: slash === -1 ? rest : rest.slice(0, slash),
        kind: slash === -1 ? "file" : packageRoots.has(id) ? "package" : "folder",
        files: [file],
      });
  }
  return [...children.values()];
}

// a folder whose only content is one folder (or one file) is shown as that content with
// the joined label, so drilling never lands on a one-node screen; a package keeps its own name
function compress(child: Child, packageRoots: ReadonlySet<string>): Child {
  let current = child;
  while (current.kind === "folder") {
    const inner = childrenBelow(current.id, current.files, packageRoots);
    if (inner.length !== 1) break;
    const only = inner[0]!;
    current = only.kind === "package" ? only : { ...only, label: `${current.label}/${only.label}` };
  }
  return current;
}

function aggregate(edges: readonly ExtractedEdge[], owner: ReadonlyMap<string, string>) {
  const merged = new Map<string, { from: string; to: string; weight: number; typeOnly: boolean }>();
  for (const edge of edges) {
    const from = owner.get(edge.from);
    const to = owner.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\0${to}`;
    const existing = merged.get(key);
    if (existing) {
      existing.weight += 1;
      existing.typeOnly = existing.typeOnly && edge.typeOnly;
    } else merged.set(key, { from, to, weight: 1, typeOnly: edge.typeOnly });
  }
  return [...merged.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

export function groupScopes(graph: ExtractedGraph): GroupedScope[] {
  const packageRoots = new Set(
    graph.files.flatMap((file) => (file.packageRoot ? [file.packageRoot] : [])),
  );
  const outermostFirst = [...packageRoots].sort((a, b) => a.length - b.length);
  const pieces = new Set(graph.files.map((file) => pieceOf(file, outermostFirst)));
  const [onlyPiece] = pieces;
  const singlePackage = pieces.size === 1 && onlyPiece !== undefined && packageRoots.has(onlyPiece);
  const scopes: GroupedScope[] = [];

  const visit = (
    id: string,
    label: string,
    breadcrumb: readonly ScopeCrumb[],
    children: Child[],
    edges: readonly ExtractedEdge[],
  ) => {
    const compressed = children
      .map((child) => compress(child, packageRoots))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
    const owner = new Map<string, string>();
    for (const child of compressed) for (const file of child.files) owner.set(file.path, child.id);
    const scoped = edges.filter((edge) => owner.has(edge.from) && owner.has(edge.to));
    const full = aggregate(scoped, owner);
    const totals = {
      children: compressed.length,
      files: children.reduce((sum, child) => sum + child.files.length, 0),
      edges: full.length,
    };
    let visible = compressed;
    let collapsed: Child[] = [];
    if (compressed.length > MAX_CHILDREN) {
      // only files collapse; the best-connected ones stay visible
      const degree = new Map<string, number>();
      for (const edge of scoped) {
        degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
      }
      const containers = compressed.filter((child) => child.kind !== "file");
      const files = compressed
        .filter((child) => child.kind === "file")
        .sort(
          (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id),
        );
      const keep = Math.max(0, MAX_CHILDREN - 1 - containers.length);
      collapsed = files.slice(keep);
      visible = [...containers, ...files.slice(0, keep)].sort(
        (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id),
      );
      const more: Child = {
        id: `${id}#more`,
        label: `+${collapsed.length} files`,
        kind: "more",
        files: collapsed.flatMap((child) => child.files),
      };
      for (const file of more.files) owner.set(file.path, more.id);
      visible.push(more);
    }
    scopes.push({
      id,
      label,
      breadcrumb,
      nodes: visible.map((child) => ({
        id: child.id,
        label: child.label,
        kind: child.kind,
        fileCount: child.files.length,
        drillable: child.kind === "package" || child.kind === "folder",
      })),
      edges: collapsed.length ? aggregate(scoped, owner) : full,
      totals,
    });
    const crumbs = [...breadcrumb, { id, label }];
    for (const child of compressed) {
      if (child.kind !== "package" && child.kind !== "folder") continue;
      visit(
        child.id,
        child.label,
        crumbs,
        childrenBelow(child.id, child.files, packageRoots),
        scoped,
      );
    }
  };

  if (singlePackage) {
    visit(
      ROOT_SCOPE,
      ROOT_SCOPE,
      [],
      childrenBelow(onlyPiece, graph.files, packageRoots),
      graph.edges,
    );
    return scopes;
  }
  const top = new Map<string, Child>();
  for (const file of graph.files) {
    const piece = pieceOf(file, outermostFirst);
    const child = top.get(piece);
    if (child) child.files.push(file);
    else
      top.set(piece, {
        id: piece,
        label: lastSegment(piece),
        kind: packageRoots.has(piece) ? "package" : piece === file.path ? "file" : "folder",
        files: [file],
      });
  }
  visit(ROOT_SCOPE, ROOT_SCOPE, [], [...top.values()], graph.edges);
  return scopes;
}
