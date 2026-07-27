// tests/apps/server/import/importEngine.integration.test.ts
// verifies transcript imports through the persisted orchestration engine and projections
// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ImportSessionsRequest,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ProviderInstanceId as ProviderInstanceIdType,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "../../../../apps/server/integration/OrchestrationEngineHarness.integration.ts";
import {
  ImportContinuationDeps,
  type ContinuationOutcome,
  type ContinuationRequest,
} from "../../../../apps/server/src/import/continuationContract.ts";
import {
  ImportServiceDeps,
  type ImportServiceDepsShape,
  make as makeImportService,
} from "../../../../apps/server/src/import/importService.ts";
import type { ImportFileSourceDescriptor } from "../../../../apps/server/src/import/sourceCatalog.ts";
import type { ImportSource } from "../../../../apps/server/src/import/types.ts";
import { fileContinuationIdentity } from "../../../../apps/server/src/provider/continuationIdentity.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex-import");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claude-import");

function fixture(name: string): string {
  return NodeFS.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function withWorkspaceCwd(content: string, workspaceDir: string): string {
  return content
    .replaceAll("/workspace/original", workspaceDir)
    .replaceAll("/workspace/latest", workspaceDir);
}

function codexRollout(input: {
  readonly cwd: string;
  readonly messageCount: number;
  readonly nativeSessionId: string;
  readonly messagePrefix?: string;
}): string {
  const lines = [
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: input.nativeSessionId,
        cwd: input.cwd,
        model_provider: "openai",
      },
    }),
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "turn_context",
      payload: { cwd: input.cwd, model: "gpt-default" },
    }),
  ];
  for (let index = 0; index < input.messageCount; index += 1) {
    lines.push(
      JSON.stringify({
        timestamp: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: {
          type: "user_message",
          message: `${input.messagePrefix ?? "message"} ${index}`,
        },
      }),
    );
  }
  return lines.join("\n");
}

function importContinuationActivities(thread: OrchestrationThread) {
  return thread.activities.filter(
    (activity) =>
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      "type" in activity.payload &&
      activity.payload.type === "import.continuation",
  );
}

function writeImportFixture(input: {
  readonly rootDir: string;
  readonly fileName: string;
  readonly fixtureName: string;
  readonly workspaceDir: string;
}): string {
  NodeFS.mkdirSync(input.rootDir, { recursive: true });
  const sourcePath = NodePath.join(input.rootDir, input.fileName);
  NodeFS.writeFileSync(
    sourcePath,
    withWorkspaceCwd(fixture(input.fixtureName), input.workspaceDir),
  );
  return sourcePath;
}

function findImportedThread(
  harness: OrchestrationIntegrationHarness,
  lookup: {
    readonly contentHash: string;
    readonly source: ImportSource;
    readonly sourcePath: string;
    readonly nativeSessionId: string | null;
    readonly providerInstanceId: ProviderInstanceIdType | null;
  },
) {
  return harness.snapshotQuery.getSnapshot().pipe(
    Effect.map((snapshot) => {
      const matchingSourcePath = snapshot.threads.find(
        (thread) =>
          thread.deletedAt === null &&
          thread.origin?.source === lookup.source &&
          thread.origin.sourcePath === lookup.sourcePath,
      );
      const matchingNative =
        lookup.nativeSessionId === null
          ? undefined
          : snapshot.threads.find(
              (thread) =>
                thread.deletedAt === null &&
                thread.origin?.source === lookup.source &&
                thread.origin.providerInstanceId === lookup.providerInstanceId &&
                thread.origin.nativeSessionId === lookup.nativeSessionId,
            );
      const match = matchingSourcePath ?? matchingNative;
      return match?.origin === null || match?.origin === undefined
        ? null
        : {
            threadId: match.id,
            projectId: match.projectId,
            contentHash: match.origin.contentHash,
            source: match.origin.source,
            sourcePath: match.origin.sourcePath,
            nativeSessionId: match.origin.nativeSessionId,
            providerInstanceId: match.origin.providerInstanceId,
            modelSelection: match.modelSelection,
            archived: match.archivedAt !== null,
          };
    }),
  );
}

function findImportedThreadById(harness: OrchestrationIntegrationHarness, threadId: ThreadId) {
  return harness.snapshotQuery.getSnapshot().pipe(
    Effect.map((snapshot) => {
      const match = snapshot.threads.find(
        (thread) => thread.id === threadId && thread.deletedAt === null,
      );
      return match?.origin === null || match?.origin === undefined
        ? null
        : {
            threadId: match.id,
            projectId: match.projectId,
            contentHash: match.origin.contentHash,
            source: match.origin.source,
            sourcePath: match.origin.sourcePath,
            nativeSessionId: match.origin.nativeSessionId,
            providerInstanceId: match.origin.providerInstanceId,
            modelSelection: match.modelSelection,
            archived: match.archivedAt !== null,
          };
    }),
  );
}

function resolveImportTarget(
  driver: ProviderDriverKind,
  requestedInstanceId: ProviderInstanceIdType | null,
  compatibleInstanceIds: ReadonlyArray<ProviderInstanceIdType>,
) {
  const expectedInstanceId = driver === CODEX_DRIVER ? CODEX_INSTANCE_ID : CLAUDE_INSTANCE_ID;
  if (
    !compatibleInstanceIds.includes(expectedInstanceId) ||
    (requestedInstanceId !== null && requestedInstanceId !== expectedInstanceId)
  ) {
    return Effect.succeed(null);
  }

  const defaultModel = driver === CODEX_DRIVER ? "gpt-default" : "claude-default";
  const importedModel = driver === CODEX_DRIVER ? "gpt-5.4" : "claude-sonnet-4-5";
  return Effect.succeed({
    defaultModelSelection: {
      instanceId: expectedInstanceId,
      model: defaultModel,
    },
    availableModels: [defaultModel, importedModel],
  });
}

