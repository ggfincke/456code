import {
  CartographerError,
  type CartographerAnalyzeInput,
  type CartographerDependenciesInput,
  type CartographerGetInput,
  type CartographerSourceInput,
  type CartographerView,
  type CartographerDependencies,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import { SnapshotStore, type Comparison } from "@t3tools/cartographer-core/snapshots";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";

export class CartographerService extends Context.Service<
  CartographerService,
  {
    readonly analyze: (
      input: CartographerAnalyzeInput,
    ) => Effect.Effect<CartographerView, CartographerError>;
    readonly get: (
      input: CartographerGetInput,
    ) => Effect.Effect<CartographerView | null, CartographerError>;
    readonly source: (input: CartographerSourceInput) => Effect.Effect<string, CartographerError>;
    readonly dependencies: (
      input: CartographerDependenciesInput,
    ) => Effect.Effect<CartographerDependencies, CartographerError>;
  }
>()("t3/cartographer/CartographerService") {}

const failure = (cause: unknown): CartographerError =>
  new CartographerError({
    detail: cause instanceof Error ? cause.message : "Cartographer could not complete the request.",
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const runner = yield* ProcessRunner.ProcessRunner;
  const review = yield* ReviewService.ReviewService;
  const checkpointDiff = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const executable = yield* HostProcessIsExecutable;
  const worker = yield* path.fromFileUrl(
    new URL(
      import.meta.url.endsWith(".ts") ? "../cartographerWorker.ts" : "./cartographerWorker.mjs",
      import.meta.url,
    ),
  );
  let closed = false;
  const workers = new Map<AbortController, Promise<ProcessRunner.ProcessRunOutput>>();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      for (const controller of workers.keys()) controller.abort();
      await Promise.allSettled(workers.values());
    }),
  );
  const store = new SnapshotStore(
    path.join(config.stateDir, "cartographer"),
    async (root, output, identity) => {
      if (closed) throw new Error("The analysis service has stopped.");
      const controller = new AbortController();
      const work = Effect.runPromise(
        runner.run({
          command: process.execPath,
          args: ["--max-old-space-size=1024", worker, root, output, identity],
          cwd: root,
          timeout: "90 seconds",
          maxOutputBytes: 64 * 1024,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }),
        { signal: controller.signal },
      );
      workers.set(controller, work);
      try {
        const result = await work;
        if (result.code !== 0)
          throw new Error(`Cartographer analysis failed: ${result.stderr.slice(0, 2000)}`);
      } finally {
        workers.delete(controller);
      }
    },
  );
  const context = Effect.fn("Cartographer.context")(function* (threadId: ThreadId) {
    const result = yield* projections.getThreadCheckpointContext(threadId);
    if (Option.isNone(result))
      return yield* new CartographerError({ detail: "The selected task is unavailable." });
    const root = yield* fs.realPath(result.value.worktreePath ?? result.value.workspaceRoot);
    return { ...result.value, root };
  });
  const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: failure });

  const analyze = Effect.fn("Cartographer.analyze")(function* (input: CartographerAnalyzeInput) {
    if (executable) {
      return yield* new CartographerError({
        detail:
          "Repository analysis requires the desktop or Node server build; standalone CLI archives do not include the analysis worker.",
      });
    }
    const task = yield* context(input.threadId);
    const selected = input.comparison;
    let comparison: Comparison | undefined;
    let validateCapture: (() => Promise<void>) | undefined;
    if (selected?.kind === "turn") {
      yield* checkpointDiff.getTurnDiff({
        threadId: input.threadId,
        fromTurnCount: selected.fromTurnCount,
        toTurnCount: selected.toTurnCount,
      });
      const ref = (count: number) =>
        count === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : task.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === count)
              ?.checkpointRef;
      const baseRef = ref(selected.fromTurnCount);
      const headRef = ref(selected.toTurnCount);
      if (!baseRef || !headRef)
        return yield* new CartographerError({
          detail:
            "The selected turn's checkpoints are unavailable. Current files cannot replace them.",
        });
      comparison = { kind: "refs", baseRef, headRef };
    } else if (selected) {
      if ((yield* fs.realPath(selected.cwd)) !== task.root) {
        return yield* new CartographerError({
          detail:
            "The displayed diff is for a different worktree. Refresh the task's diff before analyzing it.",
        });
      }
      comparison = {
        kind: selected.kind,
        baseRef: selected.baseRef,
        ...(selected.headRef ? { headRef: selected.headRef } : {}),
      };
      const validate = Effect.gen(function* () {
        const preview = yield* review.getDiffPreview({
          cwd: task.root,
          baseRef: selected.baseRef,
          ignoreWhitespace: selected.ignoreWhitespace,
        });
        const source = preview.sources.find((candidate) => candidate.kind === selected.kind);
        if (
          !source ||
          source.truncated ||
          source.diffHash !== selected.diffHash ||
          source.baseRef !== selected.baseRef ||
          source.headRef !== (selected.headRef ?? null)
        ) {
          return yield* new CartographerError({
            detail:
              "The displayed Git comparison changed or is truncated. Refresh the diff and choose Analyze Impact again.",
          });
        }
      });
      yield* validate;
      validateCapture = () => Effect.runPromise(validate);
    }
    return yield* attempt(() =>
      store.analyze({
        owner: input.threadId,
        root: task.root,
        ...(comparison ? { comparison } : {}),
        ...(validateCapture ? { validateCapture } : {}),
      }),
    );
  });
  const get = Effect.fn("Cartographer.get")(function* (input: CartographerGetInput) {
    const task = yield* context(input.threadId);
    const manifest = input.id
      ? null
      : yield* attempt(() => store.latestForKind(input.threadId, task.root, input.mode));
    const id = input.id ?? manifest?.id;
    return id
      ? yield* attempt(() => store.view(input.threadId, task.root, id, true, input.query))
      : null;
  });
  const source = Effect.fn("Cartographer.source")(function* (input: CartographerSourceInput) {
    const task = yield* context(input.threadId);
    return yield* attempt(() =>
      store.source(input.threadId, task.root, input.id, input.file, input.side),
    );
  });
  const dependencies = Effect.fn("Cartographer.dependencies")(function* (
    input: CartographerDependenciesInput,
  ) {
    const task = yield* context(input.threadId);
    const result = yield* attempt(() =>
      store.dependencies(input.threadId, task.root, input.id, input.file, input.depth),
    );
    const edge = (value: (typeof result.incoming)[number]) => ({
      id: value.id,
      from: value.from,
      to: value.to,
      symbols: (value.symbols ?? []).slice(0, 30),
      typeOnly: value.typeOnly ?? false,
      change: "unchanged" as const,
    });
    return { ...result, incoming: result.incoming.map(edge), outgoing: result.outgoing.map(edge) };
  });
  return CartographerService.of({
    analyze: (input) => analyze(input).pipe(Effect.mapError(failure)),
    get: (input) => get(input).pipe(Effect.mapError(failure)),
    source: (input) => source(input).pipe(Effect.mapError(failure)),
    dependencies: (input) => dependencies(input).pipe(Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(CartographerService, make).pipe(
  Layer.provide(ProcessRunner.layer),
);

export const unavailable: CartographerService["Service"] = {
  analyze: () =>
    Effect.fail(
      new CartographerError({ detail: "Cartographer is unavailable in this environment." }),
    ),
  get: () => Effect.succeed(null),
  source: () =>
    Effect.fail(
      new CartographerError({ detail: "Cartographer is unavailable in this environment." }),
    ),
  dependencies: () =>
    Effect.fail(
      new CartographerError({ detail: "Cartographer is unavailable in this environment." }),
    ),
};
