// packages/cartographer-core/src/map/extracted.ts
// language-neutral extractor boundary: the only graph shape grouping and layout read
import type { CartographerGraph } from "../contracts/types.js";

export interface ExtractedFile {
  readonly path: string;
  // deepest named package directory containing the file, repo-relative; absent outside packages
  readonly packageRoot?: string;
}
export interface ExtractedEdge {
  readonly from: string;
  readonly to: string;
  readonly typeOnly: boolean;
}
export interface ExtractedGraph {
  readonly files: readonly ExtractedFile[];
  readonly edges: readonly ExtractedEdge[];
}

// adapts a graph.json produced by buildGraph; a future language adds an extractor that
// produces this shape and nothing downstream changes
export function extractGraph(graph: CartographerGraph): ExtractedGraph {
  const files = graph.nodes.map((node) => ({
    path: node.id,
    ...(node.packageRoot ? { packageRoot: node.packageRoot } : {}),
  }));
  const known = new Set(files.map((file) => file.path));
  const edges = graph.edges
    .filter((edge) => known.has(edge.from) && known.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, typeOnly: edge.typeOnly === true }));
  return { files, edges };
}