function makeService(input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor>;
  readonly continuationRequests: ContinuationRequest[];
  readonly dispatch?: ImportServiceDepsShape["dispatch"];
  readonly resolveTarget?: ImportServiceDepsShape["resolveImportTarget"];
  readonly fallbackModelSelection?: ModelSelection;
  readonly bindContinuation?: (
    request: ContinuationRequest,
  ) => Effect.Effect<ContinuationOutcome, never, never>;
}) {
  return makeImportService.pipe(
    Effect.provideService(
      ImportServiceDeps,
      ImportServiceDeps.of({
        dispatch: input.dispatch ?? input.harness.engine.dispatch,
        findThreadByContentHash: (lookup) => findImportedThread(input.harness, lookup),
        findThreadById: (threadId) => findImportedThreadById(input.harness, threadId),
        findProjectByWorkspaceRoot: (normalizedRoot) =>
          input.harness.snapshotQuery
            .getSnapshot()
            .pipe(
              Effect.map(
                (snapshot) =>
                  snapshot.projects.find(
                    (project) =>
                      project.deletedAt === null && project.workspaceRoot === normalizedRoot,
                  )?.id ?? null,
              ),
            ),
        isImportFinalized: (threadId) =>
          input.harness.snapshotQuery.getSnapshot().pipe(
            Effect.map((snapshot) => {
              const thread = snapshot.threads.find(
                (candidate) => candidate.id === threadId && candidate.deletedAt === null,
              );
              return (
                thread?.activities.some(
                  (activity) =>
                    typeof activity.payload === "object" &&
                    activity.payload !== null &&
                    "type" in activity.payload &&
                    activity.payload.type === "import.continuation",
                ) ?? false
              );
            }),
          ),
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(NodePath.resolve(workspaceRoot)),
        resolveImportTarget: input.resolveTarget ?? resolveImportTarget,
        threadExistsInShell: (threadId) =>
          input.harness.snapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.map((snapshot) => snapshot.threads.some((thread) => thread.id === threadId)),
            ),
        fallbackModelSelection: input.fallbackModelSelection ?? {
          instanceId: CODEX_INSTANCE_ID,
          model: "gpt-default",
        },
        sourceDescriptors: input.sourceDescriptors,
        loadAcpSessionsBatch: () => Effect.succeed([]),
      }),
    ),
    Effect.provideService(
      ImportContinuationDeps,
      ImportContinuationDeps.of({
        bind: (request) =>
          Effect.gen(function* () {
            input.continuationRequests.push(request);
            if (input.bindContinuation !== undefined) {
              return yield* input.bindContinuation(request);
            }
            return {
              state: "verified",
              providerInstanceId: request.providerInstanceId,
              continuationIdentity: {
                driverKind: ProviderDriverKind.make("codex"),
                continuationKey: `codex:instance:${request.providerInstanceId}`,
              },
              reason: null,
            } satisfies ContinuationOutcome;
          }),
      }),
    ),
  );
}

function timelineLabels(thread: OrchestrationThread): ReadonlyArray<string> {
  return [
    ...thread.messages.map((message) => ({
      createdAt: message.createdAt,
      label: `message:${message.role}:${message.text}`,
    })),
    ...thread.activities.map((activity) => ({
      createdAt: activity.createdAt,
      label: `activity:${activity.kind}:${activity.summary}`,
    })),
  ]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((entry) => entry.label);
}

function expectStrictTimeline(thread: OrchestrationThread): void {
  const createdAts = [
    ...thread.messages.map((message) => message.createdAt),
    ...thread.activities.map((activity) => activity.createdAt),
  ].toSorted();
  expect(
    createdAts.every(
      (createdAt, index) => index === 0 || createdAt > (createdAts[index - 1] ?? ""),
    ),
  ).toBe(true);
}

function modelSelection(instanceId: ProviderInstanceIdType, model: string): ModelSelection {
  return { instanceId, model };
}

