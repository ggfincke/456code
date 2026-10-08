// tests/apps/server/orchestration-v2/CoralQueuedTurns.test.ts
// keeps coral queues behind completed turns without changing other providers

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  CoralSettings,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as Sqlite from "../../../../apps/server/src/persistence/Sqlite.ts";
import { makeCoralAdapter } from "../../../../apps/server/src/provider/Layers/CoralAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../../../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { resolveMessageDispatchIntent } from "../../../../apps/server/src/orchestration-v2/CommandPolicy.ts";
import * as EffectOutbox from "../../../../apps/server/src/orchestration-v2/EffectOutbox.ts";
import * as IdAllocator from "../../../../apps/server/src/orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../../../../apps/server/src/orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../../../../apps/server/src/orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../../../apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts";
import {
  layerWithRegistry,
  makeReplayServerConfig,
} from "../../../../apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../../../../apps/server/src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";

const coralInstanceId = ProviderInstanceId.make("coral");
const codexInstanceId = ProviderInstanceId.make("codex");
const decodeCoralSettings = Schema.decodeSync(CoralSettings);
const registryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const coral = makeCoralAdapter(decodeCoralSettings({ enabled: true }), {
      instanceId: coralInstanceId,
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig("coral-queued-turns"),
      selfInvocation: { command: "unused", entrypoint: undefined },
      environment: {},
    });
    const noProviderProcess = () => Effect.die("queue ownership needs no provider process");
    const codex: ProviderAdapterV2Shape = {
      instanceId: codexInstanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: noProviderProcess,
    };
    return ProviderAdapterRegistry.layerFromAdapters([
      { ...coral, openSession: noProviderProcess },
      codex,
    ]);
  }),
).pipe(Layer.provide(Layer.merge(NodeServices.layer, IdAllocator.layer)));

const database = Sqlite.layerMemory;
const testLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  registryLayer,
  layerWithRegistry({ name: "coral-queued-turns" }, registryLayer, {
    databaseLayer: database,
    runEffectWorker: false,
  }),
);

// production dispatch builds the queued execution identities; the worker stays paused
const queuedFixture = Effect.fn("coral.queue.fixture")(function* (instanceId: ProviderInstanceId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const adapter = yield* registry.get(instanceId);
  const capabilities = yield* adapter.getCapabilities();
  const cwd = yield* checkpointWorkspace(`queued-${instanceId}`);
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${instanceId}`);
  const modelSelection = {
    instanceId,
    model: instanceId === coralInstanceId ? "qwen3.8:27b-mlx" : "gpt-5.1-codex",
  };
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${instanceId}`),
    threadId,
    projectId: ProjectId.make(`project:${instanceId}`),
    title: "Queue regression",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`first:${instanceId}`),
    threadId,
    messageId: MessageId.make(`first:${instanceId}`),
    text: "current turn",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const initial = yield* projections.getThreadProjection(threadId);
  const active = { ...initial.runs[0]!, status: "running" as const };
  const putRun = (run: OrchestrationV2Run, suffix: string) =>
    projections.apply({
      id: EventId.make(`run:${run.id}:${suffix}`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: run,
    });
  yield* putRun(active, "active");
  const providerThread = initial.providerThreads[0]!;
  const session = {
    id: ProviderSessionId.make(`session:${instanceId}`),
    driver: adapter.driver,
    providerInstanceId: instanceId,
    status: "running" as const,
    cwd,
    model: modelSelection.model,
    capabilities,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  yield* projections.apply({
    id: EventId.make(`session:${instanceId}`),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: session,
  });
  yield* projections.apply({
    id: EventId.make(`provider-thread:${instanceId}`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload: { ...providerThread, providerSessionId: session.id },
  });
  const messageId = MessageId.make(`queued:${instanceId}`);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`enqueue:${instanceId}`),
    threadId,
    messageId,
    text: "next turn",
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
  });
  const projection = yield* projections.getThreadProjection(threadId);
  const queued = projection.runs.find((run) => run.userMessageId === messageId)!;
  expect(queued.status).toBe("queued");
  expect(queued.modelSelection).toEqual(modelSelection);
  const startCommandId = CommandId.make(`command:system:start-queued:${queued.id}`);
  return {
    orchestrator,
    projections,
    outbox,
    threadId,
    now,
    active,
    queued,
    session,
    putRun,
    startCommandId,
  };
});

