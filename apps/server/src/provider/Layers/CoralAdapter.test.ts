import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CoralSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeCoralAdapter } from "./CoralAdapter.ts";

const decodeSettings = Schema.decodeSync(CoralSettings);
const driver = ProviderDriverKind.make("coral");
const instanceId = ProviderInstanceId.make("coral-fixture");
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
  const adapter = yield* makeCoralAdapter(settings, {
    instanceId,
    environment: {
      ...process.env,
      T3_ACP_CORAL_MODES: "1",
      T3_ACP_REQUEST_LOG_PATH: logPath,
      ...environment,
    },
  });
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
    Effect.forkChild({ startImmediately: true }),
  );
  const waitFor = Effect.fn("coral.test.waitFor")(function* (type: ProviderRuntimeEvent["type"]) {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.type === type) return event;
    }
  });
  return { adapter, cwd, settings, log: fs.readFileString(logPath), waitFor };
});

it.effect("uses multi-turn ACP, model selection, native resume, and isolated sessions", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const threadId = ThreadId.make("coral-turns");
    const session = yield* f.adapter.startSession({
      threadId,
      provider: driver,
      cwd: f.cwd,
      runtimeMode: "approval-required",
      modelSelection: { instanceId, model: "default" },
    });
    for (const model of ["default", "coral-alt"]) {
      yield* f.adapter.sendTurn({
        threadId,
        input: "Hello",
        modelSelection: { instanceId, model },
      });
      const completed = yield* f.waitFor("turn.completed");
      expect(completed.payload).toMatchObject({ state: "completed" });
    }
    expect((yield* f.adapter.readThread(threadId)).turns).toHaveLength(2);
    expect((yield* f.adapter.listSessions())[0]?.model).toBe("coral-alt");
    yield* f.adapter.stopSession(threadId);
    expect(yield* f.adapter.hasSession(threadId)).toBe(false);
    yield* f.adapter.startSession({
      threadId,
      provider: driver,
      cwd: f.cwd,
      runtimeMode: "approval-required",
      resumeCursor: session.resumeCursor,
    });
    yield* f.adapter.sendTurn({ threadId, input: "Continue" });
    expect((yield* f.waitFor("turn.completed")).payload).toMatchObject({ state: "completed" });
    const log = yield* f.log;
    expect(log).toContain('"method":"session/resume"');
    expect(log).not.toContain('"method":"authenticate"');
    expect(log.match(/"method":"session\/new"/g)).toHaveLength(1);
    expect(log).not.toContain('"method":"session/load"');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("round-trips an opaque permission option through ACP", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      T3_ACP_EMIT_TOOL_CALLS: "1",
      T3_ACP_ALLOW_ONCE_OPTION_ID: "opaque-permission-choice",
    });
    const threadId = ThreadId.make("coral-approval");
    yield* f.adapter.startSession({ threadId, cwd: f.cwd, runtimeMode: "approval-required" });
    yield* f.adapter.sendTurn({ threadId, input: "Run the tool" });
    const request = yield* f.waitFor("request.opened");
    if (request.type !== "request.opened") return yield* Effect.die("Expected approval");
    yield* f.adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(request.requestId!),
      "accept",
    );
    expect((yield* f.waitFor("turn.completed")).payload).toMatchObject({ state: "completed" });
    expect(yield* f.log).toContain("opaque-permission-choice");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("cancels a dispatched native prompt and accepts the next turn", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" });
    const threadId = ThreadId.make("coral-cancel");
    yield* f.adapter.startSession({ threadId, cwd: f.cwd, runtimeMode: "approval-required" });
    const turn = yield* f.adapter.sendTurn({ threadId, input: "Run until cancelled" });
    yield* f.adapter.interruptTurn(threadId, turn.turnId);
    expect((yield* f.waitFor("turn.completed")).payload).toMatchObject({ state: "cancelled" });
    yield* f.adapter.sendTurn({ threadId, input: "Next turn" });
    expect((yield* f.waitFor("turn.completed")).payload).toMatchObject({ state: "completed" });
    expect(yield* f.log).toContain('"method":"session/cancel"');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("fails required authentication before creating a session", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ T3_ACP_CORAL_REQUIRE_AUTH: "1" });
    const error = yield* f.adapter
      .startSession({
        threadId: ThreadId.make("coral-auth"),
        cwd: f.cwd,
        runtimeMode: "approval-required",
      })
      .pipe(Effect.flip);
    expect(error.message).toContain("requires authentication");
    expect(yield* f.log).not.toContain('"method":"session/new"');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("rejects attachments before sending and keeps provider instances independent", () =>
  Effect.gen(function* () {
    const first = yield* fixture();
    const second = yield* fixture();
    const threadId = ThreadId.make("coral-isolation");
    for (const f of [first, second])
      yield* f.adapter.startSession({ threadId, cwd: f.cwd, runtimeMode: "approval-required" });
    const error = yield* first.adapter
      .sendTurn({
        threadId,
        input: "An image",
        attachments: [
          {
            type: "image",
            id: "coral-image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      })
      .pipe(Effect.flip);
    expect(error.message).toContain("text only");
    expect(yield* first.log).not.toContain('"method":"session/prompt"');
    yield* first.adapter.stopAll();
    expect(yield* second.adapter.hasSession(threadId)).toBe(true);
    yield* second.adapter.sendTurn({ threadId, input: "Still running independently" });
    expect((yield* second.waitFor("turn.completed")).payload).toMatchObject({ state: "completed" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);