it.live(
  "imports Codex and Claude fixtures through the persisted engine without starting providers",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({ provider: CODEX_DRIVER }),
      (harness) =>
        Effect.gen(function* () {
          const codexRoot = NodePath.join(harness.rootDir, "imports", "codex");
          const claudeRoot = NodePath.join(harness.rootDir, "imports", "claude");
          const codexPath = writeImportFixture({
            rootDir: NodePath.join(codexRoot, "2026", "01", "02"),
            fileName: "rollout-2026-01-02T03-04-05-123e4567-e89b-12d3-a456-426614174000.jsonl",
            fixtureName: "codex-rollout-basic.jsonl",
            workspaceDir: harness.workspaceDir,
          });
          const claudePath = writeImportFixture({
            rootDir: NodePath.join(claudeRoot, "workspace-project"),
            fileName: "123e4567-e89b-12d3-a456-426614174000.jsonl",
            fixtureName: "claude-session-basic.jsonl",
            workspaceDir: harness.workspaceDir,
          });
          const codexCanonicalPath = NodeFS.realpathSync(codexPath);
          const claudeCanonicalPath = NodeFS.realpathSync(claudePath);
          const sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor> = [
            {
              source: "codex-cli",
              driverKind: CODEX_DRIVER,
              providerInstanceId: CODEX_INSTANCE_ID,
              scanRoot: codexRoot,
              continuationIdentity: fileContinuationIdentity(CODEX_DRIVER, codexRoot),
            },
            {
              source: "claude-code",
              driverKind: CLAUDE_DRIVER,
              providerInstanceId: CLAUDE_INSTANCE_ID,
              scanRoot: claudeRoot,
              continuationIdentity: fileContinuationIdentity(CLAUDE_DRIVER, claudeRoot),
            },
          ];
          const continuationRequests: ContinuationRequest[] = [];
          const service = yield* makeService({
            harness,
            sourceDescriptors,
            continuationRequests,
          });
          const request = {
            items: [
              {
                source: "codex-cli" as const,
                sourcePath: codexPath,
                providerInstanceId: CODEX_INSTANCE_ID,
              },
              {
                source: "claude-code" as const,
                sourcePath: claudePath,
                providerInstanceId: CLAUDE_INSTANCE_ID,
              },
            ],
          };

          const firstResult = yield* service.importSessions(request);
          expect(firstResult.failed).toEqual([]);
          expect(firstResult.skipped).toEqual([]);
          expect(firstResult.imported).toHaveLength(2);
          expect(firstResult.imported).toMatchObject([
            {
              sourcePath: codexPath,
              messageCount: 2,
              activityCount: 2,
              continuation: {
                state: "verified",
                providerInstanceId: CODEX_INSTANCE_ID,
                reason: null,
              },
            },
            {
              sourcePath: claudePath,
              messageCount: 2,
              activityCount: 3,
              continuation: {
                state: "verified",
                providerInstanceId: CLAUDE_INSTANCE_ID,
                reason: null,
              },
            },
          ]);

          const codexThreadId = firstResult.imported[0]!.threadId;
          const claudeThreadId = firstResult.imported[1]!.threadId;
          const codexThread = yield* harness.waitForThread(codexThreadId, () => true);
          const claudeThread = yield* harness.waitForThread(claudeThreadId, () => true);
          const shell = yield* harness.snapshotQuery.getShellSnapshot();
          const readModel = yield* harness.snapshotQuery.getSnapshot();

          expect(readModel.projects).toHaveLength(1);
          expect(readModel.projects[0]?.workspaceRoot).toBe(harness.workspaceDir);
          expect(readModel.threads.map((thread) => thread.id)).toEqual([
            codexThreadId,
            claudeThreadId,
          ]);
          expect(shell.projects).toHaveLength(1);
          expect(shell.threads.map((thread) => thread.id)).toEqual([codexThreadId, claudeThreadId]);
          expect(
            shell.threads.map((thread) => ({
              id: thread.id,
              latestTurn: thread.latestTurn,
              session: thread.session,
              hasPendingApprovals: thread.hasPendingApprovals,
              hasPendingUserInput: thread.hasPendingUserInput,
            })),
          ).toEqual([
            {
              id: codexThreadId,
              latestTurn: null,
              session: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            },
            {
              id: claudeThreadId,
              latestTurn: null,
              session: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            },
          ]);

          expect(codexThread).toMatchObject({
            id: codexThreadId,
            title: "Fix the parser",
            modelSelection: modelSelection(CODEX_INSTANCE_ID, "gpt-5.4"),
            runtimeMode: "approval-required",
            latestTurn: null,
            session: null,
            origin: {
              kind: "imported",
              source: "codex-cli",
              sourcePath: codexCanonicalPath,
              nativeSessionId: "codex-session-1",
              providerInstanceId: CODEX_INSTANCE_ID,
            },
          });
          expect(codexThread.origin?.contentHash).toMatch(/^[a-f0-9]{64}$/);
          expect(codexThread.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                text: "Fix the parser",
                turnId: null,
                streaming: false,
              }),
              expect.objectContaining({
                role: "assistant",
                text: "The parser is fixed.",
                turnId: null,
                streaming: false,
              }),
            ]),
          );
          expect(timelineLabels(codexThread)).toEqual([
            "message:user:Fix the parser",
            "activity:task.progress:Inspecting the transcript",
            "activity:tool.completed:exec_command(...)",
            "message:assistant:The parser is fixed.",
            "activity:task.completed:Native codex continuation verified",
          ]);
          expectStrictTimeline(codexThread);

          expect(claudeThread).toMatchObject({
            id: claudeThreadId,
            title: "Importer work",
            modelSelection: modelSelection(CLAUDE_INSTANCE_ID, "claude-sonnet-4-5"),
            runtimeMode: "approval-required",
            latestTurn: null,
            session: null,
            origin: {
              kind: "imported",
              source: "claude-code",
              sourcePath: claudeCanonicalPath,
              nativeSessionId: "123e4567-e89b-12d3-a456-426614174000",
              providerInstanceId: CLAUDE_INSTANCE_ID,
            },
          });
          expect(claudeThread.origin?.contentHash).toMatch(/^[a-f0-9]{64}$/);
          expect(claudeThread.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                text: "Build the importer",
                turnId: null,
                streaming: false,
              }),
              expect.objectContaining({
                role: "assistant",
                text: "The importer is ready.",
                turnId: null,
                streaming: false,
              }),
            ]),
          );
          expect(timelineLabels(claudeThread)).toEqual([
            "message:user:Build the importer",
            "activity:task.progress:Checking the source",
            "activity:tool.completed:Bash: vp test run",
            "message:assistant:The importer is ready.",
            "activity:task.completed:Omitted 4 attachments from imported transcript",
            "activity:task.completed:Native claudeAgent continuation verified",
          ]);
          expectStrictTimeline(claudeThread);

          expect(continuationRequests).toMatchObject([
            {
              threadId: codexThreadId,
              providerInstanceId: CODEX_INSTANCE_ID,
              modelSelection: modelSelection(CODEX_INSTANCE_ID, "gpt-5.4"),
              runtimeMode: "approval-required",
              meta: {
                source: "codex-cli",
                sourcePath: codexCanonicalPath,
                nativeSessionId: "codex-session-1",
                cwd: harness.workspaceDir,
                model: "gpt-5.4",
              },
            },
            {
              threadId: claudeThreadId,
              providerInstanceId: CLAUDE_INSTANCE_ID,
              modelSelection: modelSelection(CLAUDE_INSTANCE_ID, "claude-sonnet-4-5"),
              runtimeMode: "approval-required",
              meta: {
                source: "claude-code",
                sourcePath: claudeCanonicalPath,
                nativeSessionId: "123e4567-e89b-12d3-a456-426614174000",
                cwd: harness.workspaceDir,
                model: "claude-sonnet-4-5",
              },
            },
          ]);
          expect(
            codexThread.activities.find(
              (activity) =>
                typeof activity.payload === "object" &&
                activity.payload !== null &&
                "type" in activity.payload &&
                activity.payload.type === "import.continuation",
            ),
          ).toMatchObject({
            kind: "task.completed",
            summary: "Native codex continuation verified",
            payload: {
              type: "import.continuation",
              driverKind: "codex",
              continuation: {
                state: "verified",
                providerInstanceId: CODEX_INSTANCE_ID,
                reason: null,
              },
            },
          });
          expect(
            claudeThread.activities.find(
              (activity) =>
                typeof activity.payload === "object" &&
                activity.payload !== null &&
                "type" in activity.payload &&
                activity.payload.type === "import.continuation",
            ),
          ).toMatchObject({
            kind: "task.completed",
            summary: "Native claudeAgent continuation verified",
            payload: {
              type: "import.continuation",
              driverKind: "claudeAgent",
              continuation: {
                state: "verified",
                providerInstanceId: CLAUDE_INSTANCE_ID,
                reason: null,
              },
            },
          });
          expect(harness.adapterHarness?.getStartCount()).toBe(0);
          expect(harness.adapterHarness?.listActiveSessionIds()).toEqual([]);

          const firstEvents = Array.from(
            yield* Stream.runCollect(harness.engine.readEvents(0, 1_000)),
          );
          expect(firstEvents).toHaveLength(14);
          expect(firstEvents.filter((event) => event.type === "project.created")).toHaveLength(1);
          expect(firstEvents.filter((event) => event.type === "thread.created")).toHaveLength(2);
          expect(firstEvents.filter((event) => event.type === "thread.message-sent")).toHaveLength(
            4,
          );
          expect(
            firstEvents.filter((event) => event.type === "thread.activity-appended"),
          ).toHaveLength(7);
          expect(
            firstEvents.some(
              (event) =>
                event.type === "thread.turn-start-requested" || event.type === "thread.session-set",
            ),
          ).toBe(false);
          expect(NodeFS.statSync(harness.dbPath).size).toBeGreaterThan(0);

          const secondResult = yield* service.importSessions(request);
          expect(secondResult).toEqual({
            imported: [],
            skipped: [
              {
                sourcePath: codexPath,
                reason: "already imported",
                threadId: codexThreadId,
              },
              {
                sourcePath: claudePath,
                reason: "already imported",
                threadId: claudeThreadId,
              },
            ],
            failed: [],
          });
          expect(continuationRequests.slice(2)).toEqual(continuationRequests.slice(0, 2));

          const replayedEvents = Array.from(
            yield* Stream.runCollect(harness.engine.readEvents(0, 1_000)),
          );
          expect(replayedEvents).toEqual(firstEvents);
          expect(replayedEvents.map((event) => event.sequence)).toEqual(
            replayedEvents.map((event) => event.sequence).toSorted((left, right) => left - right),
          );

          const replayedReadModel = yield* harness.snapshotQuery.getSnapshot();
          expect(
            replayedReadModel.threads.map((thread) => ({
              id: thread.id,
              messageIds: thread.messages.map((message) => message.id),
              activityIds: thread.activities.map((activity) => activity.id),
              origin: thread.origin,
            })),
          ).toEqual(
            readModel.threads.map((thread) => ({
              id: thread.id,
              messageIds: thread.messages.map((message) => message.id),
              activityIds: thread.activities.map((activity) => activity.id),
              origin: thread.origin,
            })),
          );
          expect(harness.adapterHarness?.getStartCount()).toBe(0);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("preserves archive state when a source grows after an archived partial import", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_DRIVER }),
    (harness) =>
      Effect.gen(function* () {
        const nativeSessionId = "batch-retry-native";
        const codexRoot = NodePath.join(harness.rootDir, "imports", "codex");
        const sessionDirectory = NodePath.join(codexRoot, "2026", "01", "01");
        const sourcePath = NodePath.join(
          sessionDirectory,
          `rollout-2026-01-01T00-00-00-${nativeSessionId}.jsonl`,
        );
        NodeFS.mkdirSync(sessionDirectory, { recursive: true });
        NodeFS.writeFileSync(
          sourcePath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 201,
            nativeSessionId,
          }),
        );
        const sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor> = [
          {
            source: "codex-cli",
            driverKind: CODEX_DRIVER,
            providerInstanceId: CODEX_INSTANCE_ID,
            scanRoot: codexRoot,
            continuationIdentity: fileContinuationIdentity(CODEX_DRIVER, codexRoot),
          },
        ];
        const continuationRequests: ContinuationRequest[] = [];
        let importBatchNumber = 0;
        let failSecondBatch = true;
        const dispatch = (command: OrchestrationCommand) => {
          if (command.type === "thread.messages.import") {
            importBatchNumber += 1;
            if (failSecondBatch && importBatchNumber === 2) {
              failSecondBatch = false;
              return Effect.fail(new Error("injected failure after first persisted import batch"));
            }
          }
          return harness.engine.dispatch(command);
        };
        const service = yield* makeService({
          harness,
          sourceDescriptors,
          continuationRequests,
          dispatch,
        });
        const request = {
          items: [
            {
              source: "codex-cli" as const,
              sourcePath,
              providerInstanceId: CODEX_INSTANCE_ID,
            },
          ],
        };

        const firstResult = yield* service.importSessions(request);
        expect(firstResult.imported).toEqual([]);
        expect(firstResult.failed).toEqual([
          expect.objectContaining({
            sourcePath,
            message: expect.stringContaining("injected failure"),
          }),
        ]);
        const partialSnapshot = yield* harness.snapshotQuery.getSnapshot();
        const partialThread = partialSnapshot.threads.find(
          (candidate) =>
            candidate.deletedAt === null && candidate.origin?.nativeSessionId === nativeSessionId,
        );
        expect(partialThread?.messages).toHaveLength(200);
        expect(partialThread && importContinuationActivities(partialThread)).toHaveLength(0);
        yield* harness.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-partial-import-before-growth"),
          threadId: partialThread!.id,
        });

        NodeFS.writeFileSync(
          sourcePath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 202,
            nativeSessionId,
          }),
        );

        const secondResult = yield* service.importSessions(request);
        expect(secondResult.failed).toEqual([]);
        expect(secondResult.skipped).toEqual([]);
        expect(secondResult.imported).toHaveLength(1);
        const threadId = secondResult.imported[0]!.threadId;
        expect(threadId).not.toBe(partialThread?.id);
        expect(secondResult.imported[0]?.continuation).toEqual({
          state: "history-only",
          providerInstanceId: CODEX_INSTANCE_ID,
          continuationIdentity: null,
          reason: "the imported thread remains archived",
        });
        const thread = yield* harness.waitForThread(threadId, (candidate) => {
          const markerCount = candidate.activities.filter(
            (activity) =>
              typeof activity.payload === "object" &&
              activity.payload !== null &&
              "type" in activity.payload &&
              activity.payload.type === "import.continuation",
          ).length;
          return candidate.messages.length === 202 && markerCount === 1;
        });
        expect(thread.messages).toHaveLength(202);
        expect(new Set(thread.messages.map((message) => message.id)).size).toBe(202);
        expect(
          thread.activities.filter(
            (activity) =>
              typeof activity.payload === "object" &&
              activity.payload !== null &&
              "type" in activity.payload &&
              activity.payload.type === "import.continuation",
          ),
        ).toHaveLength(1);
        expect(thread.archivedAt).not.toBeNull();
        const activeShell = yield* harness.snapshotQuery.getShellSnapshot();
        expect(activeShell.threads).toEqual([]);
        const archivedShell = yield* harness.snapshotQuery.getArchivedShellSnapshot();
        expect(archivedShell.threads.map((candidate) => candidate.id)).toEqual([threadId]);
        expect(continuationRequests).toHaveLength(0);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("retries an ambiguously failed final marker with exactly one effective marker", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_DRIVER }),
    (harness) =>
      Effect.gen(function* () {
        const nativeSessionId = "marker-retry-native";
        const codexRoot = NodePath.join(harness.rootDir, "imports", "codex");
        const sessionDirectory = NodePath.join(codexRoot, "2026", "01", "01");
        const sourcePath = NodePath.join(
          sessionDirectory,
          `rollout-2026-01-01T00-00-00-${nativeSessionId}.jsonl`,
        );
        NodeFS.mkdirSync(sessionDirectory, { recursive: true });
        NodeFS.writeFileSync(
          sourcePath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 1,
            nativeSessionId,
          }),
        );
        const sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor> = [
          {
            source: "codex-cli",
            driverKind: CODEX_DRIVER,
            providerInstanceId: CODEX_INSTANCE_ID,
            scanRoot: codexRoot,
            continuationIdentity: fileContinuationIdentity(CODEX_DRIVER, codexRoot),
          },
        ];
        const continuationRequests: ContinuationRequest[] = [];
        let failMarkerResponse = true;
        const dispatch = (command: OrchestrationCommand) => {
          if (command.type !== "thread.activity.append" || !failMarkerResponse) {
            return harness.engine.dispatch(command);
          }
          failMarkerResponse = false;
          return harness.engine
            .dispatch(command)
            .pipe(Effect.andThen(Effect.fail(new Error("injected marker acknowledgement loss"))));
        };
        const service = yield* makeService({
          harness,
          sourceDescriptors,
          continuationRequests,
          dispatch,
        });
        const request = {
          items: [
            {
              source: "codex-cli" as const,
              sourcePath,
              providerInstanceId: CODEX_INSTANCE_ID,
            },
          ],
        };

        const firstResult = yield* service.importSessions(request);
        expect(firstResult.failed[0]?.message).toContain("injected marker acknowledgement loss");
        const secondResult = yield* service.importSessions(request);
        expect(secondResult.failed).toEqual([]);
        const threadId = secondResult.skipped[0]!.threadId!;
        const thread = yield* harness.waitForThread(threadId, (candidate) => {
          const markerCount = candidate.activities.filter(
            (activity) =>
              typeof activity.payload === "object" &&
              activity.payload !== null &&
              "type" in activity.payload &&
              activity.payload.type === "import.continuation",
          ).length;
          return markerCount === 1;
        });
        expect(
          thread.activities.filter(
            (activity) =>
              typeof activity.payload === "object" &&
              activity.payload !== null &&
              "type" in activity.payload &&
              activity.payload.type === "import.continuation",
          ),
        ).toHaveLength(1);
        expect(continuationRequests).toHaveLength(2);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("serializes native identity claims while isolating exact provider choices", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_DRIVER }),
    (harness) =>
      Effect.gen(function* () {
        const codexRoot = NodePath.join(harness.rootDir, "imports", "codex");
        const firstDirectory = NodePath.join(codexRoot, "2026", "01", "01");
        const secondDirectory = NodePath.join(codexRoot, "2026", "01", "02");
        const thirdDirectory = NodePath.join(codexRoot, "2026", "01", "03");
        const fourthDirectory = NodePath.join(codexRoot, "2026", "01", "04");
        const fifthDirectory = NodePath.join(codexRoot, "2026", "01", "05");
        const nativeSessionId = "concurrent-native";
        const sameContentNativeSessionId = "concurrent-same-content";
        const isolatedNativeSessionId = "concurrent-provider-isolated";
        const firstPath = NodePath.join(firstDirectory, `rollout-first-${nativeSessionId}.jsonl`);
        const secondPath = NodePath.join(
          secondDirectory,
          `rollout-second-${nativeSessionId}.jsonl`,
        );
        const sharedPath = NodePath.join(
          thirdDirectory,
          `rollout-shared-${sameContentNativeSessionId}.jsonl`,
        );
        const firstIsolatedPath = NodePath.join(
          fourthDirectory,
          `rollout-first-${isolatedNativeSessionId}.jsonl`,
        );
        const secondIsolatedPath = NodePath.join(
          fifthDirectory,
          `rollout-second-${isolatedNativeSessionId}.jsonl`,
        );
        NodeFS.mkdirSync(firstDirectory, { recursive: true });
        NodeFS.mkdirSync(secondDirectory, { recursive: true });
        NodeFS.mkdirSync(thirdDirectory, { recursive: true });
        NodeFS.mkdirSync(fourthDirectory, { recursive: true });
        NodeFS.mkdirSync(fifthDirectory, { recursive: true });
        NodeFS.writeFileSync(
          firstPath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 1,
            messagePrefix: "first",
            nativeSessionId,
          }),
        );
        NodeFS.writeFileSync(
          secondPath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 2,
            messagePrefix: "second",
            nativeSessionId,
          }),
        );
        NodeFS.writeFileSync(
          sharedPath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 1,
            messagePrefix: "shared",
            nativeSessionId: sameContentNativeSessionId,
          }),
        );
        const isolatedContent = codexRollout({
          cwd: harness.workspaceDir,
          messageCount: 1,
          messagePrefix: "provider-isolated",
          nativeSessionId: isolatedNativeSessionId,
        });
        NodeFS.writeFileSync(firstIsolatedPath, isolatedContent);
        NodeFS.writeFileSync(secondIsolatedPath, isolatedContent);
        const firstInstanceId = ProviderInstanceId.make("codex_first");
        const secondInstanceId = ProviderInstanceId.make("codex_second");
        const sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor> = [
          {
            source: "codex-cli",
            driverKind: CODEX_DRIVER,
            providerInstanceId: firstInstanceId,
            scanRoot: codexRoot,
            continuationIdentity: fileContinuationIdentity(CODEX_DRIVER, codexRoot),
          },
          {
            source: "codex-cli",
            driverKind: CODEX_DRIVER,
            providerInstanceId: secondInstanceId,
            scanRoot: codexRoot,
            continuationIdentity: fileContinuationIdentity(CODEX_DRIVER, codexRoot),
          },
        ];
        const continuationRequests: ContinuationRequest[] = [];
        const resolveTarget: ImportServiceDepsShape["resolveImportTarget"] = (
          _driver,
          requestedInstanceId,
          compatibleInstanceIds,
        ) =>
          Effect.succeed(
            requestedInstanceId !== null && compatibleInstanceIds.includes(requestedInstanceId)
              ? {
                  defaultModelSelection: {
                    instanceId: requestedInstanceId,
                    model: "gpt-default",
                  },
                  availableModels: ["gpt-default"],
                }
              : null,
          );
        const service = yield* makeService({
          harness,
          sourceDescriptors,
          continuationRequests,
          resolveTarget,
        });
        const settleConcurrentImports = (requests: ReadonlyArray<ImportSessionsRequest>) =>
          Effect.gen(function* () {
            const initialResults = yield* Effect.all(
              requests.map((request) => service.importSessions(request)),
              { concurrency: "unbounded" },
            );
            const results = [...initialResults];
            for (const [index, result] of initialResults.entries()) {
              if (
                result.failed.some(
                  (failure) =>
                    failure.message ===
                    "import skipped because another session import is already in progress",
                )
              ) {
                results.push(yield* service.importSessions(requests[index]!));
              }
            }
            return results;
          });

        const sameNativeResults = yield* settleConcurrentImports([
          {
            items: [
              {
                source: "codex-cli",
                sourcePath: firstPath,
                providerInstanceId: firstInstanceId,
              },
            ],
          },
          {
            items: [
              {
                source: "codex-cli",
                sourcePath: secondPath,
                providerInstanceId: firstInstanceId,
              },
            ],
          },
        ]);
        expect(sameNativeResults.flatMap((result) => result.imported)).toHaveLength(1);
        expect(sameNativeResults.flatMap((result) => result.skipped)).toEqual([
          expect.objectContaining({
            reason:
              "already imported; the original session has new activity (delta sync not yet supported)",
          }),
        ]);

        const sameContentResults = yield* settleConcurrentImports([
          {
            items: [
              {
                source: "codex-cli",
                sourcePath: sharedPath,
                providerInstanceId: firstInstanceId,
              },
            ],
          },
          {
            items: [
              {
                source: "codex-cli",
                sourcePath: sharedPath,
                providerInstanceId: secondInstanceId,
              },
            ],
          },
        ]);
        expect(sameContentResults.flatMap((result) => result.imported)).toHaveLength(1);
        expect(sameContentResults.flatMap((result) => result.skipped)).toEqual([
          expect.objectContaining({ reason: "already imported" }),
        ]);

        const isolatedProviderResults = yield* settleConcurrentImports([
          {
            items: [
              {
                source: "codex-cli",
                sourcePath: firstIsolatedPath,
                providerInstanceId: firstInstanceId,
              },
            ],
          },
          {
            items: [
              {
                source: "codex-cli",
                sourcePath: secondIsolatedPath,
                providerInstanceId: secondInstanceId,
              },
            ],
          },
        ]);
        expect(isolatedProviderResults.flatMap((result) => result.imported)).toHaveLength(2);
        expect(isolatedProviderResults.flatMap((result) => result.skipped)).toEqual([]);

        NodeFS.writeFileSync(
          sharedPath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 2,
            messagePrefix: "shared-updated",
            nativeSessionId: sameContentNativeSessionId,
          }),
        );
        const changedBackingFile = yield* service.importSessions({
          items: [
            {
              source: "codex-cli",
              sourcePath: sharedPath,
              providerInstanceId: firstInstanceId,
            },
          ],
        });
        expect(changedBackingFile.imported).toEqual([]);
        expect(changedBackingFile.skipped).toEqual([
          expect.objectContaining({
            reason:
              "already imported; the original session has new activity (delta sync not yet supported)",
          }),
        ]);

        const snapshot = yield* harness.snapshotQuery.getSnapshot();
        const sameNativeThreads = snapshot.threads.filter(
          (thread) =>
            thread.deletedAt === null && thread.origin?.nativeSessionId === nativeSessionId,
        );
        const sameContentThreads = snapshot.threads.filter(
          (thread) =>
            thread.deletedAt === null &&
            thread.origin?.nativeSessionId === sameContentNativeSessionId,
        );
        const isolatedProviderThreads = snapshot.threads.filter(
          (thread) =>
            thread.deletedAt === null && thread.origin?.nativeSessionId === isolatedNativeSessionId,
        );
        expect(sameNativeThreads).toHaveLength(1);
        expect(sameNativeThreads[0]?.origin?.providerInstanceId).toBe(firstInstanceId);
        expect(sameContentThreads).toHaveLength(1);
        expect([firstInstanceId, secondInstanceId]).toContain(
          sameContentThreads[0]?.origin?.providerInstanceId,
        );
        expect(isolatedProviderThreads).toHaveLength(2);
        expect(
          new Set(isolatedProviderThreads.map((thread) => thread.origin?.providerInstanceId)),
        ).toEqual(new Set([firstInstanceId, secondInstanceId]));
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "repairs history-only continuation and preserves verification through a provider outage",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({ provider: CODEX_DRIVER }),
      (harness) =>
        Effect.gen(function* () {
          const nativeSessionId = "continuation-repair-native";
          const codexRoot = NodePath.join(harness.rootDir, "imports", "codex");
          const sessionDirectory = NodePath.join(codexRoot, "2026", "01", "01");
          const sourcePath = NodePath.join(
            sessionDirectory,
            `rollout-2026-01-01T00-00-00-${nativeSessionId}.jsonl`,
          );
          NodeFS.mkdirSync(sessionDirectory, { recursive: true });
          NodeFS.writeFileSync(
            sourcePath,
            codexRollout({
              cwd: harness.workspaceDir,
              messageCount: 1,
              nativeSessionId,
            }),
          );
          const continuationRequests: ContinuationRequest[] = [];
          const fallbackInstanceId = ProviderInstanceId.make("fallback-history-only");
          let targetResolutionAttempt = 0;
          const service = yield* makeService({
            harness,
            sourceDescriptors: [
              {
                source: "codex-cli",
                driverKind: CODEX_DRIVER,
                providerInstanceId: CODEX_INSTANCE_ID,
                scanRoot: codexRoot,
                continuationIdentity: fileContinuationIdentity(CODEX_DRIVER, codexRoot),
              },
            ],
            continuationRequests,
            fallbackModelSelection: {
              instanceId: fallbackInstanceId,
              model: "fallback-model",
            },
            resolveTarget: (_driver, requestedInstanceId, compatibleInstanceIds) =>
              Effect.sync(() => {
                targetResolutionAttempt += 1;
                if (
                  targetResolutionAttempt === 1 ||
                  targetResolutionAttempt === 3 ||
                  requestedInstanceId === null ||
                  !compatibleInstanceIds.includes(requestedInstanceId)
                ) {
                  return null;
                }
                return {
                  defaultModelSelection: {
                    instanceId: requestedInstanceId,
                    model: "gpt-repaired",
                  },
                  availableModels: ["gpt-repaired"],
                };
              }),
          });
          const request = {
            items: [
              {
                source: "codex-cli" as const,
                sourcePath,
                providerInstanceId: CODEX_INSTANCE_ID,
              },
            ],
          };

          const firstResult = yield* service.importSessions(request);
          expect(firstResult.failed).toEqual([]);
          expect(firstResult.imported[0]?.continuation).toEqual({
            state: "history-only",
            providerInstanceId: CODEX_INSTANCE_ID,
            continuationIdentity: null,
            reason: `provider instance '${CODEX_INSTANCE_ID}' is unavailable or does not own this source`,
          });
          const threadId = firstResult.imported[0]!.threadId;
          const historyOnlyThread = yield* harness.waitForThread(
            threadId,
            (thread) => importContinuationActivities(thread).length === 1,
          );
          expect(historyOnlyThread.modelSelection).toEqual({
            instanceId: fallbackInstanceId,
            model: "fallback-model",
          });
          const historyOnlyMarker = importContinuationActivities(historyOnlyThread)[0]!;
          expect(historyOnlyMarker.createdAt).toBe("2026-01-01T00:00:00.001Z");
          expect(historyOnlyMarker.payload).toMatchObject({
            type: "import.continuation",
            continuation: {
              state: "history-only",
              providerInstanceId: CODEX_INSTANCE_ID,
            },
          });

          yield* Effect.sleep("10 millis");
          const repairedResult = yield* service.importSessions(request);
          expect(repairedResult.failed).toEqual([]);
          expect(repairedResult.skipped).toEqual([
            {
              sourcePath,
              reason: "already imported",
              threadId,
            },
          ]);
          const verifiedThread = yield* harness.waitForThread(threadId, (thread) => {
            const markers = importContinuationActivities(thread);
            return (
              markers.length === 1 &&
              typeof markers[0]?.payload === "object" &&
              markers[0]?.payload !== null &&
              "continuation" in markers[0].payload &&
              typeof markers[0].payload.continuation === "object" &&
              markers[0].payload.continuation !== null &&
              "state" in markers[0].payload.continuation &&
              markers[0].payload.continuation.state === "verified"
            );
          });
          const verifiedMarkers = importContinuationActivities(verifiedThread);
          expect(verifiedThread.modelSelection).toEqual({
            instanceId: CODEX_INSTANCE_ID,
            model: "gpt-repaired",
          });
          expect(verifiedMarkers).toHaveLength(1);
          expect(verifiedMarkers[0]?.id).toBe(historyOnlyMarker.id);
          expect(verifiedMarkers[0]?.createdAt).toBe(historyOnlyMarker.createdAt);
          expect(verifiedMarkers[0]?.payload).toMatchObject({
            type: "import.continuation",
            continuation: {
              state: "verified",
              providerInstanceId: CODEX_INSTANCE_ID,
              reason: null,
            },
          });

          yield* Effect.sleep("10 millis");
          const outageResult = yield* service.importSessions(request);
          expect(outageResult.failed).toEqual([]);
          expect(outageResult.skipped).toEqual([
            {
              sourcePath,
              reason: "already imported",
              threadId,
            },
          ]);
          const outageThread = yield* harness.waitForThread(threadId, (thread) => {
            const markers = importContinuationActivities(thread);
            return markers.length === 1 && markers[0]?.id === historyOnlyMarker.id;
          });
          expect(outageThread.modelSelection).toEqual({
            instanceId: CODEX_INSTANCE_ID,
            model: "gpt-repaired",
          });
          expect(importContinuationActivities(outageThread)).toEqual([
            expect.objectContaining({
              id: historyOnlyMarker.id,
              createdAt: historyOnlyMarker.createdAt,
              payload: expect.objectContaining({
                type: "import.continuation",
                continuation: expect.objectContaining({
                  state: "verified",
                  providerInstanceId: CODEX_INSTANCE_ID,
                  reason: null,
                }),
              }),
            }),
          ]);
          expect(continuationRequests).toHaveLength(2);

          yield* harness.dispose;
          // a same-process second reactor is not a separate app process, so this
          // focused restart reopens the persisted runtime for bounded readback
          const restartedHarness = yield* makeOrchestrationIntegrationHarness({
            provider: CODEX_DRIVER,
            rootDir: harness.rootDir,
            startReactor: false,
          });
          const restartedSnapshot = yield* restartedHarness.snapshotQuery
            .getSnapshot()
            .pipe(Effect.timeoutOption("2 seconds"));
          expect(Option.isSome(restartedSnapshot)).toBe(true);
          if (Option.isSome(restartedSnapshot)) {
            const restartedThread = restartedSnapshot.value.threads.find(
              (thread) => thread.id === threadId,
            );
            expect(restartedThread).toBeDefined();
            expect(restartedThread?.modelSelection).toEqual({
              instanceId: CODEX_INSTANCE_ID,
              model: "gpt-repaired",
            });
            const restartedMarkers =
              restartedThread === undefined ? [] : importContinuationActivities(restartedThread);
            expect(restartedMarkers).toHaveLength(1);
            expect(restartedMarkers[0]?.id).toBe(historyOnlyMarker.id);
            expect(restartedMarkers[0]?.payload).toMatchObject({
              type: "import.continuation",
              continuation: {
                state: "verified",
                providerInstanceId: CODEX_INSTANCE_ID,
                reason: null,
              },
            });
          }
          const restartedCommandReadModel = yield* restartedHarness.snapshotQuery
            .getCommandReadModel()
            .pipe(Effect.timeoutOption("2 seconds"));
          expect(Option.isSome(restartedCommandReadModel)).toBe(true);
          if (Option.isSome(restartedCommandReadModel)) {
            const restartedCommandThread = restartedCommandReadModel.value.threads.find(
              (thread) => thread.id === threadId,
            );
            expect(
              restartedCommandThread && importContinuationActivities(restartedCommandThread),
            ).toEqual([
              expect.objectContaining({
                id: historyOnlyMarker.id,
                payload: expect.objectContaining({
                  type: "import.continuation",
                  continuation: expect.objectContaining({
                    state: "verified",
                    providerInstanceId: CODEX_INSTANCE_ID,
                    reason: null,
                  }),
                }),
              }),
            ]);
          }
          const postRestartImportFailure = yield* Effect.flip(
            restartedHarness.engine.dispatch({
              type: "thread.messages.import",
              commandId: CommandId.make("post-restart-import-must-remain-finalized"),
              threadId,
              messages: [
                {
                  messageId: MessageId.make("post-restart-import-message"),
                  role: "user",
                  text: "must not append after restart",
                  createdAt: "2026-01-01T00:00:01.000Z",
                },
              ],
              activities: [],
              createdAt: "2026-01-01T00:00:01.000Z",
            }),
          );
          expect(postRestartImportFailure.message).toContain("has finalized its import");
          const restartedDisposed = yield* restartedHarness.dispose.pipe(
            Effect.timeoutOption("2 seconds"),
          );
          expect(Option.isSome(restartedDisposed)).toBe(true);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("recreates active project and thread generations after forced deletion", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_DRIVER }),
    (harness) =>
      Effect.gen(function* () {
        const nativeSessionId = "delete-reimport-native";
        const codexRoot = NodePath.join(harness.rootDir, "imports", "codex");
        const sessionDirectory = NodePath.join(codexRoot, "2026", "01", "01");
        const sourcePath = NodePath.join(
          sessionDirectory,
          `rollout-2026-01-01T00-00-00-${nativeSessionId}.jsonl`,
        );
        NodeFS.mkdirSync(sessionDirectory, { recursive: true });
        NodeFS.writeFileSync(
          sourcePath,
          codexRollout({
            cwd: harness.workspaceDir,
            messageCount: 1,
            nativeSessionId,
          }),
        );
        const sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor> = [
          {
            source: "codex-cli",
            driverKind: CODEX_DRIVER,
            providerInstanceId: CODEX_INSTANCE_ID,
            scanRoot: codexRoot,
            continuationIdentity: fileContinuationIdentity(CODEX_DRIVER, codexRoot),
          },
        ];
        const continuationRequests: ContinuationRequest[] = [];
        const service = yield* makeService({
          harness,
          sourceDescriptors,
          continuationRequests,
        });
        const request = {
          items: [
            {
              source: "codex-cli" as const,
              sourcePath,
              providerInstanceId: CODEX_INSTANCE_ID,
            },
          ],
        };

        const firstResult = yield* service.importSessions(request);
        const firstImport = firstResult.imported[0]!;
        yield* harness.engine.dispatch({
          type: "project.delete",
          commandId: CommandId.make("delete-imported-project"),
          projectId: firstImport.projectId,
          force: true,
        });

        const secondResult = yield* service.importSessions(request);
        expect(secondResult.failed).toEqual([]);
        expect(secondResult.imported).toHaveLength(1);
        const secondImport = secondResult.imported[0]!;
        expect(secondImport.projectId).not.toBe(firstImport.projectId);
        expect(secondImport.threadId).not.toBe(firstImport.threadId);
        const shell = yield* harness.snapshotQuery.getShellSnapshot();
        expect(shell.projects.map((project) => project.id)).toEqual([secondImport.projectId]);
        expect(shell.threads.map((thread) => thread.id)).toEqual([secondImport.threadId]);
        expect(shell.threads[0]?.projectId).toBe(shell.projects[0]?.id);
        const snapshot = yield* harness.snapshotQuery.getSnapshot();
        const recreatedThread = snapshot.threads.find(
          (thread) => thread.id === secondImport.threadId && thread.deletedAt === null,
        );
        expect(recreatedThread?.messages).toEqual([
          expect.objectContaining({
            role: "user",
            text: "message 0",
            turnId: null,
            streaming: false,
          }),
        ]);
        expect(recreatedThread && importContinuationActivities(recreatedThread)).toEqual([
          expect.objectContaining({
            kind: "task.completed",
            payload: expect.objectContaining({
              type: "import.continuation",
              continuation: expect.objectContaining({
                state: "verified",
                providerInstanceId: CODEX_INSTANCE_ID,
              }),
            }),
          }),
        ]);

        yield* harness.dispose;
        // reopen the persisted runtime without a second same-process reactor;
        // full process restart remains part of integrated app verification
        const restartedHarness = yield* makeOrchestrationIntegrationHarness({
          provider: CODEX_DRIVER,
          rootDir: harness.rootDir,
          startReactor: false,
        });
        const restartedSnapshot = yield* restartedHarness.snapshotQuery
          .getSnapshot()
          .pipe(Effect.timeoutOption("2 seconds"));
        expect(Option.isSome(restartedSnapshot)).toBe(true);
        if (Option.isSome(restartedSnapshot)) {
          const restartedThread = restartedSnapshot.value.threads.find(
            (thread) => thread.id === secondImport.threadId && thread.deletedAt === null,
          );
          expect(restartedThread?.messages).toEqual([
            expect.objectContaining({
              role: "user",
              text: "message 0",
              turnId: null,
              streaming: false,
            }),
          ]);
          expect(restartedThread && importContinuationActivities(restartedThread)).toHaveLength(1);
          expect(
            restartedThread && importContinuationActivities(restartedThread)[0]?.payload,
          ).toMatchObject({
            type: "import.continuation",
            continuation: {
              state: "verified",
              providerInstanceId: CODEX_INSTANCE_ID,
              reason: null,
            },
          });
        }
        const restartedShell = yield* restartedHarness.snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.timeoutOption("2 seconds"));
        expect(Option.isSome(restartedShell)).toBe(true);
        if (Option.isNone(restartedShell)) {
          return;
        }
        const restartedShellValue = restartedShell.value;
        expect(restartedShellValue.projects.map((project) => project.id)).toEqual([
          secondImport.projectId,
        ]);
        expect(restartedShellValue.threads.map((thread) => thread.id)).toEqual([
          secondImport.threadId,
        ]);
        const restartedDisposed = yield* restartedHarness.dispose.pipe(
          Effect.timeoutOption("2 seconds"),
        );
        expect(Option.isSome(restartedDisposed)).toBe(true);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);
