// tests/apps/server/orchestration/decider.import.test.ts
// verifies imported transcript command invariants and ordered event emission
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ThreadImportContinuation,
  type ThreadOrigin,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "../../../../apps/server/src/orchestration/decider.ts";
import {
  createEmptyReadModel,
  projectEvent,
} from "../../../../apps/server/src/orchestration/projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const importedAt = "2026-01-02T00:00:00.000Z";
const projectId = ProjectId.make("project-import");
const threadId = ThreadId.make("thread-import");
const importedOrigin: ThreadOrigin = {
  kind: "imported",
  source: "codex-cli",
  sourcePath: "/tmp/session.jsonl",
  contentHash: "abc123",
  nativeSessionId: "native-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  importedAt,
};
const continuationActivityId = EventId.make("activity-import-continuation");
const continuationPayload = {
  type: "import.continuation" as const,
  driverKind: ProviderDriverKind.make("codex"),
  continuation: {
    state: "verified" as const,
    providerInstanceId: ProviderInstanceId.make("codex"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("codex"),
      continuationKey: "codex:instance:codex",
    },
    reason: null,
  },
};

const makeReadModel = Effect.fn("makeImportReadModel")(function* (
  origin: ThreadOrigin | null,
  withTurn = false,
) {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-project-import"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project-import"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-import"),
    metadata: {},
    payload: {
      projectId,
      title: "Imported sessions",
      workspaceRoot: "/tmp/imported-sessions",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  const withThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-import"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-thread-import"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-import"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Imported thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      origin,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (!withTurn) {
    return withThread;
  }
  return yield* projectEvent(withThread, {
    sequence: 3,
    eventId: EventId.make("event-session-import"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.session-set",
    occurredAt: importedAt,
    commandId: CommandId.make("command-session-import"),
    causationEventId: null,
    correlationId: CommandId.make("command-session-import"),
    metadata: {},
    payload: {
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-existing"),
        lastError: null,
        updatedAt: importedAt,
      },
    },
  });
});

