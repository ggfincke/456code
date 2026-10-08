// apps/server/src/mcp/toolkits/cartographer/handlers.test.ts
// checks authorized read-only cartographer tools

import * as Tool from "effect/ai/Tool";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type CartographerView,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import { CartographerService, unavailable } from "../../../cartographer/CartographerService.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CartographerToolkit } from "./tools.ts";
import { CartographerToolkitHandlersLive } from "./handlers.ts";

const threadId = ThreadId.make("credential-task");
const view: CartographerView = {
  id: "captured",
  root: "/fixture",
  identity: "identity",
  head: "head",
  base: "base",
  createdAt: "2026-09-12T00:00:00Z",
  stale: true,
  nodeCount: 0,
  edgeCount: 0,
  omittedNodes: 0,
  omittedEdges: 0,
  nodes: [],
  edges: [],
  changedFiles: [],
  omittedChangedFiles: 0,
  summary: "No structural changes.",
  coverage: "Static imports.",
};

it.effect("binds graph queries to the credential task and never starts analysis", () =>
  Effect.gen(function* () {
    for (const tool of Object.values(CartographerToolkit.tools))
      expect(Tool.getJsonSchema(tool).type).toBe("object");
    const reads: string[] = [];
    const service = Layer.succeed(CartographerService, {
      ...unavailable,
      analyze: () => Effect.die("Read-only tools must not analyze."),
      get: (input) =>
        Effect.sync(() => {
          reads.push(input.threadId);
          return view;
        }),
    });
    const toolkit = yield* CartographerToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(CartographerToolkitHandlersLive).pipe(
          Layer.provide(service),
        ),
      ),
    );
    const results = yield* toolkit.handle("architecture_graph_diff", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "fixture",
        capabilities: new Set<McpCapability>(["cartographer"]),
        issuedAt: 0,
      }),
    );
    expect(reads).toEqual([threadId]);
    expect(results.at(-1)?.result).toEqual(view);
  }),
);

it.effect("rejects a missing capability before reading cached resources", () =>
  Effect.gen(function* () {
    const service = Layer.succeed(CartographerService, {
      ...unavailable,
      get: () => Effect.die("Unauthorized cache read."),
    });
    const toolkit = yield* CartographerToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(CartographerToolkitHandlersLive).pipe(
          Layer.provide(service),
        ),
      ),
    );
    const result = yield* toolkit.handle("architecture_graph_diff", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "fixture",
        capabilities: new Set<McpCapability>(),
        issuedAt: 0,
      }),
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("McpCapabilityUnavailableError");
  }),
);

it.effect("returns a preparation action when analysis is missing", () =>
  Effect.gen(function* () {
    const toolkit = yield* CartographerToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(CartographerToolkitHandlersLive)),
    );
    const result = yield* toolkit.handle("architecture_graph_diff", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "fixture",
        capabilities: new Set<McpCapability>(["cartographer"]),
        issuedAt: 0,
      }),
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).toContain("Analyze Impact");
  }),
);
