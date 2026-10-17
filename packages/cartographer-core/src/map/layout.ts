// packages/cartographer-core/src/map/layout.ts
// lays out one grouped scope with elk so clients only draw coordinates
import type { ELK as ElkInstance, ElkNode } from "elkjs/lib/elk-api.js";
import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { GroupedScope, ScopeCrumb, ScopeEdge, ScopeNode } from "./group.js";

export interface MapNode extends ScopeNode {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface MapEdge extends ScopeEdge {
  // orthogonal polyline from the source node border to the target node border
  readonly points: readonly (readonly [number, number])[];
}
export interface MapScopeLayout {
  readonly scope: {
    readonly id: string;
    readonly label: string;
    readonly breadcrumb: readonly ScopeCrumb[];
  };
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly totals: GroupedScope["totals"];
}

// variable node sizes make layered layouts ragged, so height is fixed and width only
// follows the label within bounds; the file count is drawn as text, not size
const NODE_HEIGHT = 36;
const MIN_WIDTH = 96;
const MAX_WIDTH = 260;
const CHAR_WIDTH = 7;
const LABEL_PADDING = 28;
const COUNT_WIDTH = 44;

const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
  "elk.spacing.nodeNode": "24",
  "elk.spacing.edgeNode": "16",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

// the bundled build runs the layouter on this thread; lib/main.js would try to require
// web-worker, which does not survive the server's inline bundle. its d.ts declares a default
// export, but the umd file assigns module.exports to the constructor itself, which is what
// node's cjs interop hands the default import
const ELK = ElkBundled as unknown as new () => ElkInstance;
const elk = new ELK();

const nodeWidth = (node: ScopeNode) =>
  Math.min(
    MAX_WIDTH,
    Math.max(
      MIN_WIDTH,
      node.label.length * CHAR_WIDTH + LABEL_PADDING + (node.kind === "file" ? 0 : COUNT_WIDTH),
    ),
  );

export async function layoutScope(scope: GroupedScope): Promise<MapScopeLayout> {
  // typed as ElkNode so the result carries the laid-out width, height and edge sections
  const input: ElkNode = {
    id: scope.id,
    layoutOptions: LAYOUT_OPTIONS,
    children: scope.nodes.map((node) => ({
      id: node.id,
      width: nodeWidth(node),
      height: NODE_HEIGHT,
    })),
    edges: scope.edges.map((edge, index) => ({
      id: `${scope.id}#edge#${index}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  };
  const laid = await elk.layout(input);
  const placed = new Map(laid.children?.map((child) => [child.id, child]) ?? []);
  const routed = new Map(laid.edges?.map((edge) => [edge.id, edge]) ?? []);
  return {
    scope: { id: scope.id, label: scope.label, breadcrumb: scope.breadcrumb },
    width: Math.round(laid.width ?? 0),
    height: Math.round(laid.height ?? 0),
    totals: scope.totals,
    nodes: scope.nodes.map((node) => {
      const shape = placed.get(node.id);
      return {
        ...node,
        x: Math.round(shape?.x ?? 0),
        y: Math.round(shape?.y ?? 0),
        width: Math.round(shape?.width ?? nodeWidth(node)),
        height: Math.round(shape?.height ?? NODE_HEIGHT),
      };
    }),
    edges: scope.edges.map((edge, index) => {
      const section = routed.get(`${scope.id}#edge#${index}`)?.sections?.[0];
      const points = section
        ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        : [];
      return {
        ...edge,
        points: points.map((point) => [Math.round(point.x), Math.round(point.y)] as const),
      };
    }),
  };
}
