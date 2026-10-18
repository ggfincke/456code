// packages/cartographer-core/src/map/overlay.ts
// diffs the head and base scope trees into per-scope changed children and added or removed links
import type { ScopeMembership } from "./group.js";

export interface OverlayChange {
  readonly nodeId: string;
  readonly added: number;
  readonly modified: number;
  readonly removed: number;
}
export interface OverlayLink {
  readonly from: string;
  readonly to: string;
  readonly change: "added" | "removed";
  // the head layout's route for an added link; a removed link has none and is drawn straight
  readonly points?: readonly (readonly [number, number])[];
}
export interface ScopeOverlay {
  readonly changed: readonly OverlayChange[];
  readonly links: readonly OverlayLink[];
}

type Counts = { added: number; modified: number; removed: number };
const linkKey = (edge: { from: string; to: string }) => `${edge.from}\0${edge.to}`;
const byEndpoints = (a: OverlayLink, b: OverlayLink) =>
  a.from.localeCompare(b.from) || a.to.localeCompare(b.to);

// children are matched across the two trees by node id (a path prefix). a child that exists
// only in base is not drawn, so neither its files nor its links appear here; its files are
// still counted as removed on this scope's own node one level up, where the scope is a child.
// only scopes with something to show get an entry
export function overlayScopes(
  head: readonly ScopeMembership[],
  base: readonly ScopeMembership[],
  changedFiles: readonly string[],
): Record<string, ScopeOverlay> {
  const changed = new Set(changedFiles);
  const baseById = new Map(base.map((entry) => [entry.scope.id, entry]));
  const overlays: Record<string, ScopeOverlay> = {};
  for (const { scope, owner } of head) {
    const before = baseById.get(scope.id);
    const baseOwner = before?.owner ?? new Map<string, string>();
    const children = new Set(scope.nodes.map((node) => node.id));
    const counts = new Map<string, Counts>();
    const bump = (nodeId: string, field: keyof Counts) => {
      const entry = counts.get(nodeId) ?? { added: 0, modified: 0, removed: 0 };
      entry[field] += 1;
      counts.set(nodeId, entry);
    };
    for (const [file, child] of owner) {
      if (!baseOwner.has(file)) bump(child, "added");
      else if (changed.has(file)) bump(child, "modified");
    }
    for (const [file, child] of baseOwner)
      if (!owner.has(file) && children.has(child)) bump(child, "removed");

    const headLinks = new Map(scope.edges.map((edge) => [linkKey(edge), edge]));
    const baseLinks = new Map((before?.scope.edges ?? []).map((edge) => [linkKey(edge), edge]));
    const links: OverlayLink[] = [];
    for (const [key, edge] of headLinks)
      if (!baseLinks.has(key)) links.push({ from: edge.from, to: edge.to, change: "added" });
    for (const [key, edge] of baseLinks)
      if (!headLinks.has(key) && children.has(edge.from) && children.has(edge.to))
        links.push({ from: edge.from, to: edge.to, change: "removed" });
    links.sort(byEndpoints);

    const changedNodes = scope.nodes.flatMap((node) => {
      const entry = counts.get(node.id);
      return entry ? [{ nodeId: node.id, ...entry }] : [];
    });
    if (changedNodes.length || links.length) overlays[scope.id] = { changed: changedNodes, links };
  }
  return overlays;
}
