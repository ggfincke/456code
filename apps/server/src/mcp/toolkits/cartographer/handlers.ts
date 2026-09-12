import * as Option from "effect/Option";
import { CartographerError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CartographerService from "../../../cartographer/CartographerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
    const scope = yield* McpInvocationContext.requireMcpCapability("cartographer");
    const view = yield* cartographer.get({
      threadId: scope.threadId,
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
    return { scope, view };
  });
  return CartographerToolkit.of({
    architecture_blast_radius: Effect.fn("CartographerToolkit.blastRadius")(function* (input) {
      const { scope, view } = yield* completed("map");
      const evidence = yield* cartographer.dependencies({
        threadId: scope.threadId,
        id: view.id,
        ...input,
      });
      return { id: view.id, identity: view.identity, stale: view.stale, evidence };
    }),
    architecture_graph_diff: Effect.fn("CartographerToolkit.graphDiff")(function* (input) {
      return (yield* completed("impact", input.query)).view;
    }),
  });
});
export const CartographerToolkitHandlersLive = CartographerToolkit.toLayer(make);
