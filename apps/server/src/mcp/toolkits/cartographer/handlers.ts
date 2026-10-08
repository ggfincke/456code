// apps/server/src/mcp/toolkits/cartographer/handlers.ts
// restricts architecture queries to the calling thread
import * as Option from "effect/Option";
import { CartographerError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CartographerService from "../../../cartographer/CartographerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CartographerToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const cartographer = Option.getOrElse(
    yield* Effect.serviceOption(CartographerService.CartographerService),
    () => CartographerService.unavailable,
  );
  const completed = Effect.fn("CartographerToolkit.completed")(function* (
    mode: "map" | "impact",
    query?: string,
  ) {
    const invocation = yield* McpInvocationContext.requireMcpCapability("cartographer");
    if (invocation.thread === undefined)
      return yield* new CartographerError({
        detail: "Cartographer requires a calling thread credential.",
      });
    const threadId = invocation.thread.threadId;
    const view = yield* cartographer.get({
      threadId,
      mode,
      ...(query === undefined ? {} : { query }),
    });
    if (!view)
      return yield* new CartographerError({
        detail:
          mode === "map"
            ? "No completed map for this task and worktree. Open Repository Map and choose Refresh."
            : "No completed graph comparison for this task and worktree. Choose Analyze Impact in the diff panel.",
      });
    return { threadId, view };
  });
  return {
    architecture_blast_radius: McpToolAccess.reads(
      Effect.fn("CartographerToolkit.blastRadius")(function* (input: {
        readonly file: string;
        readonly depth?: number;
      }) {
        const { threadId, view } = yield* completed("map");
        const evidence = yield* cartographer.dependencies({
          threadId,
          id: view.id,
          ...input,
        });
        return { id: view.id, identity: view.identity, stale: view.stale, evidence };
      }),
    ),
    architecture_graph_diff: McpToolAccess.reads(
      Effect.fn("CartographerToolkit.graphDiff")(function* (input: { readonly query?: string }) {
        return (yield* completed("impact", input.query)).view;
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof CartographerToolkit.tools>;
});
export const CartographerToolkitHandlersLive = McpToolAccess.toLayer(CartographerToolkit, make);
