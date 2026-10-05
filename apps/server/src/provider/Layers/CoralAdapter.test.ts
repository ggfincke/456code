// apps/server/src/provider/Layers/CoralAdapter.test.ts
// verifies supervised coral sessions at the v2 adapter boundary
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CoralSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { makeCoralAdapter } from "./CoralAdapter.ts";

const decodeSettings = Schema.decodeSync(CoralSettings);
const instanceId = ProviderInstanceId.make("coral-fixture");
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-coral-config-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fixture = Effect.fn("coral.test.fixture")(function* (
  environment: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-coral-" });
  const agentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const binaryPath = path.join(cwd, "coral");
  const logPath = path.join(cwd, "requests.jsonl");
  yield* fs.writeFileString(logPath, "");
  yield* fs.writeFileString(
    binaryPath,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'coral 1.2.3'; exit 0; fi\nexec ${shellQuote(process.execPath)} ${shellQuote(agentPath)} "$@"\n`,
  );
  yield* fs.chmod(binaryPath, 0o755);
  const settings = decodeSettings({ enabled: true, binaryPath });
  const adapter = makeCoralAdapter(settings, {
    instanceId,
    crypto: yield* Crypto.Crypto,
    childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    fileSystem: fs,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
    selfInvocation: yield* resolveSelfInvocation(),
    environment: {
      ...process.env,
      T3_ACP_CORAL_MODES: "1",
      T3_ACP_REQUEST_LOG_PATH: logPath,
      ...environment,
    },
  });
  const runtimePolicy: ProviderAdapterV2RuntimePolicy = {
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd,
  };
  const open = Effect.fn("coral.test.open")(function* (
    threadId: ThreadId,
    existingProviderThread?: OrchestrationV2ProviderThread,
  ) {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const modelSelection = { instanceId, model: "default" } as const;
    const session = yield* adapter
      .openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`session:${threadId}`),
        modelSelection,
        runtimePolicy,
        ...(existingProviderThread?.nativeThreadRef?.nativeId
          ? { initialNativeThreadId: existingProviderThread.nativeThreadRef.nativeId }
          : {}),
      })
      .pipe(Effect.provideService(Scope.Scope, scope));
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    yield* Stream.runForEach(session.events, (event) => Queue.offer(events, event)).pipe(
      Effect.forkIn(scope, { startImmediately: true }),
    );
    const providerThread = yield* session.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy,
      ...(existingProviderThread ? { existingProviderThread } : {}),
    });
    const waitFor = Effect.fn("coral.test.waitFor")(function* (
      predicate: (event: ProviderAdapterV2Event) => boolean,
    ) {
      while (true) {
        const event = yield* Queue.take(events);
        if (predicate(event)) return event;
      }
    });
    const turn = Effect.fn("coral.test.turn")(function* (
      ordinal: number,
      text: string,
      model: string = "default",
    ) {
      return makeTurnInput({
        threadId,
        providerThread,
        runtimePolicy,
        now: yield* DateTime.now,
        ordinal,
        modelSelection: { instanceId, model },
        text,
      });
    });
    return { session, providerThread, waitFor, turn, close: Scope.close(scope, Exit.void) };
  });
  return { adapter, open, log: fs.readFileString(logPath) };
});

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal: number;
  readonly modelSelection: ModelSelection;
  readonly text: string;
}): ProviderAdapterV2TurnInput {
  const suffix = `${input.threadId}:${input.ordinal}`;
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "Coral adapter test",
      providerInstanceId: instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: input.ordinal,
    providerTurnOrdinal: input.ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}

const terminal = (event: ProviderAdapterV2Event) => event.type === "turn.terminal";

it.effect("uses multi-turn ACP, model selection, native resume, and isolated sessions", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const threadId = ThreadId.make("coral-turns");
    const active = yield* f.open(threadId);
    for (const [index, model] of ["default", "coral-alt"].entries()) {
      yield* active.session.startTurn(yield* active.turn(index + 1, "Hello", model));
      expect(yield* active.waitFor(terminal)).toMatchObject({ status: "completed" });
    }
    expect(
      (yield* active.session.readThreadSnapshot({ providerThread: active.providerThread }))
        .providerTurns,
    ).toHaveLength(2);
    expect(yield* f.log).toContain('"value":"coral-alt"');
    yield* active.close;
    const resumed = yield* f.open(threadId, active.providerThread);
    yield* resumed.session.startTurn(yield* resumed.turn(3, "Continue"));
    expect(yield* resumed.waitFor(terminal)).toMatchObject({ status: "completed" });
    const log = yield* f.log;
    expect(log).toContain('"method":"session/resume"');
    expect(log).not.toContain('"method":"authenticate"');
    expect(log).not.toContain('"method":"auth/login"');
    expect(log.match(/"method":"session\/new"/g)).toHaveLength(1);
    expect(log).not.toContain('"method":"session/load"');
  }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
);

it.effect("round-trips an opaque permission option through ACP", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      T3_ACP_EMIT_TOOL_CALLS: "1",
      T3_ACP_ALLOW_ONCE_OPTION_ID: "opaque-permission-choice",
    });
    const active = yield* f.open(ThreadId.make("coral-approval"));
    yield* active.session.startTurn(yield* active.turn(1, "Run the tool"));
    const request = yield* active.waitFor(
      (event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
    );
    if (request.type !== "runtime_request.updated") return yield* Effect.die("Expected approval");
    yield* active.session.respondToRuntimeRequest({
      requestId: request.runtimeRequest.id,
      decision: "accept",
    });
    expect(yield* active.waitFor(terminal)).toMatchObject({ status: "completed" });
    expect(yield* f.log).toContain("opaque-permission-choice");
  }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
);

it.effect("cancels a dispatched native prompt and accepts the next turn", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" });
    const active = yield* f.open(ThreadId.make("coral-cancel"));
    yield* active.session.startTurn(yield* active.turn(1, "Run until cancelled"));
    const dispatched = yield* active.waitFor(
      (event) => event.type === "turn_item.updated" && event.turnItem.status === "running",
    );
    if (dispatched.type !== "turn_item.updated" || dispatched.turnItem.providerTurnId === null)
      return yield* Effect.die("Expected dispatched prompt");
    yield* active.session.interruptTurn({
      providerThread: active.providerThread,
      providerTurnId: dispatched.turnItem.providerTurnId,
    });
    expect(yield* active.waitFor(terminal)).toMatchObject({ status: "interrupted" });
    yield* active.session.startTurn(yield* active.turn(2, "Next turn"));
    expect(yield* active.waitFor(terminal)).toMatchObject({ status: "completed" });
    expect(yield* f.log).toContain('"method":"session/cancel"');
  }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
);

it.effect("fails required authentication before creating a session", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ T3_ACP_CORAL_REQUIRE_AUTH: "1" });
    const error = yield* f.open(ThreadId.make("coral-auth")).pipe(Effect.flip);
    if (error._tag !== "ProviderAdapterOpenSessionError")
      return yield* Effect.die("Expected session initialization error");
    expect(String(error.cause)).toContain("requires authentication");
    expect(yield* f.log).not.toContain('"method":"session/new"');
  }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
);

it.effect("rejects attachments before sending and keeps provider instances independent", () =>
  Effect.gen(function* () {
    const first = yield* fixture();
    const second = yield* fixture();
    const threadId = ThreadId.make("coral-isolation");
    const firstActive = yield* first.open(threadId);
    const secondActive = yield* second.open(threadId);
    const capabilities = yield* first.adapter.getCapabilities();
    expect(capabilities.turns).toMatchObject({
      supportsQueuedMessages: true,
      supportsActiveSteering: false,
      supportsSteeringByInterruptRestart: false,
      supportsInterrupt: true,
    });
    const turn = yield* firstActive.turn(1, "An image");
    const error = yield* firstActive.session
      .startTurn({
        ...turn,
        message: {
          ...turn.message,
          attachments: [
            {
              type: "image",
              id: "coral-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        },
      })
      .pipe(Effect.flip);
    expect(error.message).toContain("attachments");
    expect(yield* first.log).not.toContain('"method":"session/prompt"');
    yield* firstActive.close;
    yield* secondActive.session.startTurn(
      yield* secondActive.turn(1, "Still running independently"),
    );
    expect(yield* secondActive.waitFor(terminal)).toMatchObject({ status: "completed" });
  }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
);