const importCommand = {
  type: "thread.messages.import" as const,
  commandId: CommandId.make("command-messages-import"),
  threadId,
  messages: [
    {
      messageId: MessageId.make("message-second"),
      role: "assistant" as const,
      text: "second",
      createdAt: "2026-01-01T00:00:02.000Z",
    },
    {
      messageId: MessageId.make("message-first"),
      role: "user" as const,
      text: "first",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  activities: [
    {
      id: EventId.make("activity-imported"),
      tone: "info" as const,
      kind: "import.note",
      summary: "transcript imported",
      payload: { source: "codex-cli" },
      turnId: null,
      createdAt: "2026-01-01T00:00:03.000Z",
    },
  ],
  createdAt: importedAt,
};

const makeReadModelWithContinuation = Effect.fn("makeImportReadModelWithContinuation")(function* (
  continuation: ThreadImportContinuation = continuationPayload.continuation,
) {
  const readModel = yield* makeReadModel(importedOrigin);
  return yield* projectEvent(readModel, {
    sequence: 3,
    eventId: EventId.make("event-import-continuation"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.activity-appended",
    occurredAt: importedAt,
    commandId: CommandId.make("command-import-continuation"),
    causationEventId: null,
    correlationId: CommandId.make("command-import-continuation"),
    metadata: {},
    payload: {
      threadId,
      activity: {
        id: continuationActivityId,
        tone: "info",
        kind: "task.completed",
        summary: "Native codex continuation verified",
        payload: { ...continuationPayload, continuation },
        turnId: null,
        sequence: 1,
        createdAt: importedAt,
      },
    },
  });
});

const firstTurnCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("command-first-imported-turn"),
  threadId,
  message: {
    messageId: MessageId.make("message-first-imported-turn"),
    role: "user" as const,
    text: "continue",
    attachments: [],
  },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  createdAt: importedAt,
};

it.layer(NodeServices.layer)("thread.messages.import decider", (it) => {
  it.effect("blocks a first turn until the import continuation marker is present", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel(importedOrigin);
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("command-turn-before-import-finalized"),
            threadId,
            message: {
              messageId: MessageId.make("message-turn-before-import-finalized"),
              role: "user",
              text: "continue",
              attachments: [],
            },
            interactionMode: "default",
            runtimeMode: "approval-required",
            createdAt: importedAt,
          },
          readModel,
        }),
      );

      expect(failure.message).toContain("requires consent");
    }),
  );

  it.effect("emits messages in batch order before activities", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel(importedOrigin);
      const result = yield* decideOrchestrationCommand({
        command: importCommand,
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.message-sent",
        "thread.activity-appended",
      ]);
      const messageEvents = events.filter((event) => event.type === "thread.message-sent");
      expect(messageEvents.map((event) => event.payload.messageId)).toEqual([
        MessageId.make("message-second"),
        MessageId.make("message-first"),
      ]);
      expect(messageEvents.map((event) => event.payload.createdAt)).toEqual([
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:01.000Z",
      ]);
      for (const event of messageEvents) {
        expect(event.payload.turnId).toBeNull();
        expect(event.payload.streaming).toBe(false);
        expect("attachments" in event.payload).toBe(false);
      }
    }),
  );

  it.effect("rejects a batch for a non-imported thread", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel(null);
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: importCommand,
          readModel,
        }),
      );

      expect(failure.message).toContain("is not imported");
    }),
  );

  it.effect("rejects a batch after a turn exists", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel(importedOrigin, true);
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: importCommand,
          readModel,
        }),
      );

      expect(failure.message).toContain("has an existing turn");
    }),
  );

  it.effect("rejects an empty batch", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel(importedOrigin);
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...importCommand,
            commandId: CommandId.make("command-empty-import"),
            messages: [],
            activities: [],
          },
          readModel,
        }),
      );

      expect(failure.message).toContain("at least one message or activity");
    }),
  );

  it.effect("rejects batches after the import continuation marker finalizes the thread", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel(importedOrigin);
      const finalizedReadModel = yield* projectEvent(readModel, {
        sequence: 3,
        eventId: EventId.make("event-import-finalized"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.activity-appended",
        occurredAt: importedAt,
        commandId: CommandId.make("command-import-finalized"),
        causationEventId: null,
        correlationId: CommandId.make("command-import-finalized"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make("activity-import-finalized"),
            tone: "info",
            kind: "task.completed",
            summary: "Native codex continuation verified",
            payload: {
              type: "import.continuation",
              driverKind: ProviderDriverKind.make("codex"),
              continuation: {
                state: "verified",
                providerInstanceId: ProviderInstanceId.make("codex"),
                continuationIdentity: {
                  driverKind: ProviderDriverKind.make("codex"),
                  continuationKey: "codex:instance:codex",
                },
                reason: null,
              },
            },
            turnId: null,
            sequence: 4,
            createdAt: importedAt,
          },
        },
      });
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: importCommand,
          readModel: finalizedReadModel,
        }),
      );

      expect(failure.message).toContain("has finalized its import");
    }),
  );

  it.effect("rejects the first imported turn without continuation consent", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModelWithContinuation();
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: firstTurnCommand,
          readModel,
        }),
      );

      expect(failure.message).toContain("requires consent");
    }),
  );

  it.effect("rejects consent when no exact continuation identity was available", () =>
    Effect.gen(function* () {
      const continuation: ThreadImportContinuation = {
        state: "history-only",
        providerInstanceId: continuationPayload.continuation.providerInstanceId,
        continuationIdentity: null,
        reason: "no exact provider route was available",
      };
      const readModel = yield* makeReadModelWithContinuation(continuation);
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...firstTurnCommand,
            importContinuationConsent: {
              originContentHash: importedOrigin.contentHash,
              activityId: continuationActivityId,
              driverKind: continuationPayload.driverKind,
              targetProviderInstanceId: ProviderInstanceId.make("codex"),
              continuation,
            },
          },
          readModel,
        }),
      );

      expect(failure.message).toContain("requires consent");
    }),
  );

  it.effect("rejects consent for stale imported continuation state", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModelWithContinuation();
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...firstTurnCommand,
            commandId: CommandId.make("command-stale-imported-turn"),
            importContinuationConsent: {
              originContentHash: importedOrigin.contentHash,
              activityId: continuationActivityId,
              driverKind: ProviderDriverKind.make("codex"),
              targetProviderInstanceId: ProviderInstanceId.make("codex"),
              continuation: {
                ...continuationPayload.continuation,
                state: "history-only",
                reason: "native history is missing",
              },
            },
          },
          readModel,
        }),
      );

      expect(failure.message).toContain("requires consent");
    }),
  );

  it.effect("accepts consent bound to the current imported continuation state", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModelWithContinuation();
      const result = yield* decideOrchestrationCommand({
        command: {
          ...firstTurnCommand,
          commandId: CommandId.make("command-consented-imported-turn"),
          importContinuationConsent: {
            originContentHash: importedOrigin.contentHash,
            activityId: continuationActivityId,
            driverKind: continuationPayload.driverKind,
            targetProviderInstanceId: ProviderInstanceId.make("codex"),
            continuation: continuationPayload.continuation,
          },
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const turnStartRequested = events.find(
        (
          event,
        ): event is Extract<(typeof events)[number], { type: "thread.turn-start-requested" }> =>
          event.type === "thread.turn-start-requested",
      );

      expect(events.map((event) => event.type)).toContain("thread.turn-start-requested");
      expect(turnStartRequested?.payload.importContinuationAuthority).toEqual({
        driverKind: ProviderDriverKind.make("codex"),
        targetProviderInstanceId: ProviderInstanceId.make("codex"),
        continuationIdentity: continuationPayload.continuation.continuationIdentity,
      });
    }),
  );

  it.effect("rejects consent when the turn targets another provider instance", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModelWithContinuation();
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...firstTurnCommand,
            commandId: CommandId.make("command-mismatched-provider-imported-turn"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex_work"),
              model: "gpt-5-codex",
            },
            importContinuationConsent: {
              originContentHash: importedOrigin.contentHash,
              activityId: continuationActivityId,
              driverKind: continuationPayload.driverKind,
              targetProviderInstanceId: ProviderInstanceId.make("codex"),
              continuation: continuationPayload.continuation,
            },
          },
          readModel,
        }),
      );

      expect(failure.message).toContain("requires consent");
    }),
  );

  it.effect("invalidates consent after imported thread metadata changes provider instance", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModelWithContinuation();
      const updatedReadModel = yield* projectEvent(readModel, {
        sequence: 4,
        eventId: EventId.make("event-import-provider-changed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.meta-updated",
        occurredAt: importedAt,
        commandId: CommandId.make("command-import-provider-changed"),
        causationEventId: null,
        correlationId: CommandId.make("command-import-provider-changed"),
        metadata: {},
        payload: {
          threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex_work"),
            model: "gpt-5-codex",
          },
          updatedAt: importedAt,
        },
      });
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...firstTurnCommand,
            commandId: CommandId.make("command-stale-provider-imported-turn"),
            importContinuationConsent: {
              originContentHash: importedOrigin.contentHash,
              activityId: continuationActivityId,
              driverKind: continuationPayload.driverKind,
              targetProviderInstanceId: ProviderInstanceId.make("codex"),
              continuation: continuationPayload.continuation,
            },
          },
          readModel: updatedReadModel,
        }),
      );

      expect(failure.message).toContain("requires consent");
    }),
  );

  it.effect("rejects thread creation under a tombstoned project", () =>
    Effect.gen(function* () {
      const seededReadModel = yield* makeReadModel(null);
      const readModel = {
        ...seededReadModel,
        projects: seededReadModel.projects.map((project) => ({
          ...project,
          deletedAt: importedAt,
        })),
        threads: [],
      };
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.make("command-thread-under-deleted-project"),
            threadId: ThreadId.make("thread-under-deleted-project"),
            projectId,
            title: "Must not be created",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            origin: importedOrigin,
            createdAt: importedAt,
          },
          readModel,
        }),
      );

      expect(failure.message).toContain("is deleted");
    }),
  );
});
