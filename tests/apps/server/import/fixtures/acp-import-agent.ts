#!/usr/bin/env node
// tests/apps/server/import/fixtures/acp-import-agent.ts
// serves deterministic ACP catalogs and replay history for importer tests
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpAgent from "effect-acp/agent";

const capabilityMode = process.env.T3_ACP_IMPORT_CAPABILITIES ?? "all";
const behavior = process.env.T3_ACP_IMPORT_BEHAVIOR ?? "normal";
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const pidLogPath = process.env.T3_ACP_PID_LOG_PATH;
const firstSessionId = "acp-session-first";
const secondSessionId = "acp-session-second";
const opaqueSessionId = " session/%opaque? ";
const opaqueCursor = " cursor/%opaque? ";

function logExit(reason: string): void {
  if (exitLogPath !== undefined) {
    NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
  }
}

if (pidLogPath !== undefined) {
  NodeFS.writeFileSync(pidLogPath, String(process.pid), "utf8");
}
if (behavior === "stderr-flood") {
  NodeFS.writeSync(
    2,
    `PRIVATE_ACP_STDERR_SECRET${"stderr-output-without-newlines".repeat(32_768)}`,
  );
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    behavior === "hang-initialize"
      ? Effect.never
      : Effect.succeed({
          protocolVersion: 1,
          agentCapabilities: {
            ...(capabilityMode === "missing-load" ? {} : { loadSession: true }),
            ...(capabilityMode === "missing-list"
              ? {}
              : {
                  sessionCapabilities: {
                    list: {},
                  },
                }),
          },
          agentInfo: {
            name: "ACP import test agent",
            version: "0.0.0",
          },
          _meta: {
            modelState: {
              currentModelId: "acp-test-model",
              availableModels: [{ modelId: "acp-test-model", name: "ACP Test Model" }],
            },
          },
        }),
  );
  yield* agent.handleAuthenticate(() =>
    behavior === "hang-authenticate" ? Effect.never : Effect.succeed({}),
  );
  yield* agent.handleListSessions((request) => {
    if (behavior === "hang-list") {
      return Effect.never;
    }
    if (behavior === "oversized-list-frame") {
      return Effect.succeed({
        sessions: [
          {
            sessionId: firstSessionId,
            cwd: "/workspace/oversized",
            title: `PRIVATE_OVERSIZED_ACP_FRAME${"x".repeat(8_192)}`,
          },
        ],
      });
    }
    if (behavior === "aggregate-budget-components") {
      return Effect.succeed({
        sessions: [
          {
            sessionId: secondSessionId,
            cwd: "/workspace/aggregate-budget",
            title: `catalog-${"c".repeat(2_500)}`,
          },
        ],
      });
    }
    if (behavior === "empty-catalog") {
      return Effect.succeed({ sessions: [] });
    }
    if (behavior === "infinite-pagination") {
      const pageNumber = request.cursor == null ? 1 : Number(request.cursor.replace(/^page-/, ""));
      return Effect.succeed({
        sessions: [
          {
            sessionId: `acp-session-page-${pageNumber}`,
            cwd: `/workspace/page-${pageNumber}`,
          },
        ],
        nextCursor: `page-${pageNumber + 1}`,
      });
    }
    if (behavior === "relative-cwd") {
      return Effect.succeed({
        sessions: [
          {
            sessionId: firstSessionId,
            cwd: "workspace/relative",
          },
        ],
      });
    }
    if (behavior === "opaque-identifiers") {
      if (request.cursor === undefined) {
        return Effect.succeed({
          sessions: [
            {
              sessionId: opaqueSessionId,
              cwd: "/workspace/opaque",
              title: "Opaque session",
              updatedAt: "2026-02-03T04:05:08.000Z",
            },
          ],
          nextCursor: opaqueCursor,
        });
      }
      return request.cursor === opaqueCursor
        ? Effect.succeed({ sessions: [] })
        : Effect.succeed({ sessions: [], nextCursor: request.cursor });
    }
    return Effect.succeed(
      request.cursor === "page-2"
        ? {
            sessions: [
              {
                sessionId: secondSessionId,
                cwd: "/workspace/second",
                title: "Second session",
                updatedAt: "2026-02-03T04:05:07.000Z",
              },
            ],
          }
        : {
            sessions: [
              {
                sessionId: firstSessionId,
                cwd: "/workspace/first",
                title: "First session",
                updatedAt: "2026-02-03T04:05:06.000Z",
              },
            ],
            nextCursor: "page-2",
          },
    );
  });
  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      const loadResponse = {
        models: {
          currentModelId: "acp-test-model",
          availableModels: [{ modelId: "acp-test-model", name: "ACP Test Model" }],
        },
      };

      if (behavior === "hang-load-no-replay") {
        return yield* Effect.never;
      }
      if (behavior === "hanging-replay") {
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replayed while load stayed pending" },
          },
        });
        return yield* Effect.never;
      }
      if (behavior === "late-replay") {
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before" },
          },
        });
        yield* Effect.gen(function* () {
          yield* Effect.sleep("20 millis");
          yield* agent.client.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: " after" },
            },
          });
        }).pipe(Effect.forkDetach);
        return loadResponse;
      }
      if (behavior === "replay-overflow") {
        for (let index = 0; index < 3; index += 1) {
          yield* agent.client.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `chunk-${index}` },
            },
          });
        }
        return loadResponse;
      }
      if (behavior === "aggregate-budget-components") {
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `replay-${"r".repeat(2_500)}` },
          },
        });
        return loadResponse;
      }
      if (behavior === "cumulative-wire-overflow") {
        for (let index = 0; index < 200; index += 1) {
          yield* agent.client.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `PRIVATE_CUMULATIVE_WIRE_SECRET_${index}_${"w".repeat(512)}`,
              },
            },
          });
        }
        return loadResponse;
      }
      if (behavior === "semantic-replay") {
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello " },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: "metadata between chunks",
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "unfinished-tool",
            title: "Still running",
            kind: "search",
            status: "in_progress",
            rawInput: { secret: "unfinished-private-input" },
          },
        });
        return loadResponse;
      }

      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hello " },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: {
            type: "image",
            data: "private-image-bytes",
            mimeType: "image/png",
            uri: "file:///private/attachment.png",
          },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "world" },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: " carefully" },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Inspect repository",
          kind: "search",
          status: "pending",
          rawInput: { secret: "private-tool-input" },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "resource_link",
                name: "private-resource",
                uri: "file:///private/tool-output.txt",
              },
            },
          ],
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: "foreign-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "foreign private text" },
        },
      });
      return loadResponse;
    }),
  );
  return yield* Effect.never;
});

program.pipe(
  Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)),
  NodeRuntime.runMain,
);
