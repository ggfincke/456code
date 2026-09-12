import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { ThreadId, TrimmedNonEmptyString, NonNegativeInt } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

export class CartographerError extends Schema.TaggedError<CartographerError>()(
  "CartographerError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
export const CartographerComparison = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["working-tree", "branch-range"]),
    baseRef: TrimmedNonEmptyString,
    headRef: Schema.optionalKey(TrimmedNonEmptyString),
    diffHash: TrimmedNonEmptyString,
    ignoreWhitespace: Schema.Boolean,
    cwd: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn"),
    fromTurnCount: NonNegativeInt,
    toTurnCount: NonNegativeInt,
  }),
]);
export type CartographerComparison = typeof CartographerComparison.Type;
export const CartographerAnalyzeInput = Schema.Struct({
  threadId: ThreadId,
  comparison: Schema.optionalKey(CartographerComparison),
});
export type CartographerAnalyzeInput = typeof CartographerAnalyzeInput.Type;
const NodeChange = Schema.Literals(["added", "removed", "changed", "unchanged"]);
export const CartographerEdge = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  symbols: Schema.Array(Schema.String),
  typeOnly: Schema.Boolean,
  change: Schema.Literals(["added", "removed", "unchanged"]),
});
export const CartographerView = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  identity: Schema.String,
  head: Schema.String,
  base: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  stale: Schema.Boolean,
  nodeCount: NonNegativeInt,
  edgeCount: NonNegativeInt,
  omittedNodes: NonNegativeInt,
  omittedEdges: NonNegativeInt,
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      group: Schema.String,
      change: NodeChange,
    }),
  ),
  edges: Schema.Array(CartographerEdge),
  changedFiles: Schema.Array(Schema.String),
  omittedChangedFiles: NonNegativeInt,
  summary: Schema.String,
  coverage: Schema.String,
});
export type CartographerView = typeof CartographerView.Type;
export const CartographerGetInput = Schema.Struct({
  threadId: ThreadId,
  id: Schema.optionalKey(TrimmedNonEmptyString),
  mode: Schema.Literals(["map", "impact"]),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type CartographerGetInput = typeof CartographerGetInput.Type;
export const CartographerSourceInput = Schema.Struct({
  threadId: ThreadId,
  id: TrimmedNonEmptyString,
  file: TrimmedNonEmptyString,
  side: Schema.Literals(["base", "target"]),
});
export type CartographerSourceInput = typeof CartographerSourceInput.Type;
export const CartographerDependenciesInput = Schema.Struct({
  threadId: ThreadId,
  id: TrimmedNonEmptyString,
  file: TrimmedNonEmptyString,
  depth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
});
export type CartographerDependenciesInput = typeof CartographerDependenciesInput.Type;
export const CartographerDependencies = Schema.Struct({
  file: Schema.String,
  incoming: Schema.Array(CartographerEdge),
  outgoing: Schema.Array(CartographerEdge),
  affected: Schema.Array(Schema.String),
  omitted: NonNegativeInt,
});
export type CartographerDependencies = typeof CartographerDependencies.Type;
const error = Schema.Union([CartographerError, EnvironmentAuthorizationError]);
export const CartographerRpcs = [
  Rpc.make("cartographer.analyze", {
    payload: CartographerAnalyzeInput,
    success: CartographerView,
    error,
  }),
  Rpc.make("cartographer.get", {
    payload: CartographerGetInput,
    success: Schema.NullOr(CartographerView),
    error,
  }),
  Rpc.make("cartographer.source", {
    payload: CartographerSourceInput,
    success: Schema.String,
    error,
  }),
  Rpc.make("cartographer.dependencies", {
    payload: CartographerDependenciesInput,
    success: CartographerDependencies,
    error,
  }),
] as const;
