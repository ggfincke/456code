// packages/cartographer-core/src/map/build.ts
// the map pipeline: graph.json -> extracted graph -> grouped scopes -> map.json
import type { CartographerGraph } from "../contracts/types.js";
import { extractGraph } from "./extracted.js";
import { groupScopes, type GroupedScope } from "./group.js";
import { layoutScope, type MapScopeLayout } from "./layout.js";

export interface MapFile {
  readonly version: 1;
  // the root and its children, laid out during analysis
  readonly scopes: Readonly<Record<string, MapScopeLayout>>;
  // deeper scopes, grouped here and laid out on first request
  readonly deferred: Readonly<Record<string, GroupedScope>>;
}

// laying out every scope of a 5k-file repo costs ~5 s cold against a 2 s budget, while the
// root and its children cost ~1.4 s, so only those two levels are laid out eagerly
const EAGER_DEPTH = 1;

export async function buildMap(graph: CartographerGraph): Promise<MapFile> {
  const scopes: Record<string, MapScopeLayout> = {};
  const deferred: Record<string, GroupedScope> = {};
  for (const scope of groupScopes(extractGraph(graph))) {
    if (scope.breadcrumb.length <= EAGER_DEPTH) scopes[scope.id] = await layoutScope(scope);
    else deferred[scope.id] = scope;
  }
  return { version: 1, scopes, deferred };
}

export async function layoutDeferredScope(map: MapFile, scopeId: string): Promise<MapScopeLayout> {
  const scope = Object.hasOwn(map.deferred, scopeId) ? map.deferred[scopeId] : undefined;
  if (!scope) throw new Error("This scope is not on the map.");
  return layoutScope(scope);
}