it.effect(
  "holds Coral through tool boundaries and disconnects, then hands off once when ready",
  () =>
    Effect.gen(function* () {
      const f = yield* queuedFixture(coralInstanceId);
      for (const [ordinal, status] of ["running", "starting", "stopped"].entries()) {
        yield* f.projections.apply({
          id: EventId.make(`tool:${ordinal}`),
          type: "turn-item.updated",
          threadId: f.threadId,
          runId: f.active.id,
          occurredAt: f.now,
          payload: {
            id: TurnItemId.make(`tool:${ordinal}`),
            threadId: f.threadId,
            runId: f.active.id,
            nodeId: f.active.rootNodeId,
            providerThreadId: f.active.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1000 + ordinal,
            status: "completed",
            title: "tool boundary",
            startedAt: f.now,
            completedAt: f.now,
            updatedAt: f.now,
            type: "command_execution",
            input: "echo complete",
            output: "complete",
            exitCode: 0,
          },
        });
        yield* f.projections.apply({
          id: EventId.make(`session:${status}`),
          type: "provider-session.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: { ...f.session, status: status as "running" | "starting" | "stopped" },
        });
        expect(yield* f.projections.canStartQueuedRun(f.threadId)).toBe(false);
        expect(yield* f.orchestrator.resumeQueuedRuns).toBe(0);
        expect(
          (yield* f.projections.getThreadProjection(f.threadId)).runs.filter(
            (run) => run.status === "queued",
          ),
        ).toEqual([f.queued]);
        expect(yield* f.outbox.listByCommandId(f.startCommandId)).toEqual([]);
      }
      yield* f.putRun({ ...f.active, status: "completed", completedAt: f.now }, "ready");
      expect(yield* f.projections.canStartQueuedRun(f.threadId)).toBe(true);
      yield* Effect.all([f.orchestrator.resumeQueuedRuns, f.orchestrator.resumeQueuedRuns], {
        concurrency: 2,
      });
      const handedOff = yield* f.projections.getThreadProjection(f.threadId);
      expect(handedOff.runs.find((run) => run.id === f.queued.id)?.status).toBe("starting");
      expect(
        handedOff.messages
          .filter((message) => message.id === f.queued.userMessageId)
          .map((message) => message.text),
      ).toEqual(["next turn"]);
      expect(
        (yield* f.outbox.listByCommandId(f.startCommandId)).map((effect) => effect.request),
      ).toEqual([{ type: "provider-turn.start", runId: f.queued.id }]);
      expect(yield* f.orchestrator.resumeQueuedRuns).toBe(0);
      expect(yield* f.outbox.listByCommandId(f.startCommandId)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("retains supported mid-turn sends and explicit holds", () =>
  Effect.gen(function* () {
    const codex = yield* queuedFixture(codexInstanceId);
    expect(
      resolveMessageDispatchIntent(
        yield* codex.projections.getThreadProjection(codex.threadId),
        { type: "start_immediately" },
        "auto",
      ),
    ).toEqual({ type: "steer_active", targetRunId: codex.active.id });
    const coral = yield* queuedFixture(coralInstanceId);
    yield* coral.putRun({ ...coral.active, status: "completed", completedAt: coral.now }, "ready");
    const held = { ...coral.queued, queueHeld: true };
    yield* coral.putRun(held, "held");
    expect(yield* coral.projections.canStartQueuedRun(coral.threadId)).toBe(false);
    expect(yield* coral.orchestrator.resumeQueuedRuns).toBe(0);
    expect(
      (yield* coral.projections.getThreadProjection(coral.threadId)).runs.filter(
        (run) => run.status === "queued",
      ),
    ).toEqual([held]);
    expect(yield* coral.outbox.listByCommandId(coral.startCommandId)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
