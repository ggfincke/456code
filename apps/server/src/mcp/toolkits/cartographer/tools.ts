import {
  CartographerDependencies,
  CartographerError,
  CartographerView,
  McpCapabilityUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];
const error = Schema.Union([CartographerError, McpCapabilityUnavailableError]);
export const CartographerToolkit = Toolkit.make(
  Tool.make("architecture_blast_radius", {
    description:
      "Read bounded incoming and outgoing import evidence and transitive dependents from this task's completed Repository Map. Read-only; never starts analysis. If missing, ask the user to open Repository Map and Refresh. Static imports are evidence of possible impact, not proof of runtime calls.",
    parameters: Schema.Struct({
      file: Schema.String,
      depth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
    }),
    success: Schema.Struct({
      id: Schema.String,
      identity: Schema.String,
      stale: Schema.Boolean,
      evidence: CartographerDependencies,
    }),
    failure: error,
    dependencies,
  }),
  Tool.make("architecture_graph_diff", {
    description:
      "Read this task's last completed actual Git Diff Impact, including captured comparison identities, freshness and bounded graph changes. Never analyzes or publishes a plan. If missing, ask the user to choose Analyze Impact in T3's diff panel.",
    parameters: Schema.Struct({
      query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    }),
    success: CartographerView,
    failure: error,
    dependencies,
  }),
);
